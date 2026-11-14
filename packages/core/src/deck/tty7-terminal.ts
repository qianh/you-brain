import { createConnection, Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface TerminalSize {
  cols: number;
  rows: number;
  cell_w: number;
  cell_h: number;
}

export interface Tty7TerminalEvents {
  ready(): void;
  output(bytes: Uint8Array): void;
  size(size: TerminalSize): void;
  lease(by: string | null): void;
  warning(message: string): void;
  exit(code: number | null): void;
  error(message: string): void;
  close(): void;
}

export interface TerminalConnection {
  input(bytes: Uint8Array): void;
  resize(size: TerminalSize): void;
  pause(): void;
  resume(): void;
  close(): void;
}

const MAX_FRAME = 64 * 1024 * 1024;
const MAX_INPUT = 1024 * 1024;
const TIMEOUT_MS = 8_000;

/** tty7 26.10 的协议 6：长度不含 kind，二进制终端数据绝不先转成字符串。 */
export function terminalFrame(kind: number, payload: Uint8Array = new Uint8Array()): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  frame[4] = kind;
  frame.set(payload, 5);
  return frame;
}

function jsonFrame(kind: number, value: unknown): Buffer {
  return terminalFrame(kind, Buffer.from(JSON.stringify(value)));
}

/** 同时处理半帧和同一 socket chunk 内的多帧。 */
export class TerminalFrames {
  #buffer: Buffer = Buffer.alloc(0);

  push(bytes: Uint8Array, receive: (kind: number, payload: Buffer) => void): void {
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.#buffer, bytes]);
    while (this.#buffer.length >= 5) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_FRAME) throw new Error("tty7 终端数据帧过大");
      if (this.#buffer.length < length + 5) return;
      const kind = this.#buffer[4]!;
      const payload = this.#buffer.subarray(5, length + 5);
      this.#buffer = this.#buffer.subarray(length + 5);
      receive(kind, payload);
    }
  }
}

export function tty7SocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const directory = env.TTY7_CONFIG_DIR || join(homedir(), ".config", "tty7");
  const inline = join(directory, "daemon.sock");
  if (Buffer.byteLength(inline) <= 100) return inline;
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(directory)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  const name = `tty7-${hash.toString(16).padStart(16, "0")}.sock`;
  const preferred = join(env.XDG_RUNTIME_DIR || tmpdir(), name);
  return Buffer.byteLength(preferred) <= 100 ? preferred : join(tmpdir(), name);
}

export function validTerminalSize(value: unknown): value is TerminalSize {
  if (!value || typeof value !== "object") return false;
  const size = value as TerminalSize;
  return Number.isInteger(size.cols) && size.cols >= 2 && size.cols <= 1000 &&
    Number.isInteger(size.rows) && size.rows >= 1 && size.rows <= 1000 &&
    Number.isInteger(size.cell_w) && size.cell_w >= 0 && size.cell_w <= 256 &&
    Number.isInteger(size.cell_h) && size.cell_h >= 0 && size.cell_h <= 256;
}

/**
 * Observe 保留原控制端；size lease 只在此连接存活时借用尺寸。
 * 输入走 SendInput 的短 socket 请求，按 ACK 排序，不起 CLI 子进程、不做按键白名单。
 */
