/**
 * 远程桌面文件传输（控制端）：经 `file` DataChannel 上传到远端「下载」文件夹，
 * 或下载远端剪贴板里复制的文件。上传按 16KB 分片并做发送缓冲背压。
 */
export const FILE_CHUNK_BYTES = 16 * 1024;
const READ_SLICE_BYTES = 1024 * 1024;
const SEND_HIGH_WATER = 4 * 1024 * 1024;
const SEND_LOW_WATER = 1024 * 1024;
/** 下载时每攒够这么多字节交给落盘函数一次。 */
const SINK_FLUSH_BYTES = 4 * 1024 * 1024;

export interface FileChannelLike {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: string;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "bufferedamountlow" | "close", listener: () => void): void;
  removeEventListener(type: "bufferedamountlow" | "close", listener: () => void): void;
}

export type TransferStatus = "queued" | "active" | "done" | "error" | "cancelled";

export interface TransferItem {
  id: string;
  direction: "up" | "down";
  name: string;
  size: number;
  transferred: number;
  status: TransferStatus;
  error?: string;
  /** 上传：远端保存路径；下载：本机保存位置描述。 */
  savedAt?: string;
}

/** 下载落盘：分片依次交付，`final` 为最后一片。返回保存位置描述。 */
export type DownloadSink = (args: {
  token: string;
  name: string;
  offset: number;
  chunk: Blob;
  final: boolean;
}) => Promise<string | undefined>;

type ServerFrame =
  | { t: "ack"; id: string; received: number }
  | { t: "saved"; id: string; path: string; name: string }
  | { t: "meta"; id: string; name: string; size: number }
  | { t: "done"; id: string }
  | { t: "error"; id: string; message: string };

interface UploadJob {
  item: TransferItem;
  file: Blob;
  settle?: (result: { ok: true; path: string } | { ok: false; message: string }) => void;
}

interface DownloadJob {
  item: TransferItem;
  path: string;
  /** 收到 meta 后才接收二进制分片，丢弃上一个已取消下载的残留分片。 */
  started: boolean;
  buffered: Blob[];
  bufferedBytes: number;
  flushedBytes: number;
  sinkChain: Promise<string | undefined>;
  settle?: () => void;
}

function transferId(): string {
  const raw =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `f${raw.slice(0, 20)}`;
}

export class RemoteFileClient {
  readonly #dc: FileChannelLike;
  readonly #onUpdate: (items: TransferItem[]) => void;
  readonly #sink: DownloadSink;
  readonly #items: TransferItem[] = [];
  readonly #uploads: UploadJob[] = [];
  readonly #downloads: DownloadJob[] = [];
  #uploading: UploadJob | null = null;
  #downloading: DownloadJob | null = null;
  #disposed = false;

