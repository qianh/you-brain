import { describe, expect, test } from "bun:test";

import { isSafeHref, parseInline, parseMarkdown } from "../../src/lib/markdown.js";

describe("parseInline", () => {
  test("keeps emphasis, code, and safe links", () => {
    expect(parseInline("用 **bun** 和 `tsc`，见 [文档](https://example.com/a).")).toEqual([
      { kind: "text", text: "用 " },
      { kind: "strong", text: "bun" },
      { kind: "text", text: " 和 " },
      { kind: "code", text: "tsc" },
      { kind: "text", text: "，见 " },
      { kind: "link", text: "文档", href: "https://example.com/a" },
      { kind: "text", text: "." },
    ]);
  });

  test("does not turn javascript links into anchors", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(parseInline("[点我](javascript:alert(1))")[0]?.kind).toBe("text");
  });
});

describe("parseMarkdown", () => {
  test("parses the blocks a portrait file uses", () => {
    const blocks = parseMarkdown(
      ["# 编码偏好", "", "统一用 bun。", "", "- 中文回复", "- 不写 README", "", "```", "bun test", "```", "", "---", "", "> 先读协议"].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "code",
      "rule",
      "quote",
    ]);
    expect(blocks[2]).toEqual({ kind: "list", ordered: false, items: ["中文回复", "不写 README"] });
    expect(blocks[3]).toEqual({ kind: "code", text: "bun test" });
  });
});
