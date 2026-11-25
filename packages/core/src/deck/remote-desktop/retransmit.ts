/**
 * 重传相关的两个小工具：
 * - {@link RtpSendHistory}：比 werift 自带的 128 包缓存更长的已发包历史。高 RTT（~300ms）下一个
 *   大关键帧就有上百个包，NACK 回来时前半帧已被挤出 werift 的缓存，重传不了，关键帧永远补不齐；
 * - {@link NackRateMeter}：按 RR 周期统计被 NACK 的包占发出包的比例，作为“重传补上前”的真实丢包率。
 */

/** 已发包历史长度：约 2~3 秒的中继码率，足够覆盖大关键帧 + 数个 RTT。 */
export const SEND_HISTORY_SIZE = 512;

export class RtpSendHistory<T> {
  readonly #slots: Array<{ seq: number; packet: T } | undefined>;

  constructor(readonly size = SEND_HISTORY_SIZE) {
    this.#slots = new Array(size);
  }

  put(sequenceNumber: number, packet: T): void {
    this.#slots[sequenceNumber % this.size] = { seq: sequenceNumber, packet };
  }

  get(sequenceNumber: number): T | undefined {
    const slot = this.#slots[sequenceNumber % this.size];
    return slot && slot.seq === sequenceNumber ? slot.packet : undefined;
  }
}

/** 一个周期至少发出这么多包才计算比例；画面静止时样本太少，比例没有意义，继续累积。 */
const MIN_SAMPLE_PACKETS = 20;

export class NackRateMeter {
  #sent = 0;
  readonly #nacked = new Set<number>();

  noteSent(count = 1): void {
    this.#sent += count;
  }

  /** 同一个包会被反复 NACK（每个 RTT 一次），按序号去重。 */
  noteNack(sequenceNumbers: readonly number[]): void {
    for (const seq of sequenceNumbers) this.#nacked.add(seq);
  }

  /** 取出本周期的重传比例（0~1）并开始新周期；样本不足时返回 0 且不清零。 */
  take(): number {
    if (this.#sent < MIN_SAMPLE_PACKETS) return 0;
    const ratio = Math.min(1, this.#nacked.size / this.#sent);
    this.#sent = 0;
    this.#nacked.clear();
    return ratio;
  }
}
