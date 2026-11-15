/**
 * 开发模式下的输入延迟统计：每次输入（xterm 的 onData）到其后第一次写入完成（terminal.write 的回调）
 * 之间的毫秒数。每攒够一批就报告一次中位数和 95 分位。
 * 只在 `import.meta.env.DEV` 里使用，正式包不包含。
 */

export interface LatencyStats {
  count: number;
  median: number;
  p95: number;
}

/** 中位数：偶数个取中间两个的平均。95 分位：最近排名法（第 ceil(0.95·n) 个）。 */
export function summarize(samples: readonly number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const middle = Math.floor(count / 2);
  const median = count % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return { count, median, p95: sorted[Math.max(0, Math.ceil(count * 0.95) - 1)] ?? 0 };
}

/** 超过这个时间还没有任何输出的输入，认为没有回显（例如 Ctrl 组合键），不计入延迟。 */
const STALE_MS = 2000;
/** 没有回显的输入最多留这么多条，防止一直堆积。 */
const MAX_PENDING = 200;

export function createLatencyProbe(options: {
  batch: number;
  now(): number;
  report(stats: LatencyStats): void;
}): { input(): void; written(): void } {
  let pending: number[] = [];
  let samples: number[] = [];
  return {
    input() {
      pending.push(options.now());
      if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
    },
    written() {
      if (pending.length === 0) return;
      const now = options.now();
      const starts = pending;
      pending = [];
      for (const start of starts) {
        if (now - start > STALE_MS) continue;
        samples.push(now - start);
        if (samples.length >= options.batch) {
          options.report(summarize(samples));
          samples = [];
        }
      }
    },
  };
}
