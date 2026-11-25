/**
 * 基于 RTCP 接收报告丢包率与 RTT 排队时延的 AIMD 码率控制。
 *
 * 屏幕画面大部分时间静止、偶尔突发，TWCC 类带宽估计在空闲期容易把估值拉低；
 * 丢包率直接反映链路是否过载，按它乘性降、缓慢加，弱网时画面先降清晰度而不是卡死。
 * 经代理隧道或中继时拥塞往往只排队不丢包，因此 RTT 相对近期基线明显升高时同样乘性降速。
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

/**
 * 基于 RTT 的排队检测：UDP 被塞进代理隧道或中继缓冲区时，拥塞表现为排队变长而非丢包，
 * 只看丢包会一路加码率直到秒级延迟。以近期最小 RTT 为基线，超出部分视为排队时延。
 */
const BASE_RTT_WINDOW_MS = 20_000;
/** 排队时延超过 max(绝对值, 基线×比例) 视为轻度拥塞。 */
const QUEUE_LIGHT_MS = 60;
const QUEUE_LIGHT_RATIO = 0.25;
/** 排队时延超过 max(绝对值, 基线×比例) 视为严重拥塞。 */
const QUEUE_HEAVY_MS = 200;
const QUEUE_HEAVY_RATIO = 0.6;
/** 排队时延低于 max(绝对值, 基线×比例) 才允许加码率。 */
const QUEUE_CLEAR_MS = 25;
const QUEUE_CLEAR_RATIO = 0.1;
/**
 * RTT 趋势：基线可能在一开始就带着排队（起步码率已超过容量），只看“高出基线多少”会漏判；
 * 单次上涨超过该值，或连续两次上涨且累计超过轻度阈值，同样视为排队在增长。
 */
const TREND_SPIKE_MS = 150;
const TREND_RISE_MS = 40;
/** 两次按排队降码率的最小间隔；RTT 回落（队列排空中）时不再继续降。 */
const DELAY_DECREASE_MIN_INTERVAL_MS = 300;

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
  /** 近期 RTT 样本（时间, 毫秒），用于求滑动窗口最小值作为无排队基线。 */
  #rttSamples: Array<{ at: number; rtt: number }> = [];
  #lastRttMs: number | null = null;
  #lastRise = 0;
  #queueClear = true;

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

  /** 最近一次报告的有效丢包率（0~1，RR 丢包与重传比例取大）。 */
  get lastLoss(): number {
    return this.#lastLoss;
  }

  /** 最近一次 RTT 样本（毫秒），尚无样本时为 null。 */
  get lastRttMs(): number | null {
    return this.#lastRttMs;
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
    // 中继与直连的基线 RTT 差别很大，切换路径后重新学习，避免旧基线把新路径误判为排队。
    this.#rttSamples = [];
    this.#lastRttMs = null;
    this.#lastRise = 0;
    this.#queueClear = true;
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
   * @param retransmitRatio 同一报告周期内被 NACK 的包占发出包的比例（0~1）。
   *   RR 统计的是重传补齐后仍缺的包，高 RTT 下重传总能补上，RR 常年接近 0，链路实际在大量丢包；
   *   取两者较大值作为有效丢包率，否则码率永远不会因丢包下调。
   */
  onReceiverReport(fractionLost: number, nowMs: number, retransmitRatio = 0): void {
    const reported = Math.min(1, Math.max(0, fractionLost / 256));
    const loss = Math.max(reported, Number.isFinite(retransmitRatio) ? Math.min(1, Math.max(0, retransmitRatio)) : 0);
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
        this.#queueClear &&
        this.#target < this.#maxBps &&
        nowMs - this.#lastDecreaseAt >= INCREASE_HOLD_AFTER_DECREASE_MS &&
        nowMs - this.#lastIncreaseAt >= INCREASE_INTERVAL_MS
      ) {
        this.#target = Math.min(this.#maxBps, this.#target * 1.08);
        this.#lastIncreaseAt = nowMs;
      }
    }
    this.#maybeApply();
  }

  /**
   * 喂入一次 RTT 样本（来自 RTCP RR 的 LSR/DLSR）。RTT 明显高于近期基线说明链路在排队：
   * 立即乘性降码率；排队消退前暂停丢包驱动的加速。
   */
  onRoundTripTime(rttMs: number, nowMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs <= 0) return;
    const rise = this.#lastRttMs === null ? 0 : rttMs - this.#lastRttMs;
    const prevRise = this.#lastRise;
    this.#lastRise = rise;
    this.#lastRttMs = rttMs;
    this.#rttSamples.push({ at: nowMs, rtt: rttMs });
    while (this.#rttSamples.length > 0 && nowMs - this.#rttSamples[0]!.at > BASE_RTT_WINDOW_MS) {
      this.#rttSamples.shift();
    }
    let baseRtt = rttMs;
    for (const sample of this.#rttSamples) baseRtt = Math.min(baseRtt, sample.rtt);
    const queueMs = rttMs - baseRtt;
    // 排队说明链路实际容量低于当前码率，允许降到绝对下限，而不是停在按比例算的下限上继续排队。
    const floor = Math.min(this.#maxBps, this.#minAbs);
    // RTT 已明显回落说明队列正在排空，上一次降速已经生效，不再继续降，避免降过头。
    const draining = rise < -QUEUE_CLEAR_MS;
    const canDecrease = !draining && nowMs - this.#lastDecreaseAt >= DELAY_DECREASE_MIN_INTERVAL_MS;

    const growing = rise > TREND_SPIKE_MS || (rise > 0 && prevRise > 0 && rise + prevRise > TREND_RISE_MS);

    if (queueMs > Math.max(QUEUE_HEAVY_MS, baseRtt * QUEUE_HEAVY_RATIO) || rise > QUEUE_HEAVY_MS) {
      this.#queueClear = false;
      if (canDecrease) {
        this.#target = Math.max(floor, this.#target * 0.5);
        this.#lastDecreaseAt = nowMs;
      }
    } else if (queueMs > Math.max(QUEUE_LIGHT_MS, baseRtt * QUEUE_LIGHT_RATIO) || growing) {
      this.#queueClear = false;
      if (canDecrease) {
        this.#target = Math.max(floor, this.#target * 0.85);
        this.#lastDecreaseAt = nowMs;
      }
    } else {
      this.#queueClear = queueMs <= Math.max(QUEUE_CLEAR_MS, baseRtt * QUEUE_CLEAR_RATIO) && Math.abs(rise) <= QUEUE_CLEAR_MS;
    }
    this.#maybeApply();
  }

  #maybeApply(): void {
    const changed = Math.abs(this.#target - this.#applied) / Math.max(1, this.#applied);
    if (changed >= APPLY_THRESHOLD || (this.#target === this.#maxBps && this.#applied !== this.#maxBps)) {
      this.#applied = this.#target;
      this.#onChange?.(Math.round(this.#target));
    }
  }
}
