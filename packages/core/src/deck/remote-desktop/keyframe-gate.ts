/**
 * 关键帧请求限频。
 *
 * 高 RTT 弱网下，接收端在关键帧还没到（或还在靠重传补洞）时会连续发 PLI；每个 PLI 都出一帧 IDR，
 * 新 IDR 又大又容易丢包，接收端继续 PLI，形成“IDR 风暴”，画面可以几十秒都解不出来。
 *
 * 规则：
 * - 刚出过关键帧、PLI 不可能是针对它发的（RTT 内到达）→ 直接忽略，在途关键帧会解决；
 * - 已请求关键帧但编码器还没出 → 忽略，等它出来；
 * - 距上一关键帧不足最小间隔 → 合并为一次，延后到间隔结束再发，给重传补齐当前关键帧的时间；
 * - 期间若编码器自己出了关键帧，取消延后的请求。
 * `drop`（发送队列积压丢帧，必须有新关键帧才能恢复）不会被忽略，最多延后。
 */
export type KeyframeRequestSource = "pli" | "drop";

export interface KeyframeGateOptions {
  send: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 已发请求后等待编码器出关键帧的最长时间；超时仍未出则允许再次请求。 */
const OUTSTANDING_MS = 1_000;
/** 关键帧到达后，这段时间内的 PLI 视为针对旧丢包，忽略：RTT + 余量。 */
const STALE_MARGIN_MS = 150;
const DEFAULT_RTT_MS = 300;

/** 两次关键帧之间的最小间隔：约 3 个 RTT，让 NACK 有机会把在途关键帧补完整。 */
export function keyframeMinIntervalMs(rttMs: number | null): number {
  const rtt = rttMs ?? DEFAULT_RTT_MS;
  return Math.min(3_000, Math.max(1_000, rtt * 3 + 200));
}

export class KeyframeGate {
  readonly #send: () => void;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #lastKeyframeAt = Number.NEGATIVE_INFINITY;
  #lastRequestAt = Number.NEGATIVE_INFINITY;
  #pending: unknown = null;
  /** 诊断计数：放行、忽略、合并延后的请求数。 */
  #sent = 0;
  #ignored = 0;
  #deferred = 0;

  constructor(options: KeyframeGateOptions) {
    this.#send = options.send;
    this.#now = options.now ?? Date.now;
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get counters(): { sent: number; ignored: number; deferred: number } {
    return { sent: this.#sent, ignored: this.#ignored, deferred: this.#deferred };
  }

  /** 编码器实际产出了关键帧（不论是谁请求的）。 */
  noteKeyframe(): void {
    this.#lastKeyframeAt = this.#now();
    this.#lastRequestAt = Number.NEGATIVE_INFINITY;
    this.#cancelPending();
  }

  /** 无条件立即请求（建连、切屏、重配编码等必须马上出关键帧的场景）。 */
  force(): void {
    this.#cancelPending();
    this.#fire();
  }

  request(source: KeyframeRequestSource, rttMs: number | null): void {
    const now = this.#now();
    if (this.#pending !== null) {
      this.#ignored += 1;
      return;
    }
    if (now - this.#lastRequestAt < OUTSTANDING_MS) {
      this.#ignored += 1;
      return;
    }
    const sinceKeyframe = now - this.#lastKeyframeAt;
    if (source === "pli" && sinceKeyframe < (rttMs ?? DEFAULT_RTT_MS) + STALE_MARGIN_MS) {
      this.#ignored += 1;
      return;
    }
    const wait = keyframeMinIntervalMs(rttMs) - sinceKeyframe;
    if (wait > 0) {
      this.#deferred += 1;
      this.#pending = this.#setTimer(() => {
        this.#pending = null;
        this.#fire();
      }, wait);
      return;
    }
    this.#fire();
  }

  close(): void {
    this.#cancelPending();
  }

  #fire(): void {
    this.#lastRequestAt = this.#now();
    this.#sent += 1;
    this.#send();
  }

  #cancelPending(): void {
    if (this.#pending === null) return;
    this.#clearTimer(this.#pending);
    this.#pending = null;
  }
}
