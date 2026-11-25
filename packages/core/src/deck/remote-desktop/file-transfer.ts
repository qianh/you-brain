import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

import {
  CLIPBOARD_IMAGE_MAX_BYTES,
  CLIPBOARD_IMAGE_PATH,
  FILE_CHUNK_BYTES,
  FILE_MAX_BYTES,
  type FileClientMessage,
  type FileServerMessage,
} from "./types.js";

/** `file` DataChannel 的最小抽象，便于单测。 */
export interface FileChannelPort {
  send(data: string | Buffer): void;
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
  /** 等待发送缓冲回落。 */
  waitDrain(): Promise<void>;
}

export interface HostFileTransferOptions {
  /** 上传文件保存目录，默认 `~/Downloads`。 */
  downloadsDir?: string;
  /** 仅允许下载宿主主动通告过的文件（远端剪贴板里复制的文件）。 */
  isDownloadAllowed: (path: string) => boolean;
  /** 读取宿主剪贴板图片，供控制端以 {@link CLIPBOARD_IMAGE_PATH} 下载。 */
  readClipboardImage?: () => Promise<Buffer | null>;
  /** 控制端以 `dest: "clipboard"` 上传的图片写入宿主剪贴板。 */
  writeClipboardImage?: (data: Buffer) => void | Promise<void>;
}

const ACK_EVERY_BYTES = 1024 * 1024;
const SEND_HIGH_WATER = 4 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;

/** 去掉路径分隔、控制字符与首尾点空格，保证文件名安全落在下载目录内。 */
export function sanitizeFileName(raw: string): string {
  const base = basename(String(raw ?? "").replace(/\\/gu, "/"));
  // eslint-disable-next-line no-control-regex
  let clean = base.replace(/[\u0000-\u001f\u007f/:]/gu, "_").trim();
  clean = clean.replace(/^\.+/u, "").trim();
  if (clean.length > 200) {
    const ext = extname(clean).slice(0, 20);
    clean = `${clean.slice(0, 200 - ext.length)}${ext}`;
  }
  return clean || "file";
}

