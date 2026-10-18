import { fileURLToPath } from "node:url";

import type { Subprocess } from "bun";

import type { Embedder } from "./embedder.js";
import type {
  EmbedWorkerRequest,
  EmbedWorkerResponse,
} from "./embed-protocol.js";

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

export function embedWorkerCommand(bun = "bun"): string[] {
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
  #closed = false;

  constructor(options: ProcessEmbedderOptions) {
    if (options.command.length === 0) {
      throw new Error("ProcessEmbedder requires a command");
    }
    this.model = options.model;
    this.revision = options.revision;
    this.dimensions = options.dimensions;
    this.#command = options.command;
    this.#cacheDir = options.cacheDir;
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
    this.#closed = true;
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // The worker may already be gone.
    }
    child.kill();
    await child.exited;
  }

  async #request(
    body: { method: "prepare" } | { method: "embedQuery"; text: string } | {
      method: "embedPassages";
      texts: string[];
    },
  ): Promise<EmbedWorkerResponse> {
    const run = this.#chain.then(() => this.#roundtrip(body));
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #roundtrip(
    body: { method: "prepare" } | { method: "embedQuery"; text: string } | {
      method: "embedPassages";
      texts: string[];
    },
  ): Promise<EmbedWorkerResponse> {
    if (this.#closed) throw new Error("embed worker is closed");
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

  #discard(): void {
    const child = this.#child;
    this.#child = null;
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
