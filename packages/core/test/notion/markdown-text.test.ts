import { describe, expect, test } from "bun:test";

import { markdownToSegments, segmentsToMarkdown } from "../../src/notion/markdown-text.js";

function segment(text: string, extra: Partial<Parameters<typeof Object.assign>[0]> = {}) {
  return {
    text,
    href: null,
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
    ...extra,
  } as import("../../src/notion/model.js").NotionSegment;
}

describe("markdown round-trip", () => {
  test("纯文本原样往返", () => {
    const markdown = "第一,标准答案思维方式。";
    expect(segmentsToMarkdown([segment(markdown)])).toBe(markdown);
    expect(markdownToSegments(markdown).map((s) => s.text).join("")).toBe(markdown);
  });

  test("粗体、斜体、删除线、行内代码", () => {
    const markdown = "这是**加粗**和*斜体*与~~删除~~加`代码`";
    const back = markdownToSegments(markdown);
    expect(back.map((s) => s.text).join("")).toBe("这是加粗和斜体与删除加代码");
    expect(back.find((s) => s.bold)?.text).toBe("加粗");
    expect(back.find((s) => s.italic)?.text).toBe("斜体");
    expect(back.find((s) => s.strikethrough)?.text).toBe("删除");
    expect(back.find((s) => s.code)?.text).toBe("代码");
    expect(segmentsToMarkdown(back)).toBe(markdown);
  });

  test("链接", () => {
    const markdown = "看[这个文档](https://example.com/a)了解";
    const back = markdownToSegments(markdown);
    expect(back.find((s) => s.href === "https://example.com/a")?.text).toBe("这个文档");
    expect(segmentsToMarkdown(back)).toBe(markdown);
  });

  test("未闭合标记按纯文本处理,不丢内容", () => {
    const back = markdownToSegments("有**未闭合的星号");
    expect(back.map((s) => s.text).join("")).toBe("有**未闭合的星号");
  });

  test("相邻纯文本合并成一个 segment", () => {
    const back = markdownToSegments("**a**b**c**");
    expect(back.filter((s) => !s.bold).map((s) => s.text)).toEqual(["b"]);
  });

  test("中文与星号混排:孤立星号不误判为斜体", () => {
    const back = markdownToSegments("3 * 4 = 12,而 **真粗体** 保留");
    expect(back.map((s) => s.text).join("")).toBe("3 * 4 = 12,而 真粗体 保留");
    expect(back.find((s) => s.bold)?.text).toBe("真粗体");
  });
});