export function openTty7Terminal(options: {
  pane: number;
  size: TerminalSize;
  events: Tty7TerminalEvents;
  env?: NodeJS.ProcessEnv | undefined;
  socketPath?: string;
}): TerminalConnection {
  if (!Number.isSafeInteger(options.pane) || options.pane < 0) throw new Error("会话编号不正确");
  if (!validTerminalSize(options.size)) throw new Error("终端尺寸不正确");
  const path = options.socketPath ?? tty7SocketPath(options.env);
  const { events, pane } = options;
  let size = options.size;
  let closed = false;
  let ready = false;
  let warned = false;
  let writing = false;
  let writer: Socket | undefined;
  let queue: Buffer[] = [];
  let pending = 0;
  const frames = new TerminalFrames();
  const observer = new Socket();
  const versionSocket = createConnection(path);
  let versionAccepted = false;
  const handshake = setTimeout(() => fail("连接 tty7 终端超时"), TIMEOUT_MS);

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(handshake);
    queue = [];
    writer?.destroy();
    versionSocket.destroy();
    // 断开 observer 会自动释放 lease；从不向原会话发送 Kill 或退出按键。
    observer.destroy();
    events.close();
  };
  const fail = (message: string): void => {
    if (closed) return;
    events.error(message);
    close();
  };
  const flush = (): void => {
    if (closed || !ready || writing || queue.length === 0) return;
    const bytes = Buffer.concat(queue);
    queue = [];
    writing = true;
    const socket = createConnection(path);
    writer = socket;
    let acknowledged = false;
    const replies = new TerminalFrames();
    socket.setTimeout(TIMEOUT_MS, () => fail("tty7 输入未确认，请检查原会话；未自动重发"));
    socket.on("connect", () => socket.write(jsonFrame(55, [pane, [...bytes]])));
    socket.on("data", (chunk: Buffer) => {
      try {
        replies.push(chunk, (kind, payload) => {
          if (kind === 51 && JSON.parse(payload.toString()) === pane) {
            acknowledged = true;
            pending -= bytes.length;
            writing = false;
            socket.end();
            if (writer === socket) writer = undefined;
            flush();
          } else if (kind === 8) fail("tty7 拒绝输入，请检查原会话");
        });
      } catch { fail("tty7 输入应答无效"); }
    });
    socket.on("error", () => fail("tty7 输入连接中断；未自动重发"));
    socket.on("close", () => {
      if (!acknowledged) fail("tty7 输入连接中断；未自动重发");
    });
  };

  // Version 是独立的一次性请求；服务端答复后会关闭该连接。
  const versionFrames = new TerminalFrames();
  versionSocket.on("connect", () => versionSocket.write(terminalFrame(40)));
  versionSocket.on("data", (bytes: Buffer) => {
    try {
      versionFrames.push(bytes, (kind, payload) => {
        if (closed || versionAccepted) return;
        if (kind !== 40) throw new Error("tty7 未返回协议版本");
        const version = JSON.parse(payload.toString()) as { protocol: number; features?: string[] };
        if (version.protocol !== 6 || !version.features?.includes("size-lease")) {
          throw new Error("此 tty7 版本不支持共享终端连接，请使用兼容协议 6 和 size-lease 的版本");
        }
        versionAccepted = true;
        versionSocket.end();
        observer.connect(path);
      });
    } catch (error) { fail(error instanceof Error ? error.message : "tty7 终端协议无效"); }
  });
  versionSocket.on("error", () => fail("无法连接 tty7 终端服务，请确认 tty7 正在运行"));
  versionSocket.on("close", () => { if (!versionAccepted) fail("tty7 未返回协议版本"); });
  observer.on("connect", () => {
    if (closed) return;
    clearTimeout(handshake);
    observer.write(jsonFrame(54, [pane, size]));
    observer.write(jsonFrame(57, { take: { size, by: "U-Brain" } }));
    ready = true;
    events.ready();
    flush();
  });
  observer.on("data", (bytes: Buffer) => {
    try {
      frames.push(bytes, (kind, payload) => {
        if (closed) return;
        if (kind === 2 || kind === 3) events.output(payload);
        else if (kind === 9) {
          const next: unknown = JSON.parse(payload.toString());
          if (validTerminalSize(next)) events.size(next);
        } else if (kind === 63) {
          const by: unknown = JSON.parse(payload.toString());
          if (by === null || typeof by === "string") events.lease(by);
        } else if (kind === 6) {
          const code: unknown = JSON.parse(payload.toString());
          events.exit(typeof code === "number" ? code : null);
          close();
        } else if (kind === 8) fail("tty7 无法打开此终端会话，或尺寸控制已被拒绝");
        else if ((kind === 60 || kind === 61 || kind === 62) && !warned) {
          warned = true;
          events.warning("此会话使用了 tty7 专属图像或剪贴板协议，该内容请在 tty7 原窗口查看。");
        }
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : "tty7 终端协议无效");
    }
  });
  observer.on("error", () => fail("无法连接 tty7 终端服务，请确认 tty7 正在运行"));
  observer.on("close", close);

  return {
    input(bytes) {
      if (closed || bytes.length === 0) return;
      pending += bytes.length;
      if (pending > MAX_INPUT) return fail("终端输入积压，连接已断开；未自动重发");
      queue.push(Buffer.from(bytes));
      flush();
    },
    resize(next) {
      if (closed || !validTerminalSize(next)) return;
      size = next;
      if (ready) observer.write(jsonFrame(57, { take: { size, by: "U-Brain" } }));
    },
    pause: () => { observer.pause(); },
    resume: () => { observer.resume(); },
    close,
  };
}
