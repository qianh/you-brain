// Adapted from Meta's muse-gadget-sdk and wong2/muse-client (Apache-2.0).
import { randomUUID } from "node:crypto";

import { CipherState, NoiseInitiator } from "./crypto.js";
import { MuseError, MuseProtocolError } from "./errors.js";
import {
  FrameAssembler,
  bodyChunkFrame,
  frameChunks,
  requestFrame,
  resetFrame,
  responseFrame,
} from "./wire.js";

class BodyQueue implements AsyncIterable<Buffer> {
  #chunks: Buffer[] = [];
  #size = 0;
  #ended = false;
  #error: Error | undefined;
  #wake: (() => void) | undefined;

  push(chunk: Buffer): boolean {
    if (!chunk.length || this.#ended) return true;
    if (this.#size + chunk.length > 4 * 1024 * 1024) return false;
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    this.#wake?.();
    return true;
  }

  end(error?: Error): void {
    this.#ended = true;
    this.#error = error;
    if (error) {
      this.#chunks = [];
      this.#size = 0;
    }
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (;;) {
      if (this.#error) throw this.#error;
      const chunk = this.#chunks.shift();
      if (chunk) {
        this.#size -= chunk.length;
        yield chunk;
      } else if (this.#ended) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
      }
    }
  }
}

export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_REQUEST_BYTES = 64 * 1024;
const REQUEST_CHUNK_BYTES = 16 * 1024;

export interface MuseTransportSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(): void;
  ping?(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (error: unknown) => void): void;
  onPong?(cb: () => void): void;
}

export type MuseSocketFactory = (url: string, headers: Record<string, string>) => MuseTransportSocket;

function defaultSocketFactory(url: string, headers: Record<string, string>): MuseTransportSocket {
  // Bun supports `{ headers }` on global WebSocket.
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const bunWs = ws as WebSocket & { ping?: () => void };
  return {
    get readyState() {
      return ws.readyState;
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send(data) {
      ws.send(data);
    },
    close() {
      try {
        ws.close();
      } catch {
        // Ignore already-closed sockets.
      }
    },
    ping() {
      bunWs.ping?.();
    },
    onOpen(cb) {
      ws.addEventListener("open", () => cb());
    },
    onMessage(cb) {
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          cb(Buffer.from(event.data), false);
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          cb(Buffer.from(new Uint8Array(event.data)), true);
          return;
        }
        if (ArrayBuffer.isView(event.data)) {
          cb(Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength), true);
          return;
        }
        cb(Buffer.alloc(0), false);
      });
    },
    onClose(cb) {
      ws.addEventListener("close", () => cb());
    },
    onError(cb) {
      ws.addEventListener("error", (event) => cb(event));
    },
    onPong(cb) {
      ws.addEventListener("pong" as "message", () => cb());
    },
  };
}

interface Pending {
  queue: BodyQueue;
  status?: number;
  resolve: (status: number) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  headersTimer: ReturnType<typeof setTimeout>;
}

export interface MuseResponse {
  status: number;
  body: AsyncIterable<Buffer>;
  close(): void;
}

export class NoiseUpgradeError extends MuseError {
  override name = "NoiseUpgradeError";
}

export class NoiseConnection {
  #sendCipher: CipherState | undefined;
  #receiveCipher: CipherState | undefined;
  readonly #assembler = new FrameAssembler();
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #dead = false;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #pong = true;
  readonly #closeListeners = new Set<(error: Error) => void>();

  private constructor(private readonly socket: MuseTransportSocket) {}

