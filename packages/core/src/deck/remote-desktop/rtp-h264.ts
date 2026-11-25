import { RtpHeader, RtpPacket } from "werift";

import { buildFlexfecPayload } from "./fec.js";
import type { EncodedVideoFrame } from "./types.js";

/**
 * 保守的 RTP 净荷上限（字节）：兼容 IPv4/IPv6 + UDP + SRTP + VPN / TURN / 蜂窝网络 MTU，避免 IP 分片丢包。
 */
export const DEFAULT_RTP_MAX_PAYLOAD = 1180;
/** 单次微突发最多连续发送的 RTP 包数；超过后让出 1ms，防止大体积 IDR 帧冲爆内核/路由器 UDP 缓冲区。 */
const BURST_PACKETS_LIMIT = 20;
const BURST_PACE_MS = 1;
/** 发送队列积压超过此非关键帧数时丢弃旧中间帧并请求新关键帧，杜绝弱网画面延迟堆积。 */
const MAX_QUEUED_FRAMES = 3;
/** 每多少个媒体包生成 1 个 FlexFEC 修复包（帧尾不足一组也补 1 个）；组内丢 1 包可就地恢复，免等重传往返。 */
const FEC_GROUP_PACKETS = 4;

/**
 * 从 VideoToolbox 输出的 4 字节大端长度前缀 AVCC 缓冲区零拷贝切分 NALU（跳过 AUD=9 与空单元）。
 */
export function extractAvccNalus(avcc: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= avcc.length) {
    const length = avcc.readUInt32BE(offset);
    offset += 4;
    if (length === 0) continue;
    if (offset + length > avcc.length) break;
    const nalu = avcc.subarray(offset, offset + length);
    offset += length;
    const nalType = nalu[0]! & 0x1f;
    if (nalType === 9) continue; // 忽略 Access Unit Delimiter
    out.push(nalu);
  }
  return out;
}

/**
 * 按 RFC 6184（packetization-mode=1）将一帧的 NALU 列表封装为 RTP H.264 负载序列：
 * - 若存在细小的 SPS/PPS 参数集且总长未超 MTU，合并为单个 STAP-A（type 24）包减少系统调用；
 * - 单 NALU <= maxPayload 时直接作为 Single NALU 包；
 * - 大切片拆分为 FU-A（type 28）分片包。
 */
export function packetizeH264AccessUnit(
  frame: EncodedVideoFrame,
  maxPayload = DEFAULT_RTP_MAX_PAYLOAD,
): Buffer[] {
  const sliceNalus = extractAvccNalus(frame.avcc);
  if (sliceNalus.length === 0) return [];

  const packets: Buffer[] = [];
  if (frame.keyframe && frame.sps && frame.pps && frame.sps.length > 0 && frame.pps.length > 0) {
    const stapLen = 1 + 2 + frame.sps.length + 2 + frame.pps.length;
    if (stapLen <= maxPayload) {
      const nri = Math.max(frame.sps[0]! & 0x60, frame.pps[0]! & 0x60);
      const stap = Buffer.allocUnsafe(stapLen);
      stap[0] = nri | 24; // STAP-A
      stap.writeUInt16BE(frame.sps.length, 1);
      frame.sps.copy(stap, 3);
      const ppsOffset = 3 + frame.sps.length;
      stap.writeUInt16BE(frame.pps.length, ppsOffset);
      frame.pps.copy(stap, ppsOffset + 2);
      packets.push(stap);
    } else {
      packets.push(...packetizeSingleOrFuA(frame.sps, maxPayload));
      packets.push(...packetizeSingleOrFuA(frame.pps, maxPayload));
    }
  }

  for (const nalu of sliceNalus) {
    // 若编码流本身已带 SPS(7)/PPS(8) 且上面已通过 STAP-A 注入，避免重复发送
    const nalType = nalu[0]! & 0x1f;
    if (frame.keyframe && frame.sps && frame.pps && (nalType === 7 || nalType === 8)) continue;
    packets.push(...packetizeSingleOrFuA(nalu, maxPayload));
  }
  return packets;
}

export function packetizeSingleOrFuA(nalu: Buffer, maxPayload = DEFAULT_RTP_MAX_PAYLOAD): Buffer[] {
  if (nalu.length === 0) return [];
  if (nalu.length <= maxPayload) return [nalu];

  const header = nalu[0]!;
  const fnri = header & 0xe0;
  const nalType = header & 0x1f;
  const fuIndicator = fnri | 28; // FU-A
  const body = nalu.subarray(1);
  const chunkSize = maxPayload - 2;
  const out: Buffer[] = [];

  for (let offset = 0; offset < body.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, body.length);
    const isStart = offset === 0;
    const isEnd = end === body.length;
    const fuHeader = (isStart ? 0x80 : 0) | (isEnd ? 0x40 : 0) | nalType;
    const pkt = Buffer.allocUnsafe(2 + (end - offset));
    pkt[0] = fuIndicator;
    pkt[1] = fuHeader;
    body.copy(pkt, 2, offset, end);
    out.push(pkt);
  }
  return out;
}

export interface RtpSenderPort {
  readonly ssrc: number;
  readonly payloadType: number;
  sendRtp(packet: RtpPacket): Promise<void> | void;
  /** 可选：FlexFEC 前向纠错（对端 SDP 协商了 flexfec-03 时才提供）。 */
  readonly fec?: FecSenderPort | undefined;
}

