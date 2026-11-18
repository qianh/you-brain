// Adapted from Meta's muse-gadget-sdk (Apache-2.0).
import { randomBytes } from "node:crypto";

import { MuseProtocolError } from "./errors.js";

type ProtoValue = bigint | Buffer;

export function varint(value: bigint | number): Buffer {
  let n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) throw new MuseProtocolError("无效的 protobuf 整数");
  const out: number[] = [];
  while (n >= 128n) {
    out.push(Number(n & 127n) | 128);
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

export function integer(field: number, value: bigint | number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

export function bytes(field: number, value: Uint8Array | string): Buffer {
  const data = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
}

export function fields(data: Buffer): Map<number, ProtoValue[]> {
  const result = new Map<number, ProtoValue[]>();
  let offset = 0;
  function read(): bigint {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
      const b = data[offset++];
      if (b === undefined || (i === 9 && b > 1)) throw new MuseProtocolError("无效的 protobuf varint");
      n |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return n;
    }
    throw new MuseProtocolError("无效的 protobuf varint");
  }
  while (offset < data.length) {
    const key = read();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field < 1 || field > 0x1fffffff || (field >= 19000 && field <= 19999)) {
      throw new MuseProtocolError("无效的 protobuf 字段编号");
    }
    let value: ProtoValue;
    if (wire === 0) {
      value = read();
    } else if (wire === 2 || wire === 1 || wire === 5) {
      const size = wire === 2 ? read() : BigInt(wire === 1 ? 8 : 4);
      if (size > BigInt(data.length - offset)) throw new MuseProtocolError("截断的 protobuf 字段");
      value = data.subarray(offset, offset + Number(size));
      offset += Number(size);
      if (wire !== 2) continue;
    } else {
      throw new MuseProtocolError("不支持的 protobuf wire 类型");
    }
    const list = result.get(field) ?? [];
    list.push(value);
    result.set(field, list);
  }
  return result;
}

export function getBytes(message: Map<number, ProtoValue[]>, field: number): Buffer {
  const value = message.get(field)?.at(-1);
  if (value === undefined) return Buffer.alloc(0);
  if (!Buffer.isBuffer(value)) throw new MuseProtocolError("预期 protobuf 字节字段");
  return value;
}

export function getInt(message: Map<number, ProtoValue[]>, field: number, fallback = 0n): bigint {
  const value = message.get(field)?.at(-1);
  if (value === undefined) return fallback;
  if (typeof value !== "bigint") throw new MuseProtocolError("预期 protobuf 整数字段");
  return value;
}

export interface ResponseFrame {
  streamId: number;
  kind: "response" | "chunk" | "reset";
  status?: number;
  body: Buffer;
  end: boolean;
  reason?: string;
}

export function requestFrame(
  id: number,
  method: string,
  path: string,
  body: Buffer,
  headers: Record<string, string>,
  end = true,
): Buffer {
  const request = Buffer.concat([
    bytes(1, method),
    bytes(2, path),
    ...Object.entries(headers).map(([k, v]) => bytes(3, Buffer.concat([bytes(1, k), bytes(2, v)]))),
    bytes(4, body),
    integer(5, Number(end)),
  ]);
  return bytes(2, Buffer.concat([integer(1, id), bytes(2, request)]));
}

export function bodyChunkFrame(id: number, body: Buffer, end: boolean): Buffer {
  return bytes(
    2,
    Buffer.concat([integer(1, id), bytes(4, Buffer.concat([bytes(1, body), integer(2, Number(end))]))]),
  );
}

export function resetFrame(id: number): Buffer {
  return bytes(2, Buffer.concat([integer(1, id), bytes(5, integer(1, 1))]));
}

export function responseFrame(data: Buffer): ResponseFrame {
  const envelope = fields(data);
  const frame = fields(getBytes(envelope, 1));
  const rawId = getInt(frame, 1);
  if (rawId < 1n || rawId > BigInt(Number.MAX_SAFE_INTEGER)) throw new MuseProtocolError("无效的流 ID");
  const streamId = Number(rawId);
  const kinds = [2, 3, 4, 5].filter((k) => frame.has(k));
  if (kinds.length !== 1) throw new MuseProtocolError("不明确的协议帧类型");
  if (frame.has(3)) {
    const response = fields(getBytes(frame, 3));
    const status = Number(getInt(response, 1));
    if (status < 100 || status > 599) throw new MuseProtocolError("无效的 HTTP 状态码");
    return { streamId, kind: "response", status, body: getBytes(response, 3), end: getInt(response, 4) !== 0n };
  }
  if (frame.has(4)) {
    const chunk = fields(getBytes(frame, 4));
    return { streamId, kind: "chunk", body: getBytes(chunk, 1), end: getInt(chunk, 2) !== 0n };
  }
  if (frame.has(5)) {
    const reset = fields(getBytes(frame, 5));
    return { streamId, kind: "reset", body: Buffer.alloc(0), end: true, reason: getBytes(reset, 2).toString() };
  }
  throw new MuseProtocolError("意外的服务端请求帧");
}

const MAX_CHUNK = 65489;

export function frameChunks(data: Buffer, id = randomBytes(8).readBigUInt64BE()): Buffer[] {
  const total = Math.max(1, Math.ceil(data.length / MAX_CHUNK));
  if (total > 256) throw new MuseProtocolError("Noise 消息超过大小上限");
  return Array.from({ length: total }, (_, i) =>
    Buffer.concat([
      integer(1, id),
      integer(2, i),
      integer(3, total),
      bytes(4, data.subarray(i * MAX_CHUNK, (i + 1) * MAX_CHUNK)),
    ]),
  );
}

export class FrameAssembler {
  #pending = new Map<bigint, { total: number; chunks: Map<number, Buffer>; created: number }>();
  #dead = false;

  decode(data: Buffer): Buffer | undefined {
    if (this.#dead) throw new MuseProtocolError("Noise 解码器不可用");
    try {
      const message = fields(data);
      const id = getInt(message, 1);
      const index = Number(getInt(message, 2));
      const total = Number(getInt(message, 3, 1n));
      const payload = getBytes(message, 4);
      if (total < 1 || total > 256 || index < 0 || index >= total || payload.length > MAX_CHUNK) {
        throw new MuseProtocolError("无效的 Noise 分片");
      }
      for (const [key, value] of this.#pending) {
        if (Date.now() - value.created > 60_000) this.#pending.delete(key);
      }
      let assembly = this.#pending.get(id);
      if (!assembly) {
        if (this.#pending.size >= 16) throw new MuseProtocolError("并发待重组的 Noise 消息过多");
        assembly = { total, chunks: new Map(), created: Date.now() };
        this.#pending.set(id, assembly);
      }
      if (assembly.total !== total || assembly.chunks.has(index)) {
        throw new MuseProtocolError("Noise 分片不一致");
      }
      assembly.chunks.set(index, payload);
      if (assembly.chunks.size !== total) return undefined;
      this.#pending.delete(id);
      return Buffer.concat(Array.from({ length: total }, (_, i) => assembly.chunks.get(i)!));
    } catch (error) {
      this.#dead = true;
      this.#pending.clear();
      throw error;
    }
  }
}
