import { describe, expect, test } from "bun:test";

import { segmentsToRichText } from "../../src/notion/block-payload.js";

describe("segmentsToRichText", () => {
  test("带链接的段落只发 text.link,不带只读的 plain_text / href", () => {
    const [part] = segmentsToRichText([
      { text: "官网", href: "https://example.com", bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
    ]);
    expect(part).toEqual({
      type: "text",
      text: { content: "官网", link: { url: "https://example.com" } },
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
    });
  });

  test("Notion 不收的链接(file://、本地路径)退化成纯文字", () => {
    const base = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } as const;
    const parts = segmentsToRichText([
      { text: "甲", href: "file:///Users/a/b.html", ...base },
      { text: "乙", href: "/Users/a/b.html", ...base },
    ]);
    expect(parts.map((part) => part.text)).toEqual([{ content: "甲" }, { content: "乙" }]);
  });
});
