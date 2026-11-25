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
const APPLY_THRESHOLD = 0.04;
/** TURN 中继链路初始起步比例：避免静止后首次拖动窗口直接按峰值码率冲爆跨境中继缓冲区，随后在无丢包时平滑爬升。 */
const RELAY_INITIAL_RATIO = 0.42;

export class LossBasedBitrateController {
  #maxBps: number;
  readonly #minRatio: number;
  readonly #minAbs: number;
  readonly #onChange: ((bps: number) => void) | undefined;
  #target: number;
  #applied: number;
  #isRelay = false;
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

  /** 切换画质时重置上限与目标（若当前走 TURN 中继则从平滑起步值开始爬升）。 */
  setMax(maxBps: number): void {
    this.#maxBps = Math.max(1, maxBps);
    const initial = this.#isRelay
      ? Math.max(this.#minBps, Math.round(this.#maxBps * RELAY_INITIAL_RATIO))
      : this.#maxBps;
    this.#target = initial;
    this.#applied = initial;
    this.#lastDecreaseAt = Number.NEGATIVE_INFINITY;
    this.#onChange?.(Math.round(this.#target));
  }

  /** 标记当前连接是否经由 TURN 中继转发；首次切入中继时压低初始突发码率，若后续 ICE 动态重提名切回 P2P 直连则立即恢复上限。 */
  setRelayMode(isRelay: boolean): void {
    if (this.#isRelay === isRelay) return;
    this.#isRelay = isRelay;
    if (isRelay) {
      const safeStart = Math.max(this.#minBps, Math.round(this.#maxBps * RELAY_INITIAL_RATIO));
      if (this.#target > safeStart) {
        this.#target = safeStart;
        this.#applied = safeStart;
        this.#onChange?.(Math.round(this.#target));
      }
    } else if (this.#lastLoss < CLEAN_LOSS && this.#target < this.#maxBps) {
      this.#target = this.#maxBps;
      this.#applied = this.#maxBps;
      this.#onChange?.(Math.round(this.#target));
    }
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
