import { appendFileSync } from "node:fs";

/**
 * Opt-in memory sampling for diagnosing the daemon in the installed app, where stderr goes
 * nowhere. Set YOU_BRAIN_MEMORY_TRACE=1 in the launching environment (on macOS:
 * `launchctl setenv YOU_BRAIN_MEMORY_TRACE 1`, then restart the app) and read
 * `<dataDir>/memory-trace.jsonl`. Each line: process RSS, JS heap size, and the most common
 * heap object types, so growth can be pinned on strings, buffers or plain objects.
 */
export function startMemoryTrace(path: string, intervalMs = 30_000): () => void {
  const sample = async (): Promise<void> => {
    try {
      const { heapStats } = await import("bun:jsc");
      const stats = heapStats();
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
  return () => clearInterval(timer);
}

/** Runs one daemon stage and appends how much memory and how many heap objects it left behind. */
export async function traceStage<T>(path: string, name: string, run: () => Promise<T>): Promise<T> {
  const { heapStats } = await import("bun:jsc");
  const before = { rss: process.memoryUsage().rss, objects: heapStats().objectCount };
  const started = performance.now();
  try {
    return await run();
  } finally {
    try {
      const after = heapStats();
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
