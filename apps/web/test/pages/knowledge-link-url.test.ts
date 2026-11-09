import { describe, expect, test } from "bun:test";

import { normalizeLinkUrl } from "../../src/pages/knowledge/inline-format";

describe("normalizeLinkUrl", () => {
  test("补全协议并接受常见链接", () => {
    expect(normalizeLinkUrl("example.com/a")).toBe("https://example.com/a");
    expect(normalizeLinkUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeLinkUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(normalizeLinkUrl("localhost:3000")).toBe("https://localhost:3000");
  });
  test("本地路径与 file:// 被拒绝", () => {
    expect(normalizeLinkUrl("/Users/hong/x-benchmark-2026-11-06.html")).toBeNull();
    expect(normalizeLinkUrl("file:///Users/hong/x.html")).toBeNull();
    expect(normalizeLinkUrl("~/x.html")).toBeNull();
    expect(normalizeLinkUrl("x-benchmark-2026-11-06.html")).toBe("https://x-benchmark-2026-11-06.html");
  });
});
