import { describe, expect, test } from "bun:test";

import type { NotionBlockModel, NotionTreeNodeView } from "@you-brain/core/http/types.js";

import {
  convertBlock,
  blockToAppend,
  canDropPage,
  moveNodeIn,
  indentIn,
  insertAfterIn,
  isLocalId,
  locateNewBlockId,
  locateNewBlockIds,
  parseMarkdownBlocks,
  makeLocalBlock,
  markdownShortcutKind,
  outdentIn,
  pairBlockIds,
  pastedToAppend,
  plainSegments,
  remapBlockIds,
  removeBlockIn,
  updateBlockIn,
  withSegments,
} from "../../src/pages/knowledge/logic.js";

const para = (id: string, text: string, children: NotionBlockModel[] = []): NotionBlockModel => ({
  ...makeLocalBlock(id, "paragraph", plainSegments(text)),
  children,
});

describe("knowledge 乐观编辑", () => {
  test("insertAfterIn 能插到嵌套层的兄弟之后,afterId 为 null 追加到末尾", () => {
    const tree = [para("a", "A", [para("a1", "A1")]), para("b", "B")];
    const nested = insertAfterIn(tree, "a1", para("n", "N"));
    expect(nested[0]?.children.map((block) => block.id)).toEqual(["a1", "n"]);
    expect(insertAfterIn(tree, null, para("n", "N")).map((block) => block.id)).toEqual(["a", "b", "n"]);
    expect(insertAfterIn(tree, "a", para("n", "N")).map((block) => block.id)).toEqual(["a", "n", "b"]);
  });

  test("updateBlockIn 只复制路径,其余块引用不变", () => {
    const tree = [para("a", "A", [para("a1", "A1")]), para("b", "B")];
    const next = updateBlockIn(tree, "a1", (block) => withSegments(block, plainSegments("X")));
    expect(next[1]).toBe(tree[1]!);
    expect(next[0]).not.toBe(tree[0]!);
    expect(updateBlockIn(tree, "missing", (block) => block)).toBe(tree);
  });

  test("removeBlockIn 删掉嵌套块", () => {
    const tree = [para("a", "A", [para("a1", "A1")]), para("b", "B")];
    expect(removeBlockIn(tree, "a1")[0]?.children).toEqual([]);
    expect(removeBlockIn(tree, "b").map((block) => block.id)).toEqual(["a"]);
  });

  test("convertBlock 保留文本、子块与勾选,代码块往返", () => {
    const todo = { ...makeLocalBlock("t", "todo", plainSegments("买菜")), children: [para("c", "C")] } as NotionBlockModel;
    if (todo.kind !== "todo") throw new Error("unreachable");
    todo.checked = true;
    const heading = convertBlock(todo, "heading2");
    expect(heading).toMatchObject({ kind: "heading", level: 2, id: "t" });
    expect(heading.children).toHaveLength(1);
    const code = convertBlock(heading, "code");
    expect(code).toMatchObject({ kind: "code", text: "买菜" });
    expect(convertBlock(code, "paragraph")).toMatchObject({ kind: "paragraph", segments: [{ text: "买菜" }] });
    expect(convertBlock(todo, "todo")).toMatchObject({ kind: "todo", checked: true });
  });

  test("remapBlockIds 把服务端 id 换回本地 id", () => {
    const server = [para("real-1", "A", [para("real-2", "B")])];
    const mapped = remapBlockIds(server, new Map([["real-1", "local-1"]]));
    expect(mapped[0]?.id).toBe("local-1");
    expect(mapped[0]?.children[0]?.id).toBe("real-2");
  });

  test("locateNewBlockId 取 after 之后的同层兄弟;null 取页面末块", () => {
    const tree = [para("a", "A", [para("a1", "A1"), para("a2", "A2")]), para("b", "B")];
    expect(locateNewBlockId(tree, "a")).toBe("b");
    expect(locateNewBlockId(tree, "a1")).toBe("a2");
    expect(locateNewBlockId(tree, "b")).toBeNull();
    expect(locateNewBlockId(tree, null)).toBe("b");
    expect(locateNewBlockId([], null)).toBeNull();
  });

  test("isLocalId", () => {
    expect(isLocalId("local-3")).toBe(true);
    expect(isLocalId("1f2e3d")).toBe(false);
  });

  test("markdownShortcutKind:符号 + 空格转块,其余不动", () => {
    expect(markdownShortcutKind("# ")).toBe("heading1");
    expect(markdownShortcutKind("## ")).toBe("heading2");
    expect(markdownShortcutKind("### ")).toBe("heading3");
    expect(markdownShortcutKind("- ")).toBe("bulleted");
    expect(markdownShortcutKind("* ")).toBe("bulleted");
    expect(markdownShortcutKind("1. ")).toBe("numbered");
    expect(markdownShortcutKind("12) ")).toBe("numbered");
    expect(markdownShortcutKind("[] ")).toBe("todo");
    expect(markdownShortcutKind("[ ] ")).toBe("todo");
    expect(markdownShortcutKind("> ")).toBe("toggle");
    expect(markdownShortcutKind("- ")).toBe("bulleted");
    expect(markdownShortcutKind("#### ")).toBeNull();
    expect(markdownShortcutKind("hello ")).toBeNull();
    expect(markdownShortcutKind("- a ")).toBeNull();
    expect(markdownShortcutKind("-")).toBeNull();
  });

  test("locateNewBlockIds 取 after 之后连续 count 个兄弟", () => {
    const tree = [para("a", "A"), para("n1", "1"), para("n2", "2"), para("b", "B")];
    expect(locateNewBlockIds(tree, "a", 2)).toEqual(["n1", "n2"]);
    expect(locateNewBlockIds(tree, null, 2)).toEqual(["n2", "b"]);
  });

  test("parseMarkdownBlocks:用户贴的合同比对笔记", () => {
    const blocks = parseMarkdownBlocks(
      [
        "*环世应收*：PROC-F495",
        "*环世应付*：PROC-EA54",
        "",
        "**TODO**:",
        "1. 历史模板用错的",
        "2. 历史失败或者没有结果的",
        "",
        "**遗留问题**:",
        "1. 特殊 Word 编号格式仍不支持",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "numbered",
      "numbered",
      "paragraph",
      "numbered",
    ]);
    expect(blocks[0]?.segments[0]).toMatchObject({ text: "环世应收", italic: true });
    expect(blocks[2]?.segments[0]).toMatchObject({ text: "TODO", bold: true });
    expect(blocks[3]?.segments).toMatchObject([{ text: "历史模板用错的" }]);
  });

  test("parseMarkdownBlocks:标题/列表/待办/引用/围栏/分隔线", () => {
    const blocks = parseMarkdownBlocks(
      ["# 一", "### 三", "#### 四", "- a", "* b", "- [ ] 待办", "- [x] 已办", "> 引", "---", "```ts", "const a = 1;", "", "x", "```", "尾"].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading1",
      "heading3",
      "heading3",
      "bulleted",
      "bulleted",
      "todo",
      "todo",
      "quote",
      "divider",
      "code",
      "paragraph",
    ]);
    expect(blocks[5]?.checked).toBe(false);
    expect(blocks[6]?.checked).toBe(true);
    expect(blocks[9]).toMatchObject({ text: "const a = 1;\n\nx", language: "ts" });
  });

  test("parseMarkdownBlocks:纯文本单行是一个段落,空输入没有块", () => {
    expect(parseMarkdownBlocks("hello")).toHaveLength(1);
    expect(parseMarkdownBlocks("  \n\n")).toEqual([]);
  });

  test("parseMarkdownBlocks:缩进列表变成嵌套子块,最多两层", () => {
    const blocks = parseMarkdownBlocks(
      ["- 一", "  - 一.1", "    - 一.1.1", "      - 一.1.1.1(超深并入第二层)", "  - 一.2", "- 二", "\t- 二.1(tab)"].join("\n"),
    );
    expect(blocks).toHaveLength(2);
    const first = blocks[0];
    expect(first?.children?.map((child) => child.segments[0]?.text)).toEqual(["一.1", "一.2"]);
    const level2 = first?.children?.[0]?.children;
    expect(level2?.map((child) => child.segments[0]?.text)).toEqual(["一.1.1", "一.1.1.1(超深并入第二层)"]);
    expect(level2?.every((child) => !child.children)).toBe(true);
    expect(blocks[1]?.children?.[0]?.segments[0]?.text).toBe("二.1(tab)");
    // 追加请求里同样嵌套
    const append = pastedToAppend(blocks);
    expect(append[0]?.children?.[0]?.children).toHaveLength(2);
  });

  test("parseMarkdownBlocks:标题后的缩进行不挂到标题下;开头的缩进行是顶层", () => {
    const blocks = parseMarkdownBlocks(["  - 开头缩进", "# 标题", "  - 缩进"].join("\n"));
    expect(blocks.map((block) => block.kind)).toEqual(["bulleted", "heading1", "bulleted"]);
    expect(blocks.every((block) => !block.children)).toBe(true);
  });

  test("indentIn / outdentIn", () => {
    const tree = [para("a", "A", [para("a1", "A1")]), para("b", "B", [para("b1", "B1")]), para("c", "C")];
    const indented = indentIn(tree, "b");
    expect(indented?.parentId).toBe("a");
    expect(indented?.blocks.map((block) => block.id)).toEqual(["a", "c"]);
    expect(indented?.blocks[0]?.children.map((block) => block.id)).toEqual(["a1", "b"]);
    // 第一个块没有上一个兄弟;子树已两层的不能再缩进
    expect(indentIn(tree, "a")).toBeNull();
    const deep = [para("x", "X"), para("y", "Y", [para("y1", "Y1", [para("y2", "Y2")])])];
    expect(indentIn(deep, "y")).toBeNull();
    // 标题上一个兄弟不能带子块
    const withHeading = [makeLocalBlock("h", "heading1", plainSegments("H")), para("p", "P")];
    expect(indentIn(withHeading, "p")).toBeNull();

    const out = outdentIn(tree, "a1");
    expect(out?.afterId).toBe("a");
    expect(out?.blocks.map((block) => block.id)).toEqual(["a", "a1", "b", "c"]);
    expect(out?.blocks[0]?.children).toEqual([]);
    expect(outdentIn(tree, "c")).toBeNull();
  });

  test("blockToAppend 带整棵子树;不支持的块返回 null", () => {
    const tree = para("a", "A", [para("a1", "A1")]);
    expect(blockToAppend(tree)).toMatchObject({ kind: "paragraph", children: [{ kind: "paragraph" }] });
    const image: NotionBlockModel = { id: "i", kind: "image", url: "u", caption: [], children: [] };
    expect(blockToAppend({ ...tree, children: [image] })).toBeNull();
  });

  test("pairBlockIds 按位置配对整棵树", () => {
    const local = [para("l1", "A", [para("l2", "B")]), para("l3", "C")];
    const server = [para("s1", "A", [para("s2", "B")]), para("s3", "C")];
    expect(pairBlockIds(local, server)).toEqual([
      ["l1", "s1"],
      ["l2", "s2"],
      ["l3", "s3"],
    ]);
  });

  test("canDropPage / moveNodeIn:侧栏拖拽移动页面", () => {
    const node = (id: string, title: string, children: NotionTreeNodeView[] = [], object: "page" | "database" = "page"): NotionTreeNodeView => ({
      id,
      object,
      title,
      icon: null,
      children,
    });
    const roots = [
      node("a", "甲", [node("a1", "甲一", [node("a11", "甲一一")])]),
      node("b", "乙"),
      node("db", "表", [], "database"),
    ];
    expect(canDropPage(roots, "b", "a")).toBe(true);
    expect(canDropPage(roots, "a", "a")).toBe(false);
    // 不能进自己的子孙
    expect(canDropPage(roots, "a", "a11")).toBe(false);
    // 已经在那里
    expect(canDropPage(roots, "a1", "a")).toBe(false);
    // 数据库既不能被拖,也不能做目标
    expect(canDropPage(roots, "db", "a")).toBe(false);
    expect(canDropPage(roots, "b", "db")).toBe(false);
    expect(canDropPage(roots, "x", "a")).toBe(false);

    const moved = moveNodeIn(roots, "b", "a1");
    expect(moved.map((entry) => entry.id)).toEqual(["a", "db"]);
    expect(moved[0]?.children[0]?.children.map((entry) => entry.id).sort()).toEqual(["a11", "b"]);
    // 带子树整体移动
    const moved2 = moveNodeIn(roots, "a1", "b");
    expect(moved2[0]?.children).toEqual([]);
    expect(moved2[1]?.children[0]?.children[0]?.id).toBe("a11");
  });
});
