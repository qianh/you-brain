import { describe, expect, it } from "bun:test";

import { UlidSchema, isUlid, ulid, ulidTimestamp } from "../src/index.js";

describe("ulid", () => {
  it("encodes the timestamp in the first 10 characters", () => {
    expect(ulid(0).slice(0, 10)).toBe("0000000000");
    expect(ulid(1).slice(0, 10)).toBe("0000000001");
    expect(ulid(32).slice(0, 10)).toBe("0000000010");
    expect(ulid(1_469_918_176_385).slice(0, 10)).toBe("01ARYZ6S41");
    expect(ulidTimestamp(ulid(1_469_918_176_385))).toBe(1_469_918_176_385);
    expect(ulid(1_000) < ulid(2_000)).toBe(true);
  });

  it("uses Crockford base32 and rejects bad timestamps", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 100; index += 1) ids.add(ulid(1_700_000_000_000));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(isUlid(id)).toBe(true);
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(UlidSchema.parse(id)).toBe(id);
    }
    expect(isUlid("01ARYZ6S410001EK3Z5ZOOOOOO")).toBe(false);
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(() => UlidSchema.parse("not-a-ulid")).toThrow();
    expect(() => ulid(-1)).toThrow();
    expect(() => ulid(1.5)).toThrow();
    expect(() => ulid(2 ** 48)).toThrow();
  });
});
