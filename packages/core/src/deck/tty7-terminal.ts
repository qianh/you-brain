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
  /**
   * 连接时的历史回放（帧 2）已经结束，此后是实时输出（帧 3）。在第一帧实时输出之前触发一次。
   * 回放里有程序当初发出的终端查询（DA、CPR、OSC 颜色等），浏览器要据此不再回答它们。
   */
  live(): void;
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
/** 小于此阈值的回放原样透传，不做任何裁剪。 */
const REPLAY_PASSTHROUGH_BYTES = 64 * 1024;
/** 客户端可指定的最小回放裁剪上限（避免过小丢失当前屏幕）。 */
const MIN_REPLAY_BYTES = 16 * 1024;
/** 单次历史回放的最大保留字节数（普通缓冲滚回或无清屏的大体积屏显）。 */
const MAX_REPLAY_BYTES = 512 * 1024;
/** 备用屏会话前最多保留的主屏尾部上下文（退出 TUI 时仍能看到之前的终端提示符）。 */
const ALT_NORMAL_CONTEXT_BYTES = 64 * 1024;
/** 本地 socket 连续回放帧（kind=2）的聚合静默窗口；收到 lease(63) 或 live(3) 时立即刷出。 */
const REPLAY_COALESCE_MS = 12;

const TRACKED_DEC_MODES = [1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004, 25] as const;

function alignSafeUtf8Start(buf: Buffer, start: number): number {
  let idx = Math.max(0, Math.min(buf.length, start));
  // 跳过 UTF-8 续字节（10xxxxxx）。
  while (idx < buf.length && (buf[idx]! & 0xc0) === 0x80) idx += 1;
  // 若正好落在 ESC 序列内部（前 32 字节内有未闭合的 ESC [），向前跳过当前参数串避免半截控制码乱码。
  const lookback = Math.max(0, idx - 32);
  for (let scan = idx - 1; scan >= lookback; scan -= 1) {
    if (buf[scan] === 0x1b) {
      if (scan + 1 < buf.length && buf[scan + 1] === 0x5b) {
        let end = scan + 2;
        while (end < buf.length && buf[end]! >= 0x20 && buf[end]! <= 0x3f) end += 1;
        if (end < buf.length && buf[end]! >= 0x40 && buf[end]! <= 0x7e && end >= idx) {
          idx = end + 1;
        }
      }
      break;
    }
  }
  return idx;
}

function sliceTailFromLine(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  const target = buf.length - maxBytes;
  const searchEnd = Math.min(buf.length, target + 4096);
  for (let i = target; i < searchEnd; i += 1) {
    if (buf[i] === 0x0a) return buf.subarray(i + 1);
  }
  return buf.subarray(alignSafeUtf8Start(buf, target));
}

interface ReplayScan {
  inAltScreen: boolean;
  altMode: number;
  lastAltEnter: number;
  lastEraseAll: number;
  modesAtCut: Map<number, boolean>;
}

function scanReplayBuffer(buf: Buffer, cutLimit?: number): ReplayScan {
  let inAltScreen = false;
  let altMode = 1049;
  let lastAltEnter = -1;
  let lastEraseAll = -1;
  const modes = new Map<number, boolean>();
  const limit = cutLimit ?? buf.length;

  for (let i = 0; i + 2 < limit; i += 1) {
    if (buf[i] !== 0x1b || buf[i + 1] !== 0x5b) continue;
    let p = i + 2;
    while (p < limit && buf[p]! >= 0x30 && buf[p]! <= 0x3f) p += 1;
    let q = p;
    while (q < limit && buf[q]! >= 0x20 && buf[q]! <= 0x2f) q += 1;
    if (q >= limit) break;
    const finalByte = buf[q]!;
    if (finalByte < 0x40 || finalByte > 0x7e) continue;

    if (q === p) {
      const prefix = buf[i + 2];
      if (prefix === 0x3f && (finalByte === 0x68 || finalByte === 0x6c)) {
        // CSI ? Pm h / l
        const enabled = finalByte === 0x68;
        const params = buf.toString("ascii", i + 3, p);
        for (const part of params.split(";")) {
          const code = Number(part);
          if (code === 1049 || code === 1047 || code === 47) {
            if (enabled) {
              inAltScreen = true;
              altMode = code;
              lastAltEnter = i;
              lastEraseAll = -1;
            } else {
              inAltScreen = false;
            }
          } else if ((TRACKED_DEC_MODES as readonly number[]).includes(code)) {
            modes.set(code, enabled);
          }
        }
      } else if (finalByte === 0x4a && inAltScreen) {
        // CSI Ps J（备用屏整屏擦除 2J / 3J）
        const param = buf.toString("ascii", i + 2, p);
        if (param === "2" || param === "3") {
          lastEraseAll = i;
        }
      }
    }
    i = q;
  }

  return { inAltScreen, altMode, lastAltEnter, lastEraseAll, modesAtCut: modes };
}

function buildActiveDecModes(modes: ReadonlyMap<number, boolean>, includeAltMode?: number): Buffer {
  const parts: string[] = [];
  if (includeAltMode !== undefined) parts.push(`\x1b[?${includeAltMode}h`);
  for (const code of TRACKED_DEC_MODES) {
    const state = modes.get(code);
    if (code === 25) {
      if (state === false) parts.push("\x1b[?25l");
    } else if (state === true) {
      parts.push(`\x1b[?${code}h`);
    }
  }
  return Buffer.from(parts.join(""), "ascii");
}

