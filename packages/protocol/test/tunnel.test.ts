import { describe, expect, it } from "bun:test";

import {
  decodeTunnelMessage,
  type TunnelMessage,
  deriveTunnelCipher,
  encodeTunnelMessage,
  generateKeyPair,
  newTunnelEphemeral,
  signTunnelTranscript,
  TUNNEL_CHUNK_BYTES,
  TUNNEL_RELAY_FRAME_MAX,
  tunnelTranscript,
  verifyTunnelTranscript,
} from "../src/index.js";

function pair(sid = "s1") {
  const a = newTunnelEphemeral();
  const b = newTunnelEphemeral();
  return {
    a,
    b,
    client: deriveTunnelCipher({ privateKey: a.privateKey, peerPublicKey: b.publicKey, sid, role: "initiator" }),
    server: deriveTunnelCipher({ privateKey: b.privateKey, peerPublicKey: a.publicKey, sid, role: "responder" }),
  };
}

describe("隧道加密", () => {
  it("两个方向各用各的密钥，能互相解密，计数器递增", () => {
    const { client, server } = pair();
    const first = client.seal(Buffer.from("你好"));
    const second = client.seal(Buffer.from("again"));
    expect(server.open(first)).toEqual({ counter: 0, plaintext: Buffer.from("你好") });
    expect(server.open(second).counter).toBe(1);
    const back = server.seal(Buffer.from("pong"));
    expect(client.open(back).plaintext.toString()).toBe("pong");
    // 自己发出去的帧不能当对方的帧解开（方向密钥不同）。
    expect(() => client.open(first)).toThrow();
  });

  it("满块正文封装后仍小于中转的帧上限（超限帧会被中转丢弃，隧道随之卡死）", () => {
    const { client } = pair();
    const message = encodeTunnelMessage({ k: "chunk", id: "1", body: Buffer.alloc(TUNNEL_CHUNK_BYTES, 255).toString("base64"), end: false });
    expect(client.seal(message).length).toBeLessThan(TUNNEL_RELAY_FRAME_MAX);
  });

  it("密文被改一个字节、会话 id 不同、换了密钥都解不开", () => {
    const { client, server } = pair("s1");
    const frame = client.seal(Buffer.from("secret"));
    const bytes = Buffer.from(frame, "base64url");
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 1;
    expect(() => server.open(bytes.toString("base64url"))).toThrow();
    const other = pair("s1").server;
    expect(() => other.open(frame)).toThrow();
    const a = newTunnelEphemeral();
    const b = newTunnelEphemeral();
    const x = deriveTunnelCipher({ privateKey: a.privateKey, peerPublicKey: b.publicKey, sid: "s1", role: "initiator" });
    const y = deriveTunnelCipher({ privateKey: b.privateKey, peerPublicKey: a.publicKey, sid: "s2", role: "responder" });
    expect(() => y.open(x.seal(Buffer.from("x")))).toThrow();
  });

  it("握手记录签名：改任何一项都验不过", () => {
    const identity = generateKeyPair();
    const record = { sid: "s1", initiator: "A", responder: "B", initiatorKey: "ka", responderKey: "kb" };
    const sig = signTunnelTranscript(identity.privateKey, tunnelTranscript(record));
    expect(verifyTunnelTranscript(identity.publicKey, tunnelTranscript(record), sig)).toBe(true);
    for (const key of Object.keys(record) as Array<keyof typeof record>) {
      expect(verifyTunnelTranscript(identity.publicKey, tunnelTranscript({ ...record, [key]: "x" }), sig)).toBe(false);
    }
    expect(verifyTunnelTranscript(generateKeyPair().publicKey, tunnelTranscript(record), sig)).toBe(false);
  });

  it("内层消息编码解码；未知类型、缺 id 被拒", () => {
    const message: TunnelMessage = { k: "req", id: "1", method: "GET", path: "/", headers: [["a", "b"]], end: true };
    expect(decodeTunnelMessage(encodeTunnelMessage(message))).toEqual(message);
    expect(decodeTunnelMessage(encodeTunnelMessage({ k: "bye" }))).toEqual({ k: "bye" });
    expect(() => decodeTunnelMessage(Buffer.from('{"k":"nope","id":"1"}'))).toThrow();
    expect(() => decodeTunnelMessage(Buffer.from('{"k":"req"}'))).toThrow();
    expect(() => decodeTunnelMessage(Buffer.from("[]"))).toThrow();
  });
});