  constructor(dc: FileChannelLike, options: { onUpdate: (items: TransferItem[]) => void; sink: DownloadSink }) {
    this.#dc = dc;
    this.#onUpdate = options.onUpdate;
    this.#sink = options.sink;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = SEND_LOW_WATER;
    dc.addEventListener("message", (event) => this.#onMessage(event.data));
    dc.addEventListener("close", () => this.dispose("连接已断开"));
  }

  get items(): readonly TransferItem[] {
    return this.#items;
  }

  upload(files: Iterable<File>): void {
    for (const file of files) {
      const item: TransferItem = {
        id: transferId(),
        direction: "up",
        name: file.name || "file",
        size: file.size,
        transferred: 0,
        status: "queued",
      };
      this.#items.push(item);
      this.#uploads.push({ item, file });
    }
    this.#emit();
    void this.#pumpUploads();
  }

  download(file: { path: string; name: string; size: number }): void {
    const item: TransferItem = {
      id: transferId(),
      direction: "down",
      name: file.name,
      size: file.size,
      transferred: 0,
      status: "queued",
    };
    this.#items.push(item);
    this.#downloads.push({
      item,
      path: file.path,
      started: false,
      buffered: [],
      bufferedBytes: 0,
      flushedBytes: 0,
      sinkChain: Promise.resolve(undefined),
    });
    this.#emit();
    this.#pumpDownloads();
  }

  cancel(id: string): void {
    const item = this.#items.find((entry) => entry.id === id);
    if (!item || (item.status !== "queued" && item.status !== "active")) return;
    item.status = "cancelled";
    if (this.#isOpen()) {
      this.#sendJson({ t: "cancel", id });
    }
    if (this.#uploading?.item === item) {
      this.#uploading.settle?.({ ok: false, message: "已取消" });
    }
    if (this.#downloading?.item === item) {
      this.#downloading.settle?.();
    }
    this.#emit();
  }

  /** 清掉已结束的条目。 */
  clearFinished(): void {
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const status = this.#items[i]?.status;
      if (status === "done" || status === "error" || status === "cancelled") this.#items.splice(i, 1);
    }
    this.#emit();
  }

  dispose(reason = "传输已中止"): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const item of this.#items) {
      if (item.status === "queued" || item.status === "active") {
        item.status = "error";
        item.error = reason;
      }
    }
    this.#uploading?.settle?.({ ok: false, message: reason });
    this.#downloading?.settle?.();
    this.#uploads.length = 0;
    this.#downloads.length = 0;
    this.#emit();
  }

  #emit(): void {
    this.#onUpdate(this.#items.map((item) => ({ ...item })));
  }

  #isOpen(): boolean {
    return this.#dc.readyState === "open";
  }

  #sendJson(frame: unknown): void {
    this.#dc.send(JSON.stringify(frame));
  }

  async #waitDrain(): Promise<void> {
    if (this.#dc.bufferedAmount <= SEND_HIGH_WATER) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        this.#dc.removeEventListener("bufferedamountlow", done);
        this.#dc.removeEventListener("close", done);
        resolve();
      };
      this.#dc.addEventListener("bufferedamountlow", done);
      this.#dc.addEventListener("close", done);
    });
  }

  async #pumpUploads(): Promise<void> {
    if (this.#uploading || this.#disposed) return;
    const job = this.#uploads.shift();
    if (!job) return;
    if (job.item.status === "cancelled") {
      void this.#pumpUploads();
      return;
    }
    this.#uploading = job;
    const { item, file } = job;
    item.status = "active";
    this.#emit();
    const result = new Promise<{ ok: true; path: string } | { ok: false; message: string }>((resolve) => {
      job.settle = resolve;
    });
    try {
      if (!this.#isOpen()) throw new Error("文件通道未就绪");
      this.#sendJson({ t: "put", id: item.id, name: item.name, size: item.size });
      let offset = 0;
      let lastEmit = 0;
      while (offset < file.size) {
        if (item.status !== "active" || this.#disposed) break;
        const slice = new Uint8Array(await file.slice(offset, offset + READ_SLICE_BYTES).arrayBuffer());
        for (let pos = 0; pos < slice.byteLength; pos += FILE_CHUNK_BYTES) {
          if (item.status !== "active" || !this.#isOpen()) break;
          this.#dc.send(slice.subarray(pos, Math.min(slice.byteLength, pos + FILE_CHUNK_BYTES)));
          if (this.#dc.bufferedAmount > SEND_HIGH_WATER) await this.#waitDrain();
        }
        offset += slice.byteLength;
        item.transferred = Math.max(item.transferred, offset - this.#dc.bufferedAmount);
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          this.#emit();
        }
      }
      if (item.status === "active" && this.#isOpen()) {
        this.#sendJson({ t: "end", id: item.id });
        const outcome = await result;
        if (item.status === "active") {
          if (outcome.ok) {
            item.status = "done";
            item.transferred = item.size;
            item.savedAt = outcome.path;
          } else {
            item.status = "error";
            item.error = outcome.message;
          }
        }
      }
    } catch (error) {
      if (item.status === "active") {
        item.status = "error";
        item.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.#uploading = null;
      this.#emit();
      void this.#pumpUploads();
    }
  }

  #pumpDownloads(): void {
    if (this.#downloading || this.#disposed) return;
    const job = this.#downloads.shift();
    if (!job) return;
    if (job.item.status === "cancelled") {
      this.#pumpDownloads();
      return;
    }
    if (!this.#isOpen()) {
      job.item.status = "error";
      job.item.error = "文件通道未就绪";
      this.#emit();
      return;
    }
    this.#downloading = job;
    job.item.status = "active";
    job.settle = () => {
      if (this.#downloading === job) {
        this.#downloading = null;
        this.#emit();
        this.#pumpDownloads();
      }
    };
    this.#emit();
    this.#sendJson({ t: "get", id: job.item.id, path: job.path });
  }

  #flushDownload(job: DownloadJob, final: boolean): void {
    if (job.bufferedBytes === 0 && !final) return;
    const chunk = new Blob(job.buffered);
    const offset = job.flushedBytes;
    job.flushedBytes += job.bufferedBytes;
    job.buffered = [];
    job.bufferedBytes = 0;
    job.sinkChain = job.sinkChain.then(() =>
      this.#sink({ token: job.item.id, name: job.item.name, offset, chunk, final }),
    );
  }

  #onMessage(data: unknown): void {
    if (this.#disposed) return;
    if (typeof data !== "string") {
      const job = this.#downloading;
      if (!job || job.item.status !== "active" || !job.started) return;
      const buffer = data instanceof ArrayBuffer ? data : null;
      if (!buffer) return;
      job.buffered.push(new Blob([buffer]));
      job.bufferedBytes += buffer.byteLength;
      job.item.transferred += buffer.byteLength;
      if (job.bufferedBytes >= SINK_FLUSH_BYTES) {
        this.#flushDownload(job, false);
        this.#emit();
      }
      return;
    }
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data) as ServerFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame.id !== "string") return;

    const upload = this.#uploading;
    if (upload && upload.item.id === frame.id) {
      if (frame.t === "ack") {
        upload.item.transferred = Math.max(upload.item.transferred, frame.received);
        this.#emit();
      } else if (frame.t === "saved") {
        upload.settle?.({ ok: true, path: frame.path });
      } else if (frame.t === "error") {
        upload.settle?.({ ok: false, message: frame.message });
      }
      return;
    }

    const job = this.#downloading;
    if (!job || job.item.id !== frame.id) return;
    if (frame.t === "meta") {
      job.started = true;
      job.item.size = frame.size;
      job.item.name = frame.name || job.item.name;
      this.#emit();
    } else if (frame.t === "done") {
      this.#flushDownload(job, true);
      const item = job.item;
      void job.sinkChain.then(
        (savedAt) => {
          item.status = "done";
          if (savedAt) item.savedAt = savedAt;
          job.settle?.();
        },
        (error: unknown) => {
          item.status = "error";
          item.error = error instanceof Error ? error.message : String(error);
          job.settle?.();
        },
      );
    } else if (frame.t === "error") {
      job.item.status = "error";
      job.item.error = frame.message;
      job.buffered = [];
      job.settle?.();
    }
  }
}

/** 普通浏览器：攒齐分片后触发浏览器下载。 */
export function createBrowserDownloadSink(): DownloadSink {
  const parts = new Map<string, Blob[]>();
  return async ({ token, name, chunk, final }) => {
    const list = parts.get(token) ?? [];
    list.push(chunk);
    parts.set(token, list);
    if (!final) return undefined;
    parts.delete(token);
    const blob = new Blob(list);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return undefined;
  };
}
