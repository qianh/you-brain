/**
 * FlexFEC 前向纠错（单 SSRC、单层异或）。
 *
 * 一组被保护的媒体包（完整 RTP 字节）异或成一个修复包，组内丢任意 1 个包，接收端可直接恢复，
 * 不必等一个往返的重传。修复包走独立 SSRC / 序号空间，丢了也不会在媒体序号里留下空洞。
 *
 * 字段异或规则与 libwebrtc `ForwardErrorCorrection` 一致：前 2 字节（P/X/CC/M/PT）、
 * 长度恢复（包长 - 12）、时间戳，以及第 12 字节之后的全部内容（含 CSRC、扩展头与负载）。
 */

/** 单个修复包最多保护的连续媒体包数（受 15 位掩码限制）。 */
export const FLEXFEC_MAX_GROUP = 15;

/** FlexFEC 包头格式：`draft03` 为 libwebrtc 的 flexfec-03（带 SSRC 字段），`rfc8627` 为正式版（不带）。 */
export type FlexfecHeaderFormat = "draft03" | "rfc8627";

const RTP_FIXED_HEADER = 12;

function headerSize(format: FlexfecHeaderFormat): number {
  return format === "draft03" ? 20 : 12;
}

function seqOf(packet: Buffer): number {
  return packet.readUInt16BE(2);
}

/**
 * 为一组媒体包生成 FlexFEC 修复包负载。
 * @param packets 已按发送顺序排列的完整 RTP 包（未加密），序号跨度须小于 {@link FLEXFEC_MAX_GROUP}。
 * @param protectedSsrc 被保护媒体流的 SSRC（仅 `draft03` 写入包头）。
 */
export function buildFlexfecPayload(
  packets: readonly Buffer[],
  protectedSsrc: number,
  format: FlexfecHeaderFormat = "draft03",
): Buffer {
  if (packets.length === 0) throw new Error("FlexFEC 至少保护 1 个包");
  const base = seqOf(packets[0]!);
  let mask = 0x8000; // k 位：掩码到此结束
  let maxBody = 0;
  for (const packet of packets) {
    if (packet.length < RTP_FIXED_HEADER) throw new Error("RTP 包过短");
    const offset = (seqOf(packet) - base) & 0xffff;
    if (offset >= FLEXFEC_MAX_GROUP) throw new Error(`FlexFEC 组跨度超过 ${FLEXFEC_MAX_GROUP} 个序号`);
    mask |= 1 << (14 - offset);
    maxBody = Math.max(maxBody, packet.length - RTP_FIXED_HEADER);
  }

  const hdr = headerSize(format);
  const out = Buffer.alloc(hdr + maxBody);
  for (const packet of packets) {
    out[0]! ^= packet[0]!;
    out[1]! ^= packet[1]!;
    const bodyLength = packet.length - RTP_FIXED_HEADER;
    out[2]! ^= bodyLength >> 8;
    out[3]! ^= bodyLength & 0xff;
    for (let i = 4; i < 8; i += 1) out[i]! ^= packet[i]!;
    for (let i = RTP_FIXED_HEADER; i < packet.length; i += 1) out[hdr + i - RTP_FIXED_HEADER]! ^= packet[i]!;
  }
  out[0]! &= 0x3f; // R=0（非重传）、F=0（灵活掩码）

  if (format === "draft03") {
    out[8] = 1; // SSRCCount
    out.writeUInt32BE(protectedSsrc >>> 0, 12);
    out.writeUInt16BE(base, 16);
    out.writeUInt16BE(mask, 18);
  } else {
    out.writeUInt16BE(base, 8);
    out.writeUInt16BE(mask, 10);
  }
  return out;
}

/**
 * 用修复包与组内其余已收到的包恢复丢失的那个包（测试与诊断用）。
 * 组内恰好缺 1 个包时返回恢复出的完整 RTP 包，否则返回 null。
 */
export function recoverFlexfecPacket(
  fecPayload: Buffer,
  received: readonly Buffer[],
  ssrc: number,
  format: FlexfecHeaderFormat = "draft03",
): Buffer | null {
  const hdr = headerSize(format);
  const base = fecPayload.readUInt16BE(format === "draft03" ? 16 : 8);
  const mask = fecPayload.readUInt16BE(format === "draft03" ? 18 : 10);
  const protectedSeqs: number[] = [];
  for (let offset = 0; offset < FLEXFEC_MAX_GROUP; offset += 1) {
    if (mask & (1 << (14 - offset))) protectedSeqs.push((base + offset) & 0xffff);
  }
  const bySeq = new Map(received.map((packet) => [seqOf(packet), packet]));
  const missing = protectedSeqs.filter((seq) => !bySeq.has(seq));
  if (missing.length !== 1) return null;

  const work = Buffer.from(fecPayload);
  for (const seq of protectedSeqs) {
    const packet = bySeq.get(seq);
    if (!packet) continue;
    work[0]! ^= packet[0]!;
    work[1]! ^= packet[1]!;
    const bodyLength = packet.length - RTP_FIXED_HEADER;
    work[2]! ^= bodyLength >> 8;
    work[3]! ^= bodyLength & 0xff;
    for (let i = 4; i < 8; i += 1) work[i]! ^= packet[i]!;
    for (let i = RTP_FIXED_HEADER; i < packet.length; i += 1) work[hdr + i - RTP_FIXED_HEADER]! ^= packet[i]!;
  }
  const bodyLength = work.readUInt16BE(2);
  if (hdr + bodyLength > work.length) return null;
  const out = Buffer.alloc(RTP_FIXED_HEADER + bodyLength);
  out[0] = 0x80 | (work[0]! & 0x3f);
  out[1] = work[1]!;
  out.writeUInt16BE(missing[0]!, 2);
  work.copy(out, 4, 4, 8);
  out.writeUInt32BE(ssrc >>> 0, 8);
  work.copy(out, RTP_FIXED_HEADER, hdr, hdr + bodyLength);
  return out;
}
