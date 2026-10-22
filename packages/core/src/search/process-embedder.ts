import { fileURLToPath } from "node:url";

import type { Subprocess } from "bun";

import { usesVendorModules } from "../native/resolver.js";
import type { Embedder } from "./embedder.js";
import type {
  EmbedWorkerRequest,
  EmbedWorkerResponse,
} from "./embed-protocol.js";

/** Unload the worker after this much quiet time. Tests inject a shorter clock. */
export const DEFAULT_EMBED_IDLE_MS = 120_000;

export interface IdleClock {
  schedule(ms: number, callback: () => void): () => void;
}

function systemIdleClock(): IdleClock {
  return {
    schedule(ms, callback) {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
  };
}

interface LineWaiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
}

class LineQueue {
  #buffer = "";
  #lines: string[] = [];
  #waiters: LineWaiter[] = [];
  #failure: Error | null = null;

  push(text: string): void {
    if (this.#failure) return;
    this.#buffer += text;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim()) this.#deliver(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  close(): void {
    if (this.#buffer.trim()) this.#deliver(this.#buffer);
    this.#buffer = "";
    this.#fail(new Error("embed worker closed stdout"));
  }

  fail(error: Error): void {
    this.#fail(error);
  }

  next(): Promise<string> {
    const queued = this.#lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  #deliver(line: string): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(line);
    else this.#lines.push(line);
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters = [];
  }
}

export function embedWorkerCommand(bun = "bun", execPath = process.execPath): string[] {
  if (usesVendorModules(execPath)) return [execPath, "embed-worker"];
  return [
    bun,
    fileURLToPath(new URL("./embed-worker.ts", import.meta.url)),
  ];
}

export interface ProcessEmbedderOptions {
  command: string[];
  model: string;
  revision: string;
  dimensions: number;
  cacheDir: string;
  /** Idle time before the worker process is stopped. Default 120 seconds. */
  idleMs?: number;
  idleClock?: IdleClock;
}

export class ProcessEmbedder implements Embedder {
  readonly model: string;
  readonly revision: string;
  readonly dimensions: number;
  readonly #command: string[];
  readonly #cacheDir: string;
  #child: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  #lines = new LineQueue();
  #stderr = { text: "" };
  #nextId = 0;
  #chain: Promise<void> = Promise.resolve();
  /** Permanent. Set only by close(). Idle unload must not set this. */
  #stopped = false;
  #pending = 0;
  #stopping: Promise<void> | null = null;
  #cancelIdle: (() => void) | null = null;
  #idleGeneration = 0;
  readonly #idleMs: number;
  readonly #idleClock: IdleClock;

  constructor(options: ProcessEmbedderOptions) {
    if (options.command.length === 0) {
      throw new Error("ProcessEmbedder requires a command");
    }
    this.model = options.model;
    this.revision = options.revision;
    this.dimensions = options.dimensions;
    this.#command = options.command;
    this.#cacheDir = options.cacheDir;
    this.#idleMs = options.idleMs ?? DEFAULT_EMBED_IDLE_MS;
    this.#idleClock = options.idleClock ?? systemIdleClock();
  }

  async embedQuery(text: string): Promise<number[]> {
    const response = await this.#request({ method: "embedQuery", text });
    const vector = response.vector;
    if (!vector || vector.length !== this.dimensions) {
      throw new Error(
        `Embedding dimensions mismatch: expected ${this.dimensions}, received ${vector?.length ?? 0}`,
      );
    }
    return vector;
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.#request({ method: "embedPassages", texts });
    const vectors = response.vectors;
    if (!vectors || vectors.length !== texts.length) {
      throw new Error("Embedding model returned an unexpected passage batch");
    }
    for (const vector of vectors) {
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Embedding dimensions mismatch: expected ${this.dimensions}, received ${vector.length}`,
        );
      }
    }
    return vectors;
  }

  async prepare(): Promise<void> {
    await this.#request({ method: "prepare" });
  }

  async close(): Promise<void> {
    this.#stopped = true;
    this.#clearIdle();
    for (;;) {
      if (this.#stopping) {
        await this.#stopping;
        continue;
      }
      if (this.#child) {
        await this.#stopCurrent();
        continue;
      }
      await Promise.resolve();
      if (this.#child || this.#stopping) continue;
      break;
    }
  }

  async #request(
    body: { method: "prepare" } | { method: "embedQuery"; text: string } | {
      method: "embedPassages";
      texts: string[];
    },
  ): Promise<EmbedWorkerResponse> {
    if (this.#stopped) throw new Error("embed worker is closed");
    this.#pending += 1;
    this.#clearIdle();
    const run = this.#chain.then(() => this.#roundtrip(body));
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      this.#pending -= 1;
      if (!this.#stopped && this.#pending === 0) this.#armIdle();
    }
  }

  async #roundtrip(
    body: { method: "prepare" } | { method: "embedQuery"; text: string } | {
      method: "embedPassages";
      texts: string[];
    },
  ): Promise<EmbedWorkerResponse> {
    if (this.#stopped) throw new Error("embed worker is closed");
    const child = this.#spawn();
    const id = ++this.#nextId;
    const request: EmbedWorkerRequest = {
      id,
      model: this.model,
      revision: this.revision,
      dimensions: this.dimensions,
      cacheDir: this.#cacheDir,
      ...body,
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);
    await child.stdin.flush();
    let line: string;
    try {
      line = await this.#lines.next();
    } catch (error) {
      this.#discard();
      const detail = this.#stderr.text.trim();
      throw new Error(
        detail
          ? `embed worker failed: ${detail}`
          : error instanceof Error
            ? error.message
            : "embed worker failed",
      );
    }
    let parsed: EmbedWorkerResponse;
    try {
      parsed = JSON.parse(line) as EmbedWorkerResponse;
    } catch {
      throw new Error(`embed worker returned invalid JSON: ${line.slice(0, 200)}`);
    }
    if (parsed.id !== id) {
      throw new Error(
        `embed worker response id mismatch: expected ${id}, received ${String(parsed.id)}`,
      );
    }
    if (!parsed.ok) {
      throw new Error(parsed.error ?? "embed worker failed");
    }
    return parsed;
  }

  #spawn(): Subprocess<"pipe", "pipe", "pipe"> {
    if (this.#child && this.#child.exitCode === null) return this.#child;
    const [binary, ...args] = this.#command;
    if (!binary) throw new Error("ProcessEmbedder requires a command");
    const child = Bun.spawn([binary, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const lines = new LineQueue();
    const stderr = { text: "" };
    this.#child = child;
    this.#lines = lines;
    this.#stderr = stderr;
    void this.#readStdout(child, lines);
    void this.#readStderr(child, stderr);
    return child;
  }

  #clearIdle(): void {
    this.#cancelIdle?.();
    this.#cancelIdle = null;
    this.#idleGeneration += 1;
  }

  #armIdle(): void {
    this.#clearIdle();
    if (this.#stopped || this.#pending !== 0) return;
    if (!this.#child || this.#child.exitCode !== null) return;
    const generation = this.#idleGeneration;
    this.#cancelIdle = this.#idleClock.schedule(this.#idleMs, () => {
      this.#enqueueIdleStop(generation);
    });
  }

  #enqueueIdleStop(generation: number): void {
    const run = this.#chain.then(async () => {
      if (generation !== this.#idleGeneration) return;
      if (this.#stopped || this.#pending > 0) return;
      await this.#stopCurrent();
    });
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
  }

  async #stopCurrent(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const child = this.#child;
    const lines = this.#lines;
    if (!child) return;
    this.#child = null;
    this.#clearIdle();
    if (child.exitCode !== null) return;
    const stopping = this.#kill(child, lines).finally(() => {
      if (this.#stopping === stopping) this.#stopping = null;
    });
    this.#stopping = stopping;
    return stopping;
  }

  async #kill(
    child: Subprocess<"pipe", "pipe", "pipe">,
    lines: LineQueue,
  ): Promise<void> {
    try {
      child.stdin.end();
    } catch {
      // The worker may already be gone.
    }
    child.kill();
    lines.fail(new Error("embed worker stopped"));
    await child.exited;
  }

  #discard(): void {
    const child = this.#child;
    this.#child = null;
    this.#clearIdle();
    if (child && child.exitCode === null) child.kill();
  }

  async #readStdout(
    child: Subprocess<"pipe", "pipe", "pipe">,
    lines: LineQueue,
  ): Promise<void> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lines.push(decoder.decode(value, { stream: true }));
      }
      lines.close();
    } catch (error) {
      lines.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #readStderr(
    child: Subprocess<"pipe", "pipe", "pipe">,
    stderr: { text: string },
  ): Promise<void> {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderr.text = `${stderr.text}${decoder.decode(value, { stream: true })}`.slice(
          -4000,
        );
      }
    } catch {
      // stderr is diagnostic only.
    }
  }
}