/**
 * 裁剪过长的连接初始回放（帧 2）：
 * 1. <= 64 KB 的回放原样保留；
 * 2. 若当前处于备用屏（TUI 会话如 Claude / Codex / Grok 无滚回缓冲），丢弃最后一次整屏清屏 `\x1b[2J` 之前已被擦除的数 MB 历史重绘，
 *    仅保留必要的终端私有模式（备用屏、焦点上报、括号粘贴、鼠标、光标显隐）与最后一屏有效输出；
 * 3. 普通滚回缓冲超出 512 KB 时按换行/UTF-8 安全边界保留尾部，避免 8 MB 历史阻塞隧道与阻塞浏览器主线程。
 */
export function normalizeMaxReplayBytes(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_REPLAY_BYTES;
  return Math.max(MIN_REPLAY_BYTES, Math.min(MAX_REPLAY_BYTES, Math.floor(value)));
}

export function compactTerminalReplay(raw: Buffer, maxReplayBytes?: number): Buffer {
  const limit = normalizeMaxReplayBytes(maxReplayBytes);
  const passthrough = Math.min(REPLAY_PASSTHROUGH_BYTES, limit);
  if (raw.length <= passthrough) return raw;
  const fullScan = scanReplayBuffer(raw);

  if (fullScan.inAltScreen && fullScan.lastAltEnter >= 0) {
    const normalContextLimit = Math.min(ALT_NORMAL_CONTEXT_BYTES, Math.floor(limit / 2));
    const normalPrefix =
      fullScan.lastAltEnter > 0
        ? sliceTailFromLine(raw.subarray(0, fullScan.lastAltEnter), normalContextLimit)
        : Buffer.alloc(0);

    if (fullScan.lastEraseAll > fullScan.lastAltEnter) {
      const cut = fullScan.lastEraseAll;
      const tailLen = raw.length - cut;
      if (tailLen <= limit) {
        const beforeCut = scanReplayBuffer(raw, cut);
        const modeHeader = buildActiveDecModes(beforeCut.modesAtCut, fullScan.altMode);
        return Buffer.concat([normalPrefix, modeHeader, Buffer.from("\x1b[0m", "ascii"), raw.subarray(cut)]);
      }
    }

    // 备用屏没有出现 2J 或最后一屏仍超上限：对齐到尾部上限并补清屏与模式头。
    const rawCut = Math.max(fullScan.lastAltEnter, raw.length - limit);
    const safeCut = alignSafeUtf8Start(raw, rawCut);
    const beforeCut = scanReplayBuffer(raw, safeCut);
    const modeHeader = buildActiveDecModes(beforeCut.modesAtCut, fullScan.altMode);
    return Buffer.concat([normalPrefix, modeHeader, Buffer.from("\x1b[0m\x1b[2J\x1b[H", "ascii"), raw.subarray(safeCut)]);
  }

  if (raw.length <= limit) return raw;
  const tail = sliceTailFromLine(raw, limit);
  const cutOffset = raw.length - tail.length;
  const beforeCut = scanReplayBuffer(raw, cutOffset);
  const modeHeader = buildActiveDecModes(beforeCut.modesAtCut);
  return Buffer.concat([modeHeader, Buffer.from("\x1b[0m", "ascii"), tail]);
}

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
  maxReplayBytes?: number | undefined;
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
  let live = false;
  let replayDone = false;
  let replayChunks: Buffer[] = [];
  let pendingReplaySize: TerminalSize | null = null;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;
  let writer: Socket | undefined;
  let queue: Buffer[] = [];
  let pending = 0;
  const frames = new TerminalFrames();
  const observer = new Socket();
  const versionSocket = createConnection(path);
  let versionAccepted = false;
  const handshake = setTimeout(() => fail("连接 tty7 终端超时"), TIMEOUT_MS);

  const flushReplay = (): void => {
    if (replayDone || closed) return;
    replayDone = true;
    clearTimeout(replayTimer);
    replayTimer = undefined;
    if (pendingReplaySize !== null) {
      const finalSize = pendingReplaySize;
      pendingReplaySize = null;
      events.size(finalSize);
    }
    if (replayChunks.length > 0) {
      const combined = replayChunks.length === 1 ? replayChunks[0]! : Buffer.concat(replayChunks);
      replayChunks = [];
      const compacted = compactTerminalReplay(combined, options.maxReplayBytes);
      if (compacted.length > 0) events.output(compacted);
    }
  };

  const armReplayFlush = (): void => {
    clearTimeout(replayTimer);
    replayTimer = setTimeout(flushReplay, REPLAY_COALESCE_MS);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(handshake);
    clearTimeout(replayTimer);
    replayTimer = undefined;
    replayChunks = [];
    pendingReplaySize = null;
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
    armReplayFlush();
    flush();
  });
  observer.on("data", (bytes: Buffer) => {
    try {
      frames.push(bytes, (kind, payload) => {
        if (closed) return;
        if (kind === 2) {
          if (replayDone) {
            events.output(payload);
          } else {
            replayChunks.push(Buffer.from(payload));
            armReplayFlush();
          }
        } else if (kind === 3) {
          flushReplay();
          if (!live) {
            live = true;
            events.live();
          }
          events.output(payload);
        } else if (kind === 9) {
          const next: unknown = JSON.parse(payload.toString());
          if (validTerminalSize(next)) {
            if (replayDone) {
              events.size(next);
            } else {
              // Observe 回放里夹杂着多条历史尺寸帧，聚合阶段只保留最新一条，避免把客户端缩回旧半屏尺寸。
              pendingReplaySize = next;
              armReplayFlush();
            }
          }
        } else if (kind === 63) {
          flushReplay();
          const by: unknown = JSON.parse(payload.toString());
          if (by === null || typeof by === "string") events.lease(by);
        } else if (kind === 6) {
          flushReplay();
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
