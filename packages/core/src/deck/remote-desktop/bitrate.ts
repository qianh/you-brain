/**
 * 基于 RTCP 接收报告丢包率的 AIMD 码率控制。
 *
 * 屏幕画面大部分时间静止、偶尔突发，TWCC 类带宽估计在空闲期容易把估值拉低；
 * 丢包率直接反映链路是否过载，按它乘性降、缓慢加，弱网时画面先降清晰度而不是卡死。
 */
export interface LossBasedBitrateOptions {
  maxBps: number;
  /** 下限占上限比例，默认 0.2。 */
  minRatio?: number;
  /** 绝对下限，默认 600 kbps。 */
  minBps?: number;
  onChange?: (bps: number) => void;
}

const HEAVY_LOSS = 0.1;
const LIGHT_LOSS = 0.03;
const CLEAN_LOSS = 0.01;
const INCREASE_HOLD_AFTER_DECREASE_MS = 3_000;
const INCREASE_INTERVAL_MS = 1_000;
const DECREASE_INTERVAL_MS = 300;
const APPLY_THRESHOLD = 0.03;

export class LossBasedBitrateController {
  #maxBps: number;
  readonly #minRatio: number;
  readonly #minAbs: number;
  readonly #onChange: ((bps: number) => void) | undefined;
  #target: number;
  #applied: number;
  #lastDecreaseAt = Number.NEGATIVE_INFINITY;
  #lastIncreaseAt = Number.NEGATIVE_INFINITY;
  #lastLoss = 0;

  constructor(options: LossBasedBitrateOptions) {
    this.#maxBps = Math.max(1, options.maxBps);
    this.#minRatio = options.minRatio ?? 0.2;
    this.#minAbs = options.minBps ?? 600_000;
    this.#onChange = options.onChange;
    this.#target = this.#maxBps;
    this.#applied = this.#maxBps;
  }

  get targetBps(): number {
    return Math.round(this.#target);
  }

  get maxBps(): number {
    return this.#maxBps;
  }

  /** 最近一次报告的丢包率（0~1）。 */
  get lastLoss(): number {
    return this.#lastLoss;
  }

  get #minBps(): number {
    return Math.min(this.#maxBps, Math.max(this.#minAbs, this.#maxBps * this.#minRatio));
  }

  /** 切换画质时重置上限与目标。 */
  setMax(maxBps: number): void {
    this.#maxBps = Math.max(1, maxBps);
    this.#target = this.#maxBps;
    this.#applied = this.#maxBps;
    this.#lastDecreaseAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * @param fractionLost RTCP RR 里的 8 位丢包分数（0~255）。
   */
  onReceiverReport(fractionLost: number, nowMs: number): void {
    const loss = Math.min(1, Math.max(0, fractionLost / 256));
    this.#lastLoss = loss;
    const floor = this.#minBps;
    if (loss > HEAVY_LOSS) {
      if (nowMs - this.#lastDecreaseAt >= DECREASE_INTERVAL_MS) {
        this.#target = Math.max(floor, this.#target * 0.7);
        this.#lastDecreaseAt = nowMs;
      }
    } else if (loss > LIGHT_LOSS) {
      if (nowMs - this.#lastDecreaseAt >= DECREASE_INTERVAL_MS) {
        this.#target = Math.max(floor, this.#target * 0.88);
        this.#lastDecreaseAt = nowMs;
      }
    } else if (loss < CLEAN_LOSS) {
      if (
        this.#target < this.#maxBps &&
        nowMs - this.#lastDecreaseAt >= INCREASE_HOLD_AFTER_DECREASE_MS &&
        nowMs - this.#lastIncreaseAt >= INCREASE_INTERVAL_MS
      ) {
        this.#target = Math.min(this.#maxBps, this.#target * 1.08);
        this.#lastIncreaseAt = nowMs;
      }
    }
    const changed = Math.abs(this.#target - this.#applied) / Math.max(1, this.#applied);
    if (changed >= APPLY_THRESHOLD || (this.#target === this.#maxBps && this.#applied !== this.#maxBps)) {
      this.#applied = this.#target;
      this.#onChange?.(Math.round(this.#target));
    }
  }
}