async function openUnique(dir: string, name: string): Promise<{ handle: FileHandle; path: string; name: string }> {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = attempt === 0 ? name : `${stem} (${attempt})${ext}`;
    const path = join(dir, candidate);
    try {
      const handle = await open(path, "wx", 0o644);
      return { handle, path, name: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("无法在下载目录创建文件");
}

interface UploadState {
  id: string;
  size: number;
  received: number;
  lastAck: number;
  /** 写入下载目录时的文件句柄；写剪贴板时为 null，数据攒在 `chunks`。 */
  handle: FileHandle | null;
  chunks: Buffer[] | null;
  path: string;
  name: string;
}

/**
 * 宿主侧文件传输：控制端上传的文件存入远端下载目录；控制端可下载远端剪贴板中复制的文件。
 * 一个通道同一时刻只处理一个上传与一个下载，消息按到达顺序串行处理。
 */
export class HostFileTransfer {
  readonly #port: FileChannelPort;
  readonly #dir: string;
  readonly #isDownloadAllowed: (path: string) => boolean;
  readonly #readClipboardImage: (() => Promise<Buffer | null>) | undefined;
  readonly #writeClipboardImage: ((data: Buffer) => void | Promise<void>) | undefined;
  #chain: Promise<void> = Promise.resolve();
  #upload: UploadState | null = null;
  #uploadFailed: string | null = null;
  #downloadId: string | null = null;
  #downloadDone: Promise<void> | null = null;
  #cancelledDownloads = new Set<string>();
  #disposed = false;

  constructor(port: FileChannelPort, options: HostFileTransferOptions) {
    this.#port = port;
    this.#dir = options.downloadsDir ?? join(homedir(), "Downloads");
    this.#isDownloadAllowed = options.isDownloadAllowed;
    this.#readClipboardImage = options.readClipboardImage;
    this.#writeClipboardImage = options.writeClipboardImage;
  }

  handleMessage(raw: string | Buffer): void {
    if (this.#disposed) return;
    if (typeof raw !== "string") {
      const chunk = raw;
      this.#chain = this.#chain.then(() => this.#onChunk(chunk)).catch(() => undefined);
      return;
    }
    let msg: FileClientMessage;
    try {
      msg = JSON.parse(raw) as FileClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.id !== "string" || !ID_RE.test(msg.id)) return;
    if (msg.t === "get") {
      // 下载不进入串行链：与上传并行，且取消能即时生效。
      void this.#download(msg.id, msg.path);
      return;
    }
    if (msg.t === "cancel" && this.#downloadId === msg.id) {
      this.#cancelledDownloads.add(msg.id);
      return;
    }
    this.#chain = this.#chain.then(() => this.#onControl(msg)).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#downloadId) this.#cancelledDownloads.add(this.#downloadId);
    await this.#chain.catch(() => undefined);
    await this.#abortUpload();
  }

  #send(msg: FileServerMessage): void {
    if (!this.#port.isOpen) return;
    try {
      this.#port.send(JSON.stringify(msg));
    } catch {
      // 通道关闭期间忽略
    }
  }

  async #onControl(msg: FileClientMessage): Promise<void> {
    switch (msg.t) {
      case "put": {
        await this.#abortUpload();
        this.#uploadFailed = null;
        const size = Number(msg.size);
        if (!Number.isFinite(size) || size < 0 || size > FILE_MAX_BYTES) {
          this.#uploadFailed = msg.id;
          this.#send({ t: "error", id: msg.id, message: "文件过大或大小无效" });
          return;
        }
        if (msg.dest === "clipboard") {
          if (!this.#writeClipboardImage) {
            this.#uploadFailed = msg.id;
            this.#send({ t: "error", id: msg.id, message: "远端不支持写入剪贴板图片" });
            return;
          }
          if (size === 0 || size > CLIPBOARD_IMAGE_MAX_BYTES) {
            this.#uploadFailed = msg.id;
            this.#send({ t: "error", id: msg.id, message: "剪贴板图片过大（上限 20MB）" });
            return;
          }
          this.#upload = {
            id: msg.id,
            size,
            received: 0,
            lastAck: 0,
            handle: null,
            chunks: [],
            path: "clipboard",
            name: sanitizeFileName(msg.name),
          };
          return;
        }
        try {
          await mkdir(this.#dir, { recursive: true });
          const opened = await openUnique(this.#dir, sanitizeFileName(msg.name));
          this.#upload = {
            id: msg.id,
            size,
            received: 0,
            lastAck: 0,
            handle: opened.handle,
            chunks: null,
            path: opened.path,
            name: opened.name,
          };
        } catch (error) {
          this.#uploadFailed = msg.id;
          this.#send({ t: "error", id: msg.id, message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case "end": {
        const up = this.#upload;
        if (!up || up.id !== msg.id) {
          if (this.#uploadFailed !== msg.id) {
            this.#send({ t: "error", id: msg.id, message: "没有进行中的上传" });
          }
          return;
        }
        this.#upload = null;
        if (up.chunks) {
          if (up.received !== up.size) {
            this.#send({ t: "error", id: up.id, message: `图片不完整（${up.received}/${up.size}）` });
            return;
          }
          try {
            await this.#writeClipboardImage?.(Buffer.concat(up.chunks));
          } catch (error) {
            this.#send({ t: "error", id: up.id, message: error instanceof Error ? error.message : String(error) });
            return;
          }
          this.#send({ t: "saved", id: up.id, path: "clipboard", name: up.name });
          return;
        }
        await up.handle?.close().catch(() => undefined);
        if (up.received !== up.size) {
          await rm(up.path, { force: true }).catch(() => undefined);
          this.#send({ t: "error", id: up.id, message: `文件不完整（${up.received}/${up.size}）` });
          return;
        }
        this.#send({ t: "saved", id: up.id, path: up.path, name: up.name });
        return;
      }
      case "cancel": {
        if (this.#upload?.id === msg.id) await this.#abortUpload();
        return;
      }
      default:
        return;
    }
  }

  async #onChunk(chunk: Buffer): Promise<void> {
    const up = this.#upload;
    if (!up) return;
    if (up.received + chunk.length > up.size) {
      await this.#abortUpload();
      this.#uploadFailed = up.id;
      this.#send({ t: "error", id: up.id, message: "收到的数据超过声明大小" });
      return;
    }
    try {
      if (up.chunks) up.chunks.push(Buffer.from(chunk));
      else await up.handle?.write(chunk);
    } catch (error) {
      await this.#abortUpload();
      this.#uploadFailed = up.id;
      this.#send({ t: "error", id: up.id, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    up.received += chunk.length;
    if (up.received - up.lastAck >= ACK_EVERY_BYTES) {
      up.lastAck = up.received;
      this.#send({ t: "ack", id: up.id, received: up.received });
    }
  }

  async #abortUpload(): Promise<void> {
    const up = this.#upload;
    if (!up) return;
    this.#upload = null;
    if (!up.handle) return;
    await up.handle.close().catch(() => undefined);
    await rm(up.path, { force: true }).catch(() => undefined);
  }

  async #download(id: string, path: string): Promise<void> {
    // 上一个下载刚被取消、还在收尾时，等它结束再开始新的。
    if (this.#downloadId && this.#cancelledDownloads.has(this.#downloadId) && this.#downloadDone) {
      await this.#downloadDone;
    }
    if (this.#downloadId) {
      this.#send({ t: "error", id, message: "已有下载进行中" });
      return;
    }
    let finish!: () => void;
    this.#downloadDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await this.#runDownload(id, path);
    } finally {
      this.#downloadDone = null;
      finish();
    }
  }

  async #runDownload(id: string, path: string): Promise<void> {
    if (path === CLIPBOARD_IMAGE_PATH) {
      await this.#sendClipboardImage(id);
      return;
    }
    if (typeof path !== "string" || !path.startsWith("/") || !this.#isDownloadAllowed(path)) {
      this.#send({ t: "error", id, message: "只能下载远端剪贴板中复制的文件" });
      return;
    }
    this.#downloadId = id;
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("不是普通文件");
      if (info.size > FILE_MAX_BYTES) throw new Error("文件过大");
      this.#send({ t: "meta", id, name: basename(path), size: info.size });
      const stream = createReadStream(path, { highWaterMark: FILE_CHUNK_BYTES });
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (this.#cancelledDownloads.has(id) || !this.#port.isOpen) {
          stream.destroy();
          return;
        }
        for (let offset = 0; offset < chunk.length; offset += FILE_CHUNK_BYTES) {
          this.#port.send(chunk.subarray(offset, Math.min(chunk.length, offset + FILE_CHUNK_BYTES)));
        }
        if (this.#port.bufferedAmount > SEND_HIGH_WATER) {
          await this.#port.waitDrain();
        }
      }
      this.#send({ t: "done", id });
    } catch (error) {
      this.#send({ t: "error", id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#downloadId = null;
      this.#cancelledDownloads.delete(id);
    }
  }

  async #sendClipboardImage(id: string): Promise<void> {
    this.#downloadId = id;
    try {
      const data = this.#readClipboardImage ? await this.#readClipboardImage() : null;
      if (!data || data.length === 0) throw new Error("远端剪贴板里没有图片");
      if (data.length > CLIPBOARD_IMAGE_MAX_BYTES) throw new Error("剪贴板图片过大（上限 20MB）");
      this.#send({ t: "meta", id, name: "clipboard.png", size: data.length });
      for (let offset = 0; offset < data.length; offset += FILE_CHUNK_BYTES) {
        if (this.#cancelledDownloads.has(id) || !this.#port.isOpen) return;
        this.#port.send(data.subarray(offset, Math.min(data.length, offset + FILE_CHUNK_BYTES)));
        if (this.#port.bufferedAmount > SEND_HIGH_WATER) await this.#port.waitDrain();
      }
      this.#send({ t: "done", id });
    } catch (error) {
      this.#send({ t: "error", id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#downloadId = null;
      this.#cancelledDownloads.delete(id);
    }
  }
}

