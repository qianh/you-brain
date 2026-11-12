import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { conversationKey } from "@you-brain/protocol";

import { discoverSessions, type DiscoveryOptions } from "../adapters/index.js";
import type { CapturePathFilter } from "../adapters/filter.js";
import type { NormalizedSession, SessionSource } from "../domain/index.js";

const CAPTURE_GC_BYTES = 8 * 1024 * 1024;
const CAPTURE_GC_FILE_BYTES = 1024 * 1024;

export interface CaptureMeta {
  source: SessionSource;
  conversationId: string;
  device: string;
  startedAt: string;
  updatedAt: string;
  sourcePath: string;
  turnCount: number;
  hash: string;
  includeSubagents: boolean;
  keepToolCalls: boolean;
  redact: boolean;
}

export interface CaptureHit {
  index: number;
  path: string;
  stamp: string;
  key: string | null;
  meta: CaptureMeta | null;
  /** File bytes and flags matched the previous scan, so `meta` is filled by the parent. */
  unchanged: boolean;
}

export interface CaptureCursorInput {
  stamp: string;
  key: string | null;
  generation: string;
  sourcePath: string | null;
}

export interface CaptureScanRequest {
  device: string;
  includeSubagents: boolean;
  keepToolCalls: boolean;
  redact: boolean;
  generation: string;
  sources: SessionSource[];
  paths: DiscoveryOptions["paths"];
  sourceFilters: Partial<Record<SessionSource, CapturePathFilter>>;
  cursors: Record<string, CaptureCursorInput>;
}

export function captureGeneration(input: {
  includeSubagents: boolean;
  keepToolCalls: boolean;
  redact: boolean;
}): string {
  return `${input.includeSubagents ? 1 : 0}|${input.keepToolCalls ? 1 : 0}|${input.redact ? 1 : 0}`;
}

export async function captureFileStamp(
  path: string,
): Promise<{ stamp: string; bytes: number } | null> {
  // A row-backed source points at `<database>#<row>`. Its stamp is the database file,
  // so a changed thread row is picked up on the next scan.
  const at = path.indexOf("#");
  const filePath = at > 0 ? path.slice(0, at) : path;
  const row = at > 0 ? path.slice(at + 1) : "";
  try {
    const info = await stat(filePath);
    if (!info.isDirectory()) {
      const stamp = `f:${info.mtimeMs}:${info.size}`;
      if (!row) return { stamp, bytes: info.size };
      // A row-backed source is a live SQLite database. In WAL mode new rows land in
      // `<database>-wal` and the main file only changes on checkpoint, so the log is
      // part of the stamp; otherwise a running CLI would look untouched.
      const wal = await stat(`${filePath}-wal`).catch(() => null);
      return {
        stamp: wal ? `${stamp}:${wal.mtimeMs}:${wal.size}#${row}` : `${stamp}#${row}`,
        bytes: info.size + (wal?.size ?? 0),
      };
    }
    const history = await stat(join(path, "chat_history.jsonl"));
    const summary = await stat(join(path, "summary.json"));
    return {
      stamp: `d:${history.mtimeMs}:${history.size}:${summary.mtimeMs}:${summary.size}`,
      bytes: history.size + summary.size,
    };
  } catch {
    return null;
  }
}

export function sessionHash(session: NormalizedSession): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        updatedAt: session.updatedAt,
        turns: session.turns.map((turn) => [turn.role, turn.text]),
      }),
    )
    .digest("hex");
}

/** Parse session files and keep only metadata. Large JSONL garbage is collected per file. */
export async function collectCaptureHits(
  request: CaptureScanRequest,
  signal?: AbortSignal,
): Promise<CaptureHit[]> {
  const hits: CaptureHit[] = [];
  let index = 0;
  let parsedBytes = 0;
  let releaseParsed = false;
  const release = (): void => {
    if (!releaseParsed) return;
    releaseParsed = false;
    Bun.gc(true);
  };
  await discoverSessions({
    device: request.device,
    includeSubagents: request.includeSubagents,
    keepToolCalls: request.keepToolCalls,
    redact: request.redact,
    retainSessions: false,
    sourceFilters: request.sourceFilters,
    sources: request.sources,
    ...(signal ? { signal } : {}),
    paths: request.paths,
    skipFile: async (path) => {
      release();
      const stamped = await captureFileStamp(path);
      if (!stamped) return false;
      const cursor = request.cursors[path];
      if (!cursor || cursor.generation !== request.generation || cursor.stamp !== stamped.stamp) {
        return false;
      }
      if (cursor.key !== null && cursor.sourcePath !== path) return false;
      hits.push({
        index: index++,
        path,
        stamp: stamped.stamp,
        key: cursor.key,
        meta: null,
        unchanged: true,
      });
      return true;
    },
    onParsed: async (path, session) => {
      release();
      const stamped = await captureFileStamp(path);
      const bytes = stamped?.bytes ?? 0;
      parsedBytes += bytes;
      if (bytes >= CAPTURE_GC_FILE_BYTES || parsedBytes >= CAPTURE_GC_BYTES) {
        parsedBytes = 0;
        releaseParsed = true;
      }
      if (!session) {
        hits.push({
          index: index++,
          path,
          stamp: stamped?.stamp ?? "",
          key: null,
          meta: null,
          unchanged: false,
        });
        return;
      }
      hits.push({
        index: index++,
        path,
        stamp: stamped?.stamp ?? "",
        key: conversationKey(session.source, session.conversationId),
        meta: {
          source: session.source,
          conversationId: session.conversationId,
          device: session.device,
          startedAt: session.startedAt,
          updatedAt: session.updatedAt,
          sourcePath: session.sourcePath,
          turnCount: session.turns.length,
          hash: sessionHash(session),
          includeSubagents: request.includeSubagents,
          keepToolCalls: request.keepToolCalls,
          redact: request.redact,
        },
        unchanged: false,
      });
    },
  });
  release();
  return hits;
}