export interface FecSenderPort {
  /** 取回刚发出的媒体包的明文完整字节（序号、扩展头以实际发出为准）；取不到返回 null，该包不受保护。 */
  sentPacket(sequenceNumber: number): Buffer | null;
  /** 用独立 SSRC 发出修复包。 */
  sendRepair(payload: Buffer, timestamp: number): Promise<void> | void;
}

/**
 * 面向单条 WebRTC 连接的低延迟 RTP H.264 发送器：
 * - 普通帧零额外延迟立即发出；
 * - 大体积关键帧按 20 包微突发平滑让出 1ms，彻底消除 UDP 套接字瞬时丢包导致的卡顿；
 * - 队列过载时主动丢弃陈旧中间帧并回调 `onDropNeedKeyframe`，绝不累积画面延迟。
 */
export class LowLatencyH264RtpStreamer {
  readonly #sender: RtpSenderPort;
  readonly #onDropNeedKeyframe: (() => void) | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  #seq = (Math.floor(Math.random() * 30_000) + 1) & 0xffff;
  #basePtsUs: number | null = null;
  #lastRtpTs = 0;
  #queue: EncodedVideoFrame[] = [];
  #draining = false;
  #awaitingKeyframe = false;
  #closed = false;
  /** 诊断计数（累计）：完整发出的帧、积压丢弃或等待关键帧期间跳过的帧。 */
  #framesSent = 0;
  #framesDropped = 0;
  #fecPacketsSent = 0;

  get counters(): { sent: number; dropped: number; fecSent: number } {
    return { sent: this.#framesSent, dropped: this.#framesDropped, fecSent: this.#fecPacketsSent };
  }

  constructor(
    sender: RtpSenderPort,
    options?: {
      onDropNeedKeyframe?: () => void;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.#sender = sender;
    this.#onDropNeedKeyframe = options?.onDropNeedKeyframe;
    this.#sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  enqueue(frame: EncodedVideoFrame): void {
    if (this.#closed) return;
    if (frame.keyframe) {
      // 新关键帧到达时，尚未发出的旧非关键帧已无参考意义，直接清空并解除等待态
      this.#framesDropped += this.#queue.length;
      this.#queue.length = 0;
      this.#awaitingKeyframe = false;
    } else if (this.#awaitingKeyframe) {
      // 已丢弃前序参考帧：在新关键帧到达前跳过孤立 P 帧，避免浪费 TURN 带宽并触发解码端花屏/PLI 风暴
      this.#framesDropped += 1;
      return;
    } else if (this.#queue.length >= MAX_QUEUED_FRAMES) {
      this.#framesDropped += this.#queue.length + 1;
      this.#queue.length = 0;
      this.#awaitingKeyframe = true;
      this.#onDropNeedKeyframe?.();
      return;
    }
    this.#queue.push(frame);
    if (!this.#draining) {
      void this.#drain();
    }
  }

  close(): void {
    this.#closed = true;
    this.#queue.length = 0;
  }

  #computeRtpTimestamp(ptsUs: number): number {
    if (this.#basePtsUs === null) {
      this.#basePtsUs = ptsUs;
      this.#lastRtpTs = 90_000;
      return this.#lastRtpTs;
    }
    const deltaUs = Math.max(0, ptsUs - this.#basePtsUs);
    let next = (90_000 + Math.round((deltaUs * 90) / 1000)) >>> 0;
    if (next === this.#lastRtpTs) {
      next = (this.#lastRtpTs + 1) >>> 0;
    }
    this.#lastRtpTs = next;
    return next;
  }

  async #drain(): Promise<void> {
    this.#draining = true;
    try {
      while (!this.#closed && this.#queue.length > 0) {
        const frame = this.#queue.shift()!;
        const payloads = packetizeH264AccessUnit(frame);
        if (payloads.length === 0) continue;
        const rtpTs = this.#computeRtpTimestamp(frame.ptsUs);
        const pt = this.#sender.payloadType;
        const ssrc = this.#sender.ssrc;
        const fec = this.#sender.fec;
        let group: Buffer[] = [];
        const flushFec = async () => {
          if (!fec || group.length === 0) return;
          const repair = buildFlexfecPayload(group, ssrc);
          group = [];
          await fec.sendRepair(repair, rtpTs);
          this.#fecPacketsSent += 1;
        };

        for (let index = 0; index < payloads.length; index += 1) {
          if (this.#closed) return;
          const sequenceNumber = this.#seq;
          const header = new RtpHeader({
            payloadType: pt,
            sequenceNumber: this.#seq,
            timestamp: rtpTs,
            ssrc,
            marker: index === payloads.length - 1,
          });
          this.#seq = (this.#seq + 1) & 0xffff;
          await this.#sender.sendRtp(new RtpPacket(header, payloads[index]!));
          if (fec) {
            const sent = fec.sentPacket(sequenceNumber);
            if (sent) group.push(sent);
            // 取不到字节时先结掉当前组，保证每组序号连续、不超出掩码范围
            if (!sent || group.length >= FEC_GROUP_PACKETS) await flushFec();
          }
          if (payloads.length > BURST_PACKETS_LIMIT && (index + 1) % BURST_PACKETS_LIMIT === 0 && index + 1 < payloads.length) {
            await this.#sleep(BURST_PACE_MS);
          }
        }
        await flushFec();
        this.#framesSent += 1;
      }
    } catch {
      // 连接关闭期间写包异常安全忽略
    } finally {
      this.#draining = false;
    }
  }
}