interface DownloadSinkEntry {
  handle: FileHandle;
  path: string;
  name: string;
  size: number;
  touchedAt: number;
}

const SINK_IDLE_MS = 10 * 60_000;
const SINK_MAX_ENTRIES = 8;

/**
 * 控制端下载落盘：桌面壳（WKWebView）不处理网页下载，下载到的分片经本机 daemon
 * 依次追加写入 `~/Downloads`，边收边写，不在页面里攒整份文件。
 */
export class RemoteDownloadSink {
  readonly #dir: string;
  readonly #entries = new Map<string, DownloadSinkEntry>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options?: { downloadsDir?: string }) {
    this.#dir = options?.downloadsDir ?? join(homedir(), "Downloads");
  }

  /** 串行执行，保证同一文件的分片按请求顺序写入。 */
  append(args: {
    token: string;
    name: string;
    offset: number;
    bytes: Uint8Array;
    final: boolean;
  }): Promise<{ path: string; name: string; size: number }> {
    const run = this.#chain.then(() => this.#append(args));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #append(args: {
    token: string;
    name: string;
    offset: number;
    bytes: Uint8Array;
    final: boolean;
  }): Promise<{ path: string; name: string; size: number }> {
    if (!ID_RE.test(args.token)) throw new Error("下载标识无效");
    await this.#sweep();
    let entry = this.#entries.get(args.token);
    if (!entry) {
      if (args.offset !== 0) throw new Error("下载分片顺序错误");
      if (this.#entries.size >= SINK_MAX_ENTRIES) throw new Error("同时进行的下载过多");
      await mkdir(this.#dir, { recursive: true });
      const opened = await openUnique(this.#dir, sanitizeFileName(args.name));
      entry = { handle: opened.handle, path: opened.path, name: opened.name, size: 0, touchedAt: Date.now() };
      this.#entries.set(args.token, entry);
    }
    if (args.offset !== entry.size) {
      await this.#abort(args.token);
      throw new Error("下载分片顺序错误");
    }
    if (entry.size + args.bytes.byteLength > FILE_MAX_BYTES) {
      await this.#abort(args.token);
      throw new Error("文件过大");
    }
    if (args.bytes.byteLength > 0) await entry.handle.write(args.bytes);
    entry.size += args.bytes.byteLength;
    entry.touchedAt = Date.now();
    if (args.final) {
      this.#entries.delete(args.token);
      await entry.handle.close().catch(() => undefined);
    }
    return { path: entry.path, name: entry.name, size: entry.size };
  }

  async #abort(token: string): Promise<void> {
    const entry = this.#entries.get(token);
    if (!entry) return;
    this.#entries.delete(token);
    await entry.handle.close().catch(() => undefined);
    await rm(entry.path, { force: true }).catch(() => undefined);
  }

  async #sweep(): Promise<void> {
    const now = Date.now();
    for (const [token, entry] of [...this.#entries]) {
      if (now - entry.touchedAt > SINK_IDLE_MS) await this.#abort(token);
    }
  }
}
