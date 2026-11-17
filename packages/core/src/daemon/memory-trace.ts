import { appendFileSync } from "node:fs";

/**
 * Opt-in memory sampling for diagnosing the daemon in the installed app, where stderr goes
 * nowhere. Set YOU_BRAIN_MEMORY_TRACE=1 in the launching environment (on macOS:
 * `launchctl setenv YOU_BRAIN_MEMORY_TRACE 1`, then restart the app) and read
 * `<dataDir>/memory-trace.jsonl`. Each line: process RSS, JS heap size, and the most common
 * heap object types, so growth can be pinned on strings, buffers or plain objects.
 */
/**
 * When each traced stage ran, so a blocked event loop can be pinned on the stages that
 * overlapped it. The monitor only notices a block after it ends, by which time a stage
 * that caused it may already have finished; hence intervals, not a set of running ones.
 */
const stageRuns: Array<{ name: string; start: number; end: number }> = [];
/** Time the tracer itself held the thread (heap walks), left out of the block figures. */
let selfMs = 0;

function timedHeapStats(heapStats: () => import("bun:jsc").HeapStats): import("bun:jsc").HeapStats {
  const started = performance.now();
  try {
    return heapStats();
  } finally {
    selfMs += performance.now() - started;
  }
}

/**
 * Event-loop blocks: a 50 ms timer that fires late means synchronous work held the thread.
 * Blocks over `thresholdMs` are written with the stages that were running, one of which
 * did it (or none: an HTTP request or a timer outside the traced stages).
 */
/** Frames every async stack carries; they say nothing about where the time went. */
const PLUMBING = new Set([
  "(module)", "asyncFunctionResume", "promiseReactionJob", "promiseReactionJobWithoutPromiseUnwrapAsyncContext",
  "traceStage", "processTicksAndRejections", "drain", "samplingProfilerStackTraces",
]);

type ProfileTraces = { traces: Array<{ frames: Array<{ name: string; line: number }> }> };

/**
 * The functions a block spent its time in. The sampling profiler collects stacks while the
 * thread is busy; the monitor drains them on every tick, so the batch drained right after a
 * block is that block. `inclusive` counts samples whose stack contains a function, which
 * finds the caller doing the work even when the leaf is a builtin.
 */
function summarizeSamples(batch: ProfileTraces["traces"]): Record<string, unknown> | null {
  if (batch.length === 0) return null;
  const inclusive = new Map<string, number>();
  const stacks = new Map<string, number>();
  for (const sample of batch) {
    const names = sample.frames
      .map((frame) => frame.name)
      .filter((name) => name !== "" && !name.startsWith("#") && !PLUMBING.has(name));
    for (const name of new Set(names)) inclusive.set(name, (inclusive.get(name) ?? 0) + 1);
    const stack = names.slice(0, 8).join(" < ");
    stacks.set(stack, (stacks.get(stack) ?? 0) + 1);
  }
  const top = (map: Map<string, number>, count: number) =>
    Object.fromEntries([...map].sort((left, right) => right[1] - left[1]).slice(0, count));
  return { samples: batch.length, inclusive: top(inclusive, 15), stacks: top(stacks, 4) };
}

function startBlockMonitor(path: string, thresholdMs = 200): () => void {
  const periodMs = 50;
  let last = performance.now();
  let selfAtLast = selfMs;
  let drain: (() => ProfileTraces["traces"]) | null = null;
  void import("bun:jsc").then((jsc) => {
    try {
      jsc.startSamplingProfiler();
      const profiler = jsc as unknown as { samplingProfilerStackTraces(): ProfileTraces };
      drain = () => profiler.samplingProfilerStackTraces().traces ?? [];
    } catch {
      // No profiler: blocks are still logged, without stacks.
    }
  });
  const timer = setInterval(() => {
    const batch = drain?.() ?? [];
    const now = performance.now();
    const blocked = now - last - periodMs - (selfMs - selfAtLast);
    last = now;
    selfAtLast = selfMs;
    // Forget runs that ended long ago.
    while (stageRuns.length > 0 && stageRuns[0]!.end < now - 60_000) stageRuns.shift();
    if (blocked < thresholdMs) return;
    const from = now - blocked - periodMs;
    const active = [...new Set(stageRuns.filter((run) => run.start <= now && run.end >= from).map((run) => run.name))];
    try {
      appendFileSync(path, `${JSON.stringify({
        at: new Date().toISOString(),
        blockMs: Math.round(blocked),
        active,
        ...(blocked >= 500 ? { profile: summarizeSamples(batch) } : {}),
      })}\n`);
    } catch {
      // Diagnostics must never disturb the daemon.
    }
  }, periodMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function startMemoryTrace(path: string, intervalMs = 30_000): () => void {
  const stopBlocks = startBlockMonitor(path);
  const sample = async (): Promise<void> => {
    try {
      const { heapStats } = await import("bun:jsc");
      const stats = timedHeapStats(heapStats);
      const top = Object.entries(stats.objectTypeCounts)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 12);
      const line = {
        at: new Date().toISOString(),
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
        heapMb: Math.round(stats.heapSize / 1048576),
        heapCapacityMb: Math.round(stats.heapCapacity / 1048576),
        extraMb: Math.round(stats.extraMemorySize / 1048576),
        objects: stats.objectCount,
        top: Object.fromEntries(top),
      };
      appendFileSync(path, `${JSON.stringify(line)}\n`);
    } catch {
      // Diagnostics must never disturb the daemon.
    }
  };
  void sample();
  const timer = setInterval(() => void sample(), intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    stopBlocks();
  };
}

/** Runs one daemon stage and appends how much memory and how many heap objects it left behind. */
export async function traceStage<T>(path: string, name: string, run: () => Promise<T>): Promise<T> {
  const { heapStats } = await import("bun:jsc");
  const before = { rss: process.memoryUsage().rss, objects: timedHeapStats(heapStats).objectCount };
  const started = performance.now();
  const record = { name, start: started, end: Number.POSITIVE_INFINITY };
  stageRuns.push(record);
  try {
    return await run();
  } finally {
    record.end = performance.now();
    try {
      const after = timedHeapStats(heapStats);
      const rss = process.memoryUsage().rss;
      appendFileSync(path, `${JSON.stringify({
        at: new Date().toISOString(),
        stage: name,
        ms: Math.round(performance.now() - started),
        rssMb: Math.round(rss / 1048576),
        rssDeltaMb: Math.round((rss - before.rss) / 1048576),
        objectsDelta: after.objectCount - before.objects,
        heapMb: Math.round(after.heapSize / 1048576),
      })}\n`);
    } catch {
      // Diagnostics must never disturb the daemon.
    }
  }
}
