import { describe, expect, test } from "bun:test";

import { extractToc, isSafeHref, parseInline, parseMarkdown, shouldShowToc, slugify } from "../../src/lib/markdown.js";

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
    expect(parseInline("[点我](javascript:alert(1))").some((node) => node.kind === "link")).toBe(false);
  });

  test("rejects unsafe schemes, control characters, and blank hrefs", () => {
    expect(isSafeHref("https://example.com/a")).toBe(true);
    expect(isSafeHref("HTTP://example.com/a")).toBe(true);
    expect(isSafeHref("mailto:john@example.com")).toBe(true);
    expect(isSafeHref("MAILTO:john@example.com")).toBe(true);
    expect(isSafeHref(" javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,hi")).toBe(false);
    expect(isSafeHref("https://exa\nmple.com")).toBe(false);
    expect(isSafeHref("https://example.com/\u0000x")).toBe(false);
    expect(isSafeHref("   ")).toBe(false);
  });

  test("keeps raw HTML as text", () => {
    const nodes = parseInline("<script>alert(1)</script>");
    expect(nodes).toEqual([{ kind: "text", text: "<script>alert(1)</script>" }]);
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
    expect(blocks[0]).toEqual({ kind: "heading", level: 1, text: "编码偏好", id: "编码偏好" });
    expect(blocks[2]).toEqual({ kind: "list", ordered: false, items: ["中文回复", "不写 README"] });
    expect(blocks[3]).toEqual({ kind: "code", text: "bun test" });
  });

  test("numbers duplicate heading ids and hides a short table of contents", () => {
    const blocks = parseMarkdown(["# 工作方式", "", "## 工作方式", "", "### !!!"].join("\n"));
    expect(extractToc(blocks)).toEqual([
      { id: "工作方式", level: 1, text: "工作方式" },
      { id: "工作方式-2", level: 2, text: "工作方式" },
      { id: "section", level: 3, text: "!!!" },
    ]);
    expect(shouldShowToc(extractToc(blocks))).toBe(true);
    expect(shouldShowToc(extractToc(parseMarkdown("# 只有一个")))).toBe(false);
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("parses tables, task lists, fenced languages, and the version line", () => {
    const blocks = parseMarkdown(
      [
        "# 编码偏好",
        "",
        "v1.3.3 · 2026-10-19",
        "",
        "| 左 | 中 | 右 |",
        "| :--- | :---: | ---: |",
        "| a | b | c |",
        "",
        "- [ ] 待办",
        "- [x] 完成",
        "- [X] 也完成",
        "",
        "- 普通",
        "",
        "```ts",
        "const n = 1;",
        "```",
        "",
        "```not a lang",
        "plain",
        "```",
        "",
        "a | b",
        "",
        "---",
      ].join("\n"),
    );
    expect(blocks[1]).toEqual({ kind: "paragraph", text: "v1.3.3 · 2026-10-19", meta: true });
    expect(blocks[2]).toEqual({
      kind: "table",
      text: "左 | 中 | 右\na | b | c",
      header: ["左", "中", "右"],
      rows: [["a", "b", "c"]],
      align: ["left", "center", "right"],
    });
    expect(blocks[3]).toEqual({
      kind: "list",
      ordered: false,
      items: ["待办", "完成", "也完成"],
      checks: [false, true, true],
    });
    expect(blocks[4]).toEqual({ kind: "list", ordered: false, items: ["普通"] });
    expect(blocks[5]).toEqual({ kind: "code", text: "const n = 1;", lang: "ts" });
    expect(blocks[6]).toEqual({ kind: "code", text: "plain" });
    expect(blocks[7]).toEqual({ kind: "paragraph", text: "a | b" });
    expect(blocks[8]).toEqual({ kind: "rule" });
  });

  test("does not mark a long or non-version paragraph as meta", () => {
    const long = `v1 ${"字".repeat(200)}`;
    const blocks = parseMarkdown(["# 标题", "", long, "", "普通段"].join("\n"));
    expect(blocks[1]).toEqual({ kind: "paragraph", text: long });
    expect(blocks[2]).toEqual({ kind: "paragraph", text: "普通段" });
  });

  test("keeps script and unsafe links out of the block structure", () => {
    const blocks = parseMarkdown(
      ["<script>alert(1)</script>", "", "[x](javascript:alert(1))", "", "[y](data:text/html,hi)"].join("\n"),
    );
    expect(blocks.map((block) => (block.kind === "paragraph" ? block.text : block.kind))).toEqual([
      "<script>alert(1)</script>",
      "[x](javascript:alert(1))",
      "[y](data:text/html,hi)",
    ]);
    expect(JSON.stringify(blocks)).not.toContain('"kind":"link"');
  });
});

describe("extractToc 按前缀聚合", () => {
  const blocks = parseMarkdown(
    ["# 项目决定", "", "## ashare-ledger · 定位", "内容a", "", "## ashare-ledger · 估值", "内容b", "", "## GM2主订单", "内容c", "", "## 单独 · 只出现一次", "内容d"].join("\n"),
  );

  test("出现两次以上的前缀成为虚拟父项,子项缩进", () => {
    const toc = extractToc(blocks);
    expect(toc[0]).toEqual({ id: expect.any(String), level: 1, text: "项目决定" });
    // ashare-ledger 父项(虚拟,锚到第一条)
    expect(toc[1]).toMatchObject({ text: "ashare-ledger", level: 2, virtual: true });
    expect(toc[2]).toMatchObject({ text: "定位", level: 3 });
    expect(toc[3]).toMatchObject({ text: "估值", level: 3 });
    expect(toc[1]?.id).toBe(toc[2]?.id);
    // 单条与无分隔的不聚合
    expect(toc[4]).toMatchObject({ text: "GM2主订单", level: 2 });
    expect(toc[5]).toMatchObject({ text: "单独 · 只出现一次", level: 2 });
  });
});
