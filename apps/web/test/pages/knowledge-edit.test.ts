import { describe, expect, test } from "bun:test";

import type { NotionBlockModel, NotionSegment, NotionTreeNodeView } from "@you-brain/core/http/types.js";

import {
  blocksToMarkdownText,
  canMoveBlock,
  insertAtPlacement,
  isLocalPending,
  placementOf,
  topmostSelected,
  turnIntoKindOf,
  appendBatches,
  applyTableOp,
  convertBlock,
  deleteTableColumn,
  insertTableColumn,
  isEmptyRow,
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
  pastedToLocal,
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
      "heading4",
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

  test("parseMarkdownBlocks:缩进列表变成嵌套子块,层数不限", () => {
    const blocks = parseMarkdownBlocks(
      ["- 一", "  - 一.1", "    - 一.1.1", "      - 一.1.1.1(第四层)", "  - 一.2", "- 二", "\t- 二.1(tab)"].join("\n"),
    );
    expect(blocks).toHaveLength(2);
    const first = blocks[0];
    expect(first?.children?.map((child) => child.segments[0]?.text)).toEqual(["一.1", "一.2"]);
    const level2 = first?.children?.[0]?.children;
    expect(level2?.map((child) => child.segments[0]?.text)).toEqual(["一.1.1"]);
    expect(level2?.[0]?.children?.[0]?.segments[0]?.text).toBe("一.1.1.1(第四层)");
    expect(blocks[1]?.children?.[0]?.segments[0]?.text).toBe("二.1(tab)");
    // 追加请求里同样嵌套
    const append = pastedToAppend(blocks);
    expect(append[0]?.children?.[0]?.children).toHaveLength(1);
  });

  test("parseMarkdownBlocks:GFM 表格变成一个 table 块", () => {
    const blocks = parseMarkdownBlocks(
      [
        "按每个文件的首要问题统计:",
        "| 问题 | 文件数 | 具体含义 |",
        "|---|---:|---|",
        "| Excel 无对应协议 | 4,124 | **找不到**。 |",
        "| 管道 \\| 转义 | 1 |",
        "| 多列 | 2 | 三 | 多出来的列 |",
        "| 换行 | 3 | 甲<br>乙 |",
        "",
        "表格后的段落",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table", "paragraph"]);
    const table = blocks[1]?.table;
    expect(table?.hasHeader).toBe(true);
    const text = (cell: NotionSegment[] | undefined): string => (cell ?? []).map((segment) => segment.text).join("");
    expect(table?.rows.map((row) => row.map(text))).toEqual([
      ["问题", "文件数", "具体含义"],
      ["Excel 无对应协议", "4,124", "找不到。"],
      ["管道 | 转义", "1", ""],
      ["多列", "2", "三"],
      ["换行", "3", "甲\n乙"],
    ]);
    expect(table?.rows[1]?.[2]?.[0]?.bold).toBe(true);
    // 追加请求带上表格行;本地乐观块也是 table
    expect(pastedToAppend(blocks)[1]).toMatchObject({ kind: "table", table: { hasHeader: true } });
    let next = 0;
    const local = pastedToLocal(blocks, () => `local-${(next += 1)}`);
    expect(local[1]).toMatchObject({ kind: "table", hasHeader: true, children: [] });
  });

  test("parseMarkdownBlocks:没有分隔行、或列数不一致的 | 行仍是段落", () => {
    expect(parseMarkdownBlocks(["a | b", "c | d"].join("\n")).map((block) => block.kind)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect(parseMarkdownBlocks(["| a | b |", "|---|"].join("\n")).map((block) => block.kind)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    // 不带首尾 | 的表格也认
    expect(parseMarkdownBlocks(["a | b", "--- | :---:", "1 | 2"].join("\n"))[0]?.table?.rows).toHaveLength(2);
  });

  test("appendBatches:顶层 100 个一批,含表格行时总数不超过 1000", () => {
    const para = { kind: "paragraph" as const, markdown: "x" };
    expect(appendBatches(Array.from({ length: 250 }, () => para)).map((batch) => batch.length)).toEqual([100, 100, 50]);
    const row = [[{ text: "1", href: null, bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }]];
    const table = { kind: "table" as const, markdown: "", table: { hasHeader: true, rows: Array.from({ length: 400 }, () => row) } };
    // 表格一次只带 100 行(其余 core 续写),权重 101:9 个表格 909,第 10 个放不下
    expect(appendBatches([...Array.from({ length: 10 }, () => table), para]).map((batch) => batch.length)).toEqual([9, 2]);
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
    // 第一个块没有上一个兄弟;子树再深也能整棵缩进(core 逐层重建)
    expect(indentIn(tree, "a")).toBeNull();
    const deep = [para("x", "X"), para("y", "Y", [para("y1", "Y1", [para("y2", "Y2")])])];
    expect(indentIn(deep, "y")?.parentId).toBe("x");
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

describe("表格编辑(本地应用)", () => {
  const cell = (text: string) => plainSegments(text);
  const table = (rows: string[][]): Extract<NotionBlockModel, { kind: "table" }> => ({
    id: "t",
    children: [],
    kind: "table",
    hasHeader: true,
    rows: rows.map((row) => row.map(cell)),
  });
  const texts = (model: Extract<NotionBlockModel, { kind: "table" }>) =>
    model.rows.map((row) => row.map((c) => c.map((s) => s.text).join("")));

  test("改行、插行(含最前)、删行、切表头;行宽对齐列数", () => {
    let model = table([["h1", "h2"], ["a", "b"]]);
    model = applyTableOp(model, { op: "update-row", rowIndex: 1, cells: [cell("A")] });
    model = applyTableOp(model, { op: "insert-row", afterIndex: 1, cells: [] });
    model = applyTableOp(model, { op: "insert-row", afterIndex: -1, cells: [cell("最前"), cell("x"), cell("多余")] });
    expect(texts(model)).toEqual([["最前", "x"], ["h1", "h2"], ["A", ""], ["", ""]]);
    model = applyTableOp(model, { op: "delete-row", rowIndex: 0 });
    model = applyTableOp(model, { op: "set-header", hasRowHeader: true });
    expect(texts(model)).toEqual([["h1", "h2"], ["A", ""], ["", ""]]);
    expect(model.hasRowHeader).toBe(true);
    // 只剩一行时不删
    expect(applyTableOp(table([["x"]]), { op: "delete-row", rowIndex: 0 }).rows).toHaveLength(1);
  });

  test("增删列:插在指定列右侧、删除指定列,最后一列不删", () => {
    const rows = table([["a", "b"], ["1", "2"]]).rows;
    const wide = insertTableColumn(rows, 0);
    expect(wide.map((row) => row.map((c) => c.map((s) => s.text).join("")))).toEqual([["a", "", "b"], ["1", "", "2"]]);
    expect(deleteTableColumn(rows, 1).map((row) => row.length)).toEqual([1, 1]);
    expect(deleteTableColumn(deleteTableColumn(rows, 1), 0).map((row) => row.length)).toEqual([1, 1]);
    expect(isEmptyRow([[], cell(" ")])).toBe(true);
    expect(isEmptyRow([cell("x")])).toBe(false);
  });

  test("块位置:placementOf / insertAtPlacement 往返,topmostSelected 去掉子孙", () => {
    const tree = [para("a", "A", [para("a1", "A1"), para("a2", "A2")]), para("b", "B")];
    expect(placementOf(tree, "a2")).toEqual({ parentId: "a", afterId: "a1" });
    expect(placementOf(tree, "a1")).toEqual({ parentId: "a", afterId: null });
    expect(placementOf(tree, "b")).toEqual({ parentId: null, afterId: "a" });
    const removed = removeBlockIn(tree, "a1");
    const back = insertAtPlacement(removed, { parentId: "a", afterId: null }, [para("a1", "A1")]);
    expect(back[0]?.children.map((block) => block.id)).toEqual(["a1", "a2"]);
    expect(topmostSelected(tree, new Set(["a2", "a", "b"]))).toEqual(["a", "b"]);
  });

  test("复制为 Markdown:格式、嵌套、编号、表格、公式", () => {
    const bold = { ...plainSegments("粗")[0]!, bold: true };
    const tree: NotionBlockModel[] = [
      makeLocalBlock("h", "heading2", plainSegments("标题")),
      { ...makeLocalBlock("n1", "numbered", [bold]), children: [makeLocalBlock("c", "bulleted", plainSegments("子"))] },
      makeLocalBlock("n2", "numbered", plainSegments("二")),
      { id: "t", children: [], kind: "table", hasHeader: true, rows: [[plainSegments("a"), plainSegments("b")], [plainSegments("1"), plainSegments("2")]] },
      { id: "e", children: [], kind: "equation", expression: "E=mc^2" },
    ];
    expect(blocksToMarkdownText(tree).split("\n")).toEqual([
      "## 标题",
      "1. **粗**",
      "    - 子",
      "2. 二",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "$$E=mc^2$$",
    ]);
  });

  test("新块类型:标题 4、可折叠标题、占位块与只读块", () => {
    const h4 = makeLocalBlock("h4", "heading4", plainSegments("x"));
    expect(h4.kind === "heading" ? h4.level : 0).toBe(4);
    const toggle = makeLocalBlock("t", "toggleHeading2");
    expect(turnIntoKindOf(toggle)).toBe("toggleHeading2");
    expect(isLocalPending({ id: "local-9", children: [], kind: "image", url: "", caption: [] })).toBe(true);
    expect(isLocalPending({ id: "local-9", children: [], kind: "image", url: "https://x/y.png", caption: [] })).toBe(false);
    expect(canMoveBlock({ id: "p", children: [{ id: "c", children: [], kind: "child_page", title: "", pageId: "c" }], kind: "toggle", segments: [] })).toBe(false);
    expect(canMoveBlock({ id: "img", children: [], kind: "image", url: "https://x/y.png", caption: [] })).toBe(true);
    // 转类型保留块颜色
    const colored = { ...makeLocalBlock("p", "paragraph", plainSegments("x")), color: "red" };
    expect(convertBlock(colored, "heading1").color).toBe("red");
    // 粘贴 Markdown:图片与公式块
    expect(parseMarkdownBlocks("![图](https://e.com/a.png)\n$$x^2$$").map((block) => block.kind)).toEqual(["image", "equation"]);
  });
});