export class CaptureWorkerTimeoutError extends Error {
  readonly reason: "stall" | "timeout";

  constructor(reason: "stall" | "timeout") {
    super(
      reason === "stall"
        ? "采集扫描没有进展，已结束卡住的扫描进程"
        : "采集扫描超时，已结束扫描进程",
    );
    this.name = "CaptureWorkerTimeoutError";
    this.reason = reason;
  }
}

export interface CaptureChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  readonly stderr: ReadableStream<Uint8Array> | number | null | undefined;
}

/** `ps -o time=` formats: `mm:ss.ss`, `hh:mm:ss`, or `d-hh:mm:ss`. */
export function parsePsTime(text: string): number | null {
  const value = text.trim();
  const clock = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/u.exec(value);
  if (clock) {
    return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  }
  const days = /^(\d+)-(\d+):(\d+):(\d+(?:\.\d+)?)$/u.exec(value);
  if (days) {
    return (
      Number(days[1]) * 86400 +
      Number(days[2]) * 3600 +
      Number(days[3]) * 60 +
      Number(days[4])
    );
  }
  const minutes = /^(\d+):(\d+(?:\.\d+)?)$/u.exec(value);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2]);
  return null;
}

export async function processCpuSeconds(pid: number): Promise<number | null> {
  const proc = Bun.spawn(["ps", "-o", "time=", "-p", String(pid)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;
  return parsePsTime(text);
}

async function readStderr(
  stderr: CaptureChild["stderr"],
): Promise<string> {
  if (stderr === null || stderr === undefined || typeof stderr === "number") return "";
  const text = await new Response(stderr).text();
  return text.length > 8_192 ? text.slice(-8_192) : text;
}

async function stopCaptureChild(child: CaptureChild, graceMs: number): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  const exited = await Promise.race([
    child.exited.then(() => true, () => true),
    delay(graceMs).then(() => false),
  ]);
  if (exited) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  await child.exited.catch(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait until the capture worker exits. An idle worker never closes its stderr,
 * and the parent used to wait on that pipe with no deadline, so one wedged scan
 * froze the daemon. A stall (CPU time not moving) or an absolute deadline kills
 * the worker and rejects.
 */
export async function waitCaptureChild(
  child: CaptureChild,
  options: {
    timeoutMs: number;
    stallMs: number;
    pollMs?: number;
    cpuSeconds?: (pid: number) => Promise<number | null>;
    killGraceMs?: number;
  },
): Promise<{ code: number; stderr: string }> {
  const stderrPromise = readStderr(child.stderr);
  const pollMs = options.pollMs ?? 15_000;
  const cpuSeconds = options.cpuSeconds ?? processCpuSeconds;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let lastCpu: number | null = null;
  let lastMove = Date.now();

  const stop = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (poll !== undefined) clearInterval(poll);
    timer = undefined;
    poll = undefined;
  };

  const outcome = new Promise<"exit" | "stall" | "timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
    if (Number.isFinite(options.stallMs)) {
      poll = setInterval(() => {
        void cpuSeconds(child.pid)
          .then((cpu) => {
            if (settled || cpu === null) return;
            if (lastCpu === null || cpu > lastCpu + 0.01) {
              lastCpu = cpu;
              lastMove = Date.now();
              return;
            }
            if (Date.now() - lastMove >= options.stallMs) resolve("stall");
          })
          .catch(() => undefined);
      }, pollMs);
    }
    void child.exited.then(
      () => resolve("exit"),
      () => resolve("exit"),
    );
  });

  let kind: "exit" | "stall" | "timeout";
  try {
    kind = await outcome;
  } finally {
    settled = true;
    stop();
  }

  if (kind !== "exit") {
    await stopCaptureChild(child, options.killGraceMs ?? 1_000);
    await stderrPromise.catch(() => "");
    throw new CaptureWorkerTimeoutError(kind);
  }
  const code = await child.exited;
  const stderr = await stderrPromise.catch(() => "");
  return { code, stderr };
}

export async function runCaptureWorker(): Promise<void> {
  const requestPath = process.env.YOU_BRAIN_CAPTURE_REQUEST;
  const resultPath = process.env.YOU_BRAIN_CAPTURE_RESULT;
  if (!requestPath || !resultPath) throw new Error("capture worker 缺少请求路径");
  const request = JSON.parse(await Bun.file(requestPath).text()) as CaptureScanRequest;
  const hits = await collectCaptureHits(request);
  await Bun.write(resultPath, JSON.stringify(hits));
}

export function captureWorkerBinary(): boolean {
  if (process.env.YOU_BRAIN_CAPTURE_INPROCESS === "1") return false;
  const base = process.execPath.split(/[/\\]/u).pop() ?? "";
  return base === "you-brain" || base === "you-brain.exe";
}