  get closed(): boolean {
    return this.#dead;
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  static connect(
    url: string,
    token: string,
    createSocket: MuseSocketFactory = defaultSocketFactory,
  ): Promise<NoiseConnection> {
    return new Promise((resolve, reject) => {
      const socket = createSocket(url, {
        Authorization: `Bearer ${token}`,
        "User-Agent": "muse-client/0.4.0",
      });
      const connection = new NoiseConnection(socket);
      const handshake = new NoiseInitiator();
      let opened = false;
      let established = false;
      const timer = setTimeout(() => fail(new MuseError("Noise 握手超时")), 20_000);

      function fail(error: Error): void {
        clearTimeout(timer);
        connection.#fail(error);
        reject(error);
      }

      socket.onError(() => {
        fail(opened ? new MuseError("Muse WebSocket 连接中断") : new NoiseUpgradeError("无法建立 Muse Noise 连接"));
      });
      socket.onClose(() => {
        fail(opened ? new MuseError("Muse 连接已关闭") : new NoiseUpgradeError("Muse 拒绝或关闭了握手连接"));
      });
      socket.onOpen(() => {
        opened = true;
        try {
          socket.send(handshake.message1());
        } catch (error) {
          fail(asError(error));
        }
      });
      socket.onPong?.(() => {
        connection.#pong = true;
      });
      socket.onMessage((data, binary) => {
        try {
          if (!binary) throw new MuseProtocolError("预期二进制 Noise 消息");
          if (!established) {
            handshake.receiveMessage2(data);
            const keys = handshake.finish();
            connection.#sendCipher = keys.send;
            connection.#receiveCipher = keys.receive;
            socket.send(keys.message);
            established = true;
            clearTimeout(timer);
            if (socket.ping && socket.onPong) {
              connection.#heartbeat = setInterval(() => {
                if (!connection.#pong) {
                  fail(new MuseError("Muse 心跳超时"));
                  return;
                }
                connection.#pong = false;
                socket.ping?.();
              }, 20_000);
              connection.#heartbeat.unref?.();
            }
            resolve(connection);
          } else {
            connection.#receive(data);
          }
        } catch (error) {
          fail(asError(error));
        }
      });
    });
  }

  #receive(data: Buffer): void {
    const receiveCipher = this.#receiveCipher;
    if (!receiveCipher) return;
    const envelope = this.#assembler.decode(receiveCipher.decrypt(data));
    if (!envelope) return;
    const frame = responseFrame(envelope);
    const pending = this.#pending.get(frame.streamId);
    if (!pending) return;
    if (frame.kind === "reset") {
      this.#finish(frame.streamId, new MuseError("Muse 重置了请求流"));
      return;
    }
    if (frame.kind === "response") {
      if (pending.status !== undefined) throw new MuseProtocolError("重复的响应头");
      if (frame.status === undefined) throw new MuseProtocolError("缺少响应状态码");
      pending.status = frame.status;
      clearTimeout(pending.headersTimer);
      pending.resolve(frame.status);
    } else if (pending.status === undefined) {
      throw new MuseProtocolError("响应体早于响应头到达");
    }
    if (!pending.queue.push(frame.body)) {
      this.#finish(frame.streamId, new MuseError("响应消费过慢"));
      this.#reset(frame.streamId);
      return;
    }
    if (frame.end) this.#finish(frame.streamId);
  }

  #finish(id: number, error?: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.cleanup();
    if (error) pending.reject(error);
    else if (pending.status === undefined) pending.reject(new MuseProtocolError("响应在收到响应头前结束"));
    pending.queue.end(error);
  }

  async #transmit(data: Buffer): Promise<void> {
    if (this.#dead || !this.#sendCipher || this.socket.readyState !== 1) {
      throw new MuseError("Muse 未连接");
    }
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) {
      throw new MuseError("Muse 发送缓冲区已满");
    }
    for (const frame of frameChunks(data)) {
      try {
        if (this.#dead) throw new MuseError("Muse 连接已关闭");
        this.socket.send(this.#sendCipher.encrypt(frame));
      } catch (error) {
        const normalized = asError(error);
        this.#fail(normalized);
        throw normalized;
      }
    }
  }

  #reset(id: number): void {
    void this.#transmit(resetFrame(id)).catch((error) => this.#fail(asError(error)));
  }

  async #upload(id: number, method: "GET" | "POST", path: string, encoded: Buffer): Promise<void> {
    const chunked = encoded.length > MAX_INLINE_REQUEST_BYTES;
    const headers: Record<string, string> = {
      accept: method === "GET" ? "application/json" : "application/x-ndjson",
      "x-request-id": randomUUID(),
      "x-app-id": "hatch-web",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    };
    await this.#transmit(
      requestFrame(id, method, path, chunked ? Buffer.alloc(0) : encoded, headers, !chunked),
    );
    if (chunked) {
      for (let offset = 0; offset < encoded.length; offset += REQUEST_CHUNK_BYTES) {
        if (!this.#pending.has(id)) return;
        const part = encoded.subarray(offset, offset + REQUEST_CHUNK_BYTES);
        await this.#transmit(bodyChunkFrame(id, part, offset + part.length === encoded.length));
      }
    }
  }

  async open(
    path: string,
    body?: unknown,
    options: { method?: "GET" | "POST"; signal?: AbortSignal } = {},
  ): Promise<MuseResponse> {
    if (this.#dead) throw new MuseError("Muse 连接已关闭");
    options.signal?.throwIfAborted();
    if (this.#pending.size >= 64) throw new MuseError("Muse 并发请求过多");
    const method = options.method ?? (body === undefined ? "GET" : "POST");
    const encoded = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    if (encoded.length > MAX_REQUEST_BODY_BYTES) throw new MuseError("Muse 请求体超过上限");
    const id = this.#nextId++;
    const queue = new BodyQueue();
    const close = (): void => {
      if (!this.#pending.has(id)) return;
      this.#finish(id, new MuseError("请求已取消"));
      this.#reset(id);
    };
    const status = new Promise<number>((resolve, reject) => {
      const headersTimer = setTimeout(() => {
        this.#finish(id, new MuseError("等待 Muse 响应超时"));
        this.#reset(id);
      }, 20_000);
      this.#pending.set(id, {
        queue,
        resolve,
        reject,
        headersTimer,
        cleanup: () => {
          clearTimeout(headersTimer);
          options.signal?.removeEventListener("abort", close);
        },
      });
      options.signal?.addEventListener("abort", close, { once: true });
      void this.#upload(id, method, path, encoded).catch((error) => {
        if (!this.#pending.has(id)) return;
        this.#finish(id, asError(error));
        this.#reset(id);
      });
    });
    return { status: await status, body: queue, close };
  }

  #fail(error: Error): void {
    if (this.#dead) return;
    this.#dead = true;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    for (const id of [...this.#pending.keys()]) this.#finish(id, error);
    this.socket.close();
    for (const listener of this.#closeListeners) {
      try {
        listener(error);
      } catch {
        // Ignore listener errors.
      }
    }
  }

  close(): void {
    this.#fail(new MuseError("客户端主动关闭了 Muse 连接"));
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new MuseError("Muse 通信协议异常");
}
