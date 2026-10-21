import { describe, expect, test } from "bun:test";

import { duplicateMessageKeys, en, messageCatalogs, zh } from "../../src/i18n/messages.js";
import { devOverlayAllowed } from "../../src/lib/dev-overlay.js";

describe("messages", () => {
  test("keeps Chinese and English keys aligned", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const catalog of messageCatalogs) {
      expect(Object.keys(catalog.zh).sort()).toEqual(Object.keys(catalog.en).sort());
    }
  });

  test("rejects a key that appears in two catalogs", () => {
    expect(duplicateMessageKeys(messageCatalogs)).toEqual([]);
    expect(duplicateMessageKeys([
      { name: "a", zh: { hello: "你好" }, en: { hello: "Hello" } },
      { name: "b", zh: { hello: "嗨" }, en: { hello: "Hi" } },
    ])).toEqual(["hello"]);
  });
});

describe("devOverlayAllowed", () => {
  test("allows the switch in dev and on the design page only", () => {
    expect(devOverlayAllowed("/today", true)).toBe(true);
    expect(devOverlayAllowed("/today", false)).toBe(false);
    expect(devOverlayAllowed("/_design", false)).toBe(true);
  });
});
