import { randomBytes } from "node:crypto";

import { z } from "zod";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const MAX_TIME = 2 ** 48 - 1;

export function isUlid(value: string): boolean {
  if (value.length !== TIME_LENGTH + RANDOM_LENGTH) return false;
  for (const character of value) {
    if (!ALPHABET.includes(character)) return false;
  }
  return true;
}

export const UlidSchema = z.string().refine(isUlid, "Invalid ULID");

function digitAt(index: number): string {
  const digit = ALPHABET[index];
  if (digit === undefined) throw new Error("ULID encoding failed");
  return digit;
}

export function ulidTimestamp(id: string): number {
  if (!isUlid(id)) throw new Error("Invalid ULID");
  let timestamp = 0;
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    const character = id[index];
    if (character === undefined) throw new Error("Invalid ULID");
    const value = ALPHABET.indexOf(character);
    if (value < 0) throw new Error("Invalid ULID");
    timestamp = timestamp * 32 + value;
  }
  return timestamp;
}

function encodeTime(timestamp: number): string {
  let value = timestamp;
  const chars: string[] = Array.from({ length: TIME_LENGTH }, () => "");
  for (let index = TIME_LENGTH - 1; index >= 0; index -= 1) {
    chars[index] = digitAt(value % 32);
    value = Math.floor(value / 32);
  }
  if (value !== 0) throw new Error("ULID timestamp out of range");
  return chars.join("");
}

function encodeRandom(): string {
  const bytes = randomBytes(10);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  const chars: string[] = Array.from({ length: RANDOM_LENGTH }, () => "");
  for (let index = RANDOM_LENGTH - 1; index >= 0; index -= 1) {
    chars[index] = digitAt(Number(value & 31n));
    value >>= 5n;
  }
  return chars.join("");
}

export function ulid(timestamp = Date.now()): string {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIME) {
    throw new Error("ULID timestamp out of range");
  }
  return encodeTime(timestamp) + encodeRandom();
}
