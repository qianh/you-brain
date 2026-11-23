import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/**
 * 设备间 T3 隧道的密码学部分（协议文档 §9）。
 *
 * - 握手：发起方在签名指令 `t3.tunnel.open` 里带 X25519 临时公钥；目标方回自己的临时公钥，
 *   并用设备身份（Ed25519）对整段握手记录签名，发起方验签后才信任。
 * - 通道：HKDF(ECDH 共享密钥, salt = 会话 id) 派生两个方向各一把 AES-256-GCM 密钥；
 *   每个方向有单调递增的计数器，计数器就是 nonce，也是接收端的顺序与重放依据。
 * - 中转只看到会话 id、对端与密文长度，看不到内容，也无法伪造或重放帧。
 */
export const TUNNEL_OPEN_KIND = "t3.tunnel.open";
export const TUNNEL_CLOSE_KIND = "t3.tunnel.close";
/**
 * 单个隧道帧里正文字节数的上限。正文先 base64 进 JSON，整条消息加密后再 base64url，
 * 两次 4/3 膨胀（64 KB → 约 117 KB），要小于中转的帧上限（160 KB）；超限的帧会被中转丢弃，
 * 接收端按计数器保序，会永远等那一帧，整条隧道卡死。
 */
export const TUNNEL_CHUNK_BYTES = 64 * 1024;
/** 中转对单个隧道帧（密文 base64url）的长度上限，与 services/telegram-relay 的 TUN_FRAME_MAX_BYTES 一致。 */
export const TUNNEL_RELAY_FRAME_MAX = 160 * 1024;

// 不能在模块顶层调用 Buffer：Web 打包会引入本文件，浏览器里没有 Buffer，顶层副作用会让整页崩溃。
const X25519_SPKI_PREFIX_HEX = "302a300506032b656e032100";
const INFO_TEXT = "u-brain-t3-tunnel/1";
const TAG_BYTES = 16;

export interface TunnelEphemeral {
  /** X25519 原始公钥（32 字节），base64url。 */
  publicKey: string;
  privateKey: KeyObject;
}

export function newTunnelEphemeral(): TunnelEphemeral {
  const pair = generateKeyPairSync("x25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return { publicKey: Buffer.from(der.subarray(der.length - 32)).toString("base64url"), privateKey: pair.privateKey };
}

function importX25519Public(raw: string): KeyObject {
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) throw new Error("无效的临时公钥");
  return createPublicKey({ key: Buffer.concat([Buffer.from(X25519_SPKI_PREFIX_HEX, "hex"), bytes]), format: "der", type: "spki" });
}

/** 握手记录：双方设备、会话 id 与两把临时公钥都在里面，任何一项被改动签名都会失效。 */
export function tunnelTranscript(input: { sid: string; initiator: string; responder: string; initiatorKey: string; responderKey: string }): string {
  return ["u-brain-tunnel/1", input.sid, input.initiator, input.responder, input.initiatorKey, input.responderKey].join("\n");
}

export function signTunnelTranscript(privateKey: string, transcript: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64url"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(transcript, "utf8"), key).toString("base64url");
}

export function verifyTunnelTranscript(publicKey: string, transcript: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    return verify(null, Buffer.from(transcript, "utf8"), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** 单向加解密状态。`seal` 的计数器自增；`open` 只解密并返回帧里的计数器，顺序由调用方负责。 */
export class TunnelCipher {
  readonly #sendKey: Buffer;
  readonly #recvKey: Buffer;
  #counter = 0;

  constructor(sendKey: Buffer, recvKey: Buffer) {
    this.#sendKey = sendKey;
    this.#recvKey = recvKey;
  }

  /** 输出 base64url(计数器 8 字节 ‖ 密文 ‖ 16 字节标签)。 */
  seal(plaintext: Uint8Array): string {
    const counter = this.#counter++;
    const header = Buffer.alloc(8);
    header.writeBigUInt64BE(BigInt(counter));
    const cipher = createCipheriv("aes-256-gcm", this.#sendKey, nonceOf(header));
    cipher.setAAD(header);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, body, cipher.getAuthTag()]).toString("base64url");
  }

  /** 解密失败（被改动、密钥不对）抛错。 */
  open(data: string): { counter: number; plaintext: Buffer } {
    const bytes = Buffer.from(data, "base64url");
    if (bytes.length < 8 + TAG_BYTES) throw new Error("隧道帧太短");
    const header = bytes.subarray(0, 8);
    const decipher = createDecipheriv("aes-256-gcm", this.#recvKey, nonceOf(header));
    decipher.setAAD(header);
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(8, bytes.length - TAG_BYTES)), decipher.final()]);
    return { counter: Number(header.readBigUInt64BE()), plaintext };
  }
}

function nonceOf(header: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(4), header]);
}

/** 发起方的发送密钥 = 目标方的接收密钥，反之亦然。 */
export function deriveTunnelCipher(input: {
  privateKey: KeyObject;
  peerPublicKey: string;
  sid: string;
  role: "initiator" | "responder";
}): TunnelCipher {
  const shared = diffieHellman({ privateKey: input.privateKey, publicKey: importX25519Public(input.peerPublicKey) });
  const keys = Buffer.from(hkdfSync("sha256", shared, Buffer.from(input.sid, "utf8"), Buffer.from(INFO_TEXT, "utf8"), 64));
  const forward = keys.subarray(0, 32);
  const backward = keys.subarray(32, 64);
  return input.role === "initiator" ? new TunnelCipher(forward, backward) : new TunnelCipher(backward, forward);
}

/** 隧道内层请求的目标服务：缺省为本机 T3；"tty7" 路由到本机 daemon 的 tty7 终端会话桥。 */
export type TunnelTarget = "t3" | "tty7";

/** 隧道里的内层消息（加密后才上线）。请求与响应用 `id` 配对；每个 HTTP/WebSocket 流各有一个 `id`。 */
export type TunnelMessage =
  | { k: "req"; id: string; method: string; path: string; headers: Array<[string, string]>; body?: string; end: boolean; target?: TunnelTarget }
  | { k: "body"; id: string; body: string; end: boolean }
  | { k: "head"; id: string; status: number; statusText: string; headers: Array<[string, string]>; enc?: "gzip" }
  | { k: "chunk"; id: string; body: string; end: boolean }
  | { k: "err"; id: string; message: string }
  | { k: "ws-open"; id: string; path: string; headers: Array<[string, string]>; target?: TunnelTarget }
  | { k: "ws-ok"; id: string }
  | { k: "ws-msg"; id: string; text?: string; body?: string }
  | { k: "ws-close"; id: string; code: number; reason: string }
  | { k: "pair"; id: string }
  | { k: "pair-res"; id: string; credential: string | null }
  | { k: "bye" };

const MESSAGE_KINDS = new Set(["req", "body", "head", "chunk", "err", "ws-open", "ws-ok", "ws-msg", "ws-close", "pair", "pair-res", "bye"]);

export function encodeTunnelMessage(message: TunnelMessage): Buffer {
  return Buffer.from(JSON.stringify(message), "utf8");
}

/** 解析并只做形状检查（对象、已知的 k、id 为字符串）；字段细节由使用方各自校验。 */
export function decodeTunnelMessage(bytes: Uint8Array): TunnelMessage {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("隧道消息格式不对");
  const record = value as Record<string, unknown>;
  if (typeof record.k !== "string" || !MESSAGE_KINDS.has(record.k)) throw new Error("隧道消息类型不认识");
  if (record.k !== "bye" && typeof record.id !== "string") throw new Error("隧道消息缺少 id");
  return value as TunnelMessage;
}
