import {
  createEvent,
  type EventOf,
  type EventType,
} from "@you-brain/protocol";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let nextCounter = 1;

function digit(index: number): string {
  const value = ALPHABET[index];
  if (value === undefined) throw new Error("ULID alphabet miss");
  return value;
}

export function ulidAt(timestamp: number, counter: number): string {
  if (!Number.isInteger(timestamp) || timestamp < 0) {
    throw new Error(`ULID timestamp out of range: ${timestamp}`);
  }
  let time = timestamp;
  const head: string[] = Array.from({ length: 10 }, () => "");
  for (let index = 9; index >= 0; index -= 1) {
    head[index] = digit(time % 32);
    time = Math.floor(time / 32);
  }
  let random = counter;
  const tail: string[] = Array.from({ length: 16 }, () => "");
  for (let index = 15; index >= 0; index -= 1) {
    tail[index] = digit(random % 32);
    random = Math.floor(random / 32);
  }
  return head.join("") + tail.join("");
}

export function sessionKey(n: number): string {
  return n.toString(16).padStart(64, "0");
}

export const KEY_1 = sessionKey(1);
export const KEY_2 = sessionKey(2);
export const T0 = "2026-07-01T00:00:00.000Z";

export function plus(seconds: number, base = T0): string {
  return new Date(Date.parse(base) + seconds * 1000).toISOString();
}

export function buildEvent<T extends EventType>(input: {
  type: T;
  data: EventOf<T>["data"];
  device: string;
  ts: string;
  seq: number;
  counter?: number;
}): EventOf<T> {
  const idCounter = input.counter ?? nextCounter++;
  const tsMs = Date.parse(input.ts);
  return createEvent({
    type: input.type,
    data: input.data,
    device: input.device,
    ts: input.ts,
    seq: input.seq,
    id: ulidAt(tsMs, idCounter),
  });
}
