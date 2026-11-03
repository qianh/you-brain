import type { NotionBlockModel, NotionSegment, NotionTreeNodeView } from "@you-brain/core/http/types.js";
import { markdownToSegments } from "@you-brain/core/notion/markdown-text.js";

export type TurnIntoKind =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulleted"
  | "numbered"
  | "todo"
  | "quote"
  | "callout"
  | "toggle"
  | "code";

/** 「添加块」菜单的条目(divider 无文本)。 */
export const BLOCK_KINDS: Array<{ kind: TurnIntoKind | "divider"; labelKey: string }> = [
  { kind: "paragraph", labelKey: "knowledgeTypeParagraph" },
  { kind: "heading1", labelKey: "knowledgeTypeHeading1" },
  { kind: "heading2", labelKey: "knowledgeTypeHeading2" },
  { kind: "heading3", labelKey: "knowledgeTypeHeading3" },
  { kind: "bulleted", labelKey: "knowledgeTypeBulleted" },
  { kind: "numbered", labelKey: "knowledgeTypeNumbered" },
  { kind: "todo", labelKey: "knowledgeTypeTodo" },
  { kind: "quote", labelKey: "knowledgeTypeQuote" },
  { kind: "callout", labelKey: "knowledgeTypeCallout" },
  { kind: "toggle", labelKey: "knowledgeTypeToggle" },
  { kind: "code", labelKey: "knowledgeTypeCode" },
  { kind: "divider", labelKey: "knowledgeTypeDivider" },
];

/** 块的行内内容能否编辑(与 core 的 EDITABLE_KINDS 对齐)。 */
export function isEditableBlock(block: NotionBlockModel): boolean {
  return [
    "paragraph",
    "heading",
    "bulleted",
    "numbered",
    "todo",
    "quote",
    "callout",
    "toggle",
    "code",
  ].includes(block.kind);
}

/** 移动/复制需要整块复制,带子块的块会丢子树,禁止。 */
export function canMoveBlock(block: NotionBlockModel): boolean {
  return isEditableBlock(block) && block.children.length === 0;
}

/** 块文本 → 编辑框预填的 markdown(code 块是裸文本)。 */
export function blockMarkdown(block: NotionBlockModel): string {
  if (block.kind === "code") return block.text;
  const segments = segmentsOf(block);
  return segmentsToMarkdown(segments);
}

export function segmentsOf(block: NotionBlockModel): NotionSegment[] {
  switch (block.kind) {
    case "paragraph":
    case "quote":
    case "callout":
    case "toggle":
    case "bulleted":
    case "numbered":
    case "heading":
    case "todo":
      return block.segments;
    case "equation":
      return [{ text: block.expression, href: null, bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }];
    default:
      return [];
  }
}

/** 与 core 的 segmentsToMarkdown 保持同一语法(`` ` ``、**、*、~~、[text](url))。 */
export function segmentsToMarkdown(segments: readonly NotionSegment[]): string {
  let out = "";
  for (const segment of segments) {
    let text = segment.text;
    if (segment.code) text = `\`${text}\``;
    if (segment.bold) text = `**${text}**`;
    if (segment.italic) text = `*${text}*`;
    if (segment.strikethrough) text = `~~${text}~~`;
    if (segment.href) text = `[${text}](${segment.href})`;
    out += text;
  }
  return out;
}

/** 找出刷新后新增的块(用于创建后自动进入编辑)。 */
export function firstNewBlockId(
  oldBlocks: readonly NotionBlockModel[],
  newBlocks: readonly NotionBlockModel[],
): string | null {
  const known = new Set(collectIds(oldBlocks));
  const find = (models: readonly NotionBlockModel[]): string | null => {
    for (const model of models) {
      if (!known.has(model.id)) return model.id;
      const nested = find(model.children);
      if (nested) return nested;
    }
    return null;
  };
  return find(newBlocks);
}

function collectIds(models: readonly NotionBlockModel[], into: string[] = []): string[] {
  for (const model of models) {
    into.push(model.id);
    collectIds(model.children, into);
  }
  return into;
}

export interface FlatPage {
  id: string;
  title: string;
  icon: string | null;
  object: "page" | "database";
  depth: number;
}

/** Depth-first flatten of the workspace tree for the quick switcher. */
export function flattenTree(roots: readonly NotionTreeNodeView[]): FlatPage[] {
  const out: FlatPage[] = [];
  const walk = (nodes: readonly NotionTreeNodeView[], depth: number): void => {
    for (const node of nodes) {
      out.push({ id: node.id, title: node.title, icon: node.icon, object: node.object, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

export interface FuzzyResult {
  /** Subsequence score; higher is better. 0 means no match. */
  score: number;
}

/**
 * Case-insensitive subsequence match with bonuses for word starts and
 * contiguous runs, loosely modeled on Notion's quick finder.
 */
export function fuzzyScore(query: string, title: string): number {
  const q = query.toLowerCase().replace(/\s+/gu, "");
  const t = title.toLowerCase();
  if (q === "") return 1;
  if (t.includes(q)) return 100 + q.length;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const char of q) {
    const found = t.indexOf(char, ti);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak + (found === 0 || /[\s/[\]_\-–—·]/u.test(t[found - 1] ?? " ") ? 3 : 0);
    ti = found + 1;
  }
  return score;
}

export function fuzzyFilter(
  pages: readonly FlatPage[],
  query: string,
  limit = 12,
): FlatPage[] {
  if (query.trim() === "") return pages.slice(0, limit);
  return pages
    .map((page) => ({ page, score: fuzzyScore(query, page.title) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.page);
}

/** First openable page: the first root page (databases render, too, but pages read better). */
export function defaultPageId(roots: readonly NotionTreeNodeView[]): string | null {
  const first = roots[0];
  return first ? first.id : null;
}

/** Server truncated S3 URLs expire; the proxy re-resolves through the daemon. */
export function isProxyableAssetUrl(url: string): boolean {
  try {
    const host = new URL(url).host;
    return host.endsWith(".amazonaws.com") || host === "notion.so" || host.endsWith(".notion.so");
  } catch {
    return false;
  }
}

export function relativeTime(iso: string | null, now: Date, language: "zh" | "en"): string {
  if (!iso) return language === "zh" ? "从未" : "never";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "—";
  const minutes = Math.round((now.getTime() - at) / 60_000);
  if (minutes < 1) return language === "zh" ? "刚刚" : "just now";
  if (minutes < 60) return language === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return language === "zh" ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return language === "zh" ? `${days} 天前` : `${days}d ago`;
}


// —— 乐观编辑:本地块树的纯函数 ——
// 编辑先改本地块树(立刻可见、光标不动),再由串行队列写回 Notion。

const NO_FORMAT = {
  href: null,
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
} as const;

export function plainSegments(text: string): NotionSegment[] {
  return text === "" ? [] : [{ ...NO_FORMAT, text }];
}

export function segmentsText(segments: readonly NotionSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

/** 本地新建块的 id 前缀;真实 id 由队列在 Notion 返回后登记。 */
export const LOCAL_ID_PREFIX = "local-";

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

/** 带行内文本的块族(Enter 分块、转换类型都在这一族里)。 */
type TextBlock = Extract<NotionBlockModel, { segments: NotionSegment[] }>;

export function hasSegments(block: NotionBlockModel): block is TextBlock {
  return "segments" in block;
}

/** 新建一个空/带文本的本地块。 */
export function makeLocalBlock(
  id: string,
  kind: TurnIntoKind | "divider",
  segments: NotionSegment[] = [],
): NotionBlockModel {
  const base = { id, children: [] };
  switch (kind) {
    case "heading1":
      return { ...base, kind: "heading", level: 1, segments };
    case "heading2":
      return { ...base, kind: "heading", level: 2, segments };
    case "heading3":
      return { ...base, kind: "heading", level: 3, segments };
    case "bulleted":
      return { ...base, kind: "bulleted", segments };
    case "numbered":
      return { ...base, kind: "numbered", segments };
    case "todo":
      return { ...base, kind: "todo", segments, checked: false };
    case "quote":
      return { ...base, kind: "quote", segments };
    case "callout":
      return { ...base, kind: "callout", segments, emoji: "💡", color: "default" };
    case "toggle":
      return { ...base, kind: "toggle", segments };
    case "code":
      return { ...base, kind: "code", language: "plain text", text: segmentsText(segments), caption: [] };
    case "divider":
      return { ...base, kind: "divider" };
    default:
      return { ...base, kind: "paragraph", segments };
  }
}

/** 块转类型(保留 id 与子块);与 core 的 #modelForKind 同一语义。 */
export function convertBlock(block: NotionBlockModel, kind: TurnIntoKind): NotionBlockModel {
  const segments = block.kind === "code" ? plainSegments(block.text) : segmentsOf(block);
  const next = makeLocalBlock(block.id, kind, segments);
  if (next.kind === "todo" && block.kind === "todo") next.checked = block.checked;
  if (next.kind === "callout" && block.kind === "callout") {
    next.emoji = block.emoji;
    next.color = block.color;
  }
  next.children = block.children;
  return next;
}

/** 换掉块的行内文本;不带文本的块原样返回。 */
export function withSegments(block: NotionBlockModel, segments: NotionSegment[]): NotionBlockModel {
  if (!hasSegments(block)) return block;
  return { ...block, segments } as NotionBlockModel;
}

/** 在块树里按 id 改一个块(只复制路径,其余块引用不变,React 不重渲染它们)。 */
export function updateBlockIn(
  blocks: readonly NotionBlockModel[],
  id: string,
  update: (block: NotionBlockModel) => NotionBlockModel,
): NotionBlockModel[] {
  let changed = false;
  const visit = (list: readonly NotionBlockModel[]): NotionBlockModel[] =>
    list.map((block) => {
      if (block.id === id) {
        changed = true;
        return update(block);
      }
      if (block.children.length === 0) return block;
      const children = visit(block.children);
      return children.every((child, index) => child === block.children[index])
        ? block
        : { ...block, children };
    });
  const next = visit(blocks);
  return changed ? next : (blocks as NotionBlockModel[]);
}

export function removeBlockIn(blocks: readonly NotionBlockModel[], id: string): NotionBlockModel[] {
  const visit = (list: readonly NotionBlockModel[]): NotionBlockModel[] => {
    const out: NotionBlockModel[] = [];
    for (const block of list) {
      if (block.id === id) continue;
      if (block.children.length === 0) {
        out.push(block);
        continue;
      }
      const children = visit(block.children);
      out.push(children.length === block.children.length ? block : { ...block, children });
    }
    return out;
  };
  return visit(blocks);
}

/** 把 block 插到 afterId 后面(同一层);afterId 为 null 则追加到顶层末尾。 */
export function insertAfterIn(
  blocks: readonly NotionBlockModel[],
  afterId: string | null,
  block: NotionBlockModel,
): NotionBlockModel[] {
  if (afterId === null) return [...blocks, block];
  const visit = (list: readonly NotionBlockModel[]): NotionBlockModel[] | null => {
    const index = list.findIndex((entry) => entry.id === afterId);
    if (index >= 0) return [...list.slice(0, index + 1), block, ...list.slice(index + 1)];
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (!entry || entry.children.length === 0) continue;
      const children = visit(entry.children);
      if (children) return [...list.slice(0, i), { ...entry, children }, ...list.slice(i + 1)];
    }
    return null;
  };
  return visit(blocks) ?? [...blocks];
}

export function findBlockIn(
  blocks: readonly NotionBlockModel[],
  id: string,
): NotionBlockModel | null {
  for (const block of blocks) {
    if (block.id === id) return block;
    const nested = findBlockIn(block.children, id);
    if (nested) return nested;
  }
  return null;
}

/** 服务端返回的块树换回本地 id,让 React key 不变、不重挂载、不丢光标。 */
export function remapBlockIds(
  blocks: readonly NotionBlockModel[],
  serverToLocal: ReadonlyMap<string, string>,
): NotionBlockModel[] {
  return blocks.map((block) => ({
    ...block,
    id: serverToLocal.get(block.id) ?? block.id,
    children: remapBlockIds(block.children, serverToLocal),
  })) as NotionBlockModel[];
}

export function allBlockIds(blocks: readonly NotionBlockModel[]): string[] {
  return collectIds(blocks);
}

// —— Markdown 快捷输入(Notion 同款):行首输入符号 + 空格即转块类型 ——

const MARKDOWN_SHORTCUTS: ReadonlyArray<{ pattern: RegExp; kind: TurnIntoKind }> = [
  { pattern: /^#$/u, kind: "heading1" },
  { pattern: /^##$/u, kind: "heading2" },
  { pattern: /^###$/u, kind: "heading3" },
  { pattern: /^[-*+]$/u, kind: "bulleted" },
  { pattern: /^\d+[.)]$/u, kind: "numbered" },
  { pattern: /^\[\s?\]$/u, kind: "todo" },
  { pattern: /^>$/u, kind: "toggle" },
  { pattern: /^["”“]$/u, kind: "quote" },
];

/** 段落文本恰好是「符号 + 空格」时返回目标类型;其余返回 null。 */
export function markdownShortcutKind(text: string): TurnIntoKind | null {
  const match = /^(\[ ?\]|\S+)[ \u00a0]$/u.exec(text);
  const marker = match?.[1];
  if (!marker) return null;
  for (const entry of MARKDOWN_SHORTCUTS) {
    if (entry.pattern.test(marker)) return entry.kind;
  }
  return null;
}

/**
 * Notion 把新块插在 afterRealId 之后(同一层),返回该新块的真实 id;
 * afterRealId 为 null 表示追加到页面末尾。用来把本地 id 对上真实 id。
 */
export function locateNewBlockId(
  blocks: readonly NotionBlockModel[],
  afterRealId: string | null,
): string | null {
  if (afterRealId === null) return blocks[blocks.length - 1]?.id ?? null;
  const visit = (list: readonly NotionBlockModel[]): string | null => {
    const index = list.findIndex((block) => block.id === afterRealId);
    if (index >= 0) return list[index + 1]?.id ?? null;
    for (const block of list) {
      const nested = visit(block.children);
      if (nested) return nested;
    }
    return null;
  };
  return visit(blocks);
}


/** 返回 afterRealId 之后连续 count 个同层兄弟的 id(批量追加后对应各个本地块)。 */
export function locateNewBlockIds(
  blocks: readonly NotionBlockModel[],
  afterRealId: string | null,
  count: number,
): string[] {
  const siblings = (list: readonly NotionBlockModel[]): NotionBlockModel[] | null => {
    if (afterRealId === null) return [...list];
    const index = list.findIndex((block) => block.id === afterRealId);
    if (index >= 0) return list.slice(index + 1);
    for (const block of list) {
      const nested = siblings(block.children);
      if (nested) return nested;
    }
    return null;
  };
  const all = siblings(blocks) ?? [];
  const slice = afterRealId === null ? all.slice(Math.max(0, all.length - count)) : all.slice(0, count);
  return slice.map((block) => block.id);
}

// —— 粘贴 Markdown:一段多行文本 → 一组块 ——

export interface PastedBlock {
  kind: TurnIntoKind | "divider";
  segments: NotionSegment[];
  /** code 块的裸文本与语言。 */
  text?: string;
  language?: string;
  checked?: boolean;
  /** 缩进形成的子块(Notion 单次请求最多嵌两层,更深的并入第二层)。 */
  children?: PastedBlock[];
}

const HEADING_LINE = /^(#{1,6})\s+(.*)$/u;
const TODO_LINE = /^[-*+]\s+\[([ xX])\]\s+(.*)$/u;
const BULLET_LINE = /^[-*+]\s+(.*)$/u;
const NUMBER_LINE = /^\d+[.)]\s+(.*)$/u;
const QUOTE_LINE = /^>\s?(.*)$/u;
const RULE_LINE = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const FENCE_LINE = /^```\s*([\w+#-]*)\s*$/u;

/**
 * 把粘贴的 Markdown 文本拆成块:标题、列表、待办、引用、代码围栏、分隔线,
 * 其余按行成段落;行内 **粗体** *斜体* `代码` ~~删除线~~ [链接](url) 转成富文本。
 * 空行丢弃(与 Notion 粘贴一致);缩进的嵌套列表按同层处理。
 */
export function parseMarkdownBlocks(input: string): PastedBlock[] {
  const lines = input.replace(/\r\n?/gu, "\n").split("\n");
  const out: PastedBlock[] = [];
  // 缩进栈:每层是(缩进宽度, 块);新行缩进更深就挂到栈顶块下面。
  let stack: Array<{ indent: number; block: PastedBlock }> = [];
  const place = (block: PastedBlock, indent: number): void => {
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
    // 最多两层嵌套:栈已有三层时,挂到第二层之下(与第三层并列)。
    const parent = stack.length > 2 ? stack[1] : stack[stack.length - 1];
    if (parent && canHaveChildren(parent.block.kind)) {
      (parent.block.children ??= []).push(block);
      if (stack.length > 2) stack = stack.slice(0, 2);
    } else {
      out.push(block);
      stack = [];
    }
    if (canHaveChildren(block.kind)) stack.push({ indent, block });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = raw.trim();
    if (line === "") continue;
    const indent = indentWidth(raw);
    const fence = FENCE_LINE.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      const text = body.join("\n");
      out.push({ kind: "code", segments: plainSegments(text), text, language: fence[1] || "plain text" });
      stack = [];
      continue;
    }
    if (RULE_LINE.test(line)) {
      out.push({ kind: "divider", segments: [] });
      stack = [];
      continue;
    }
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1]?.length ?? 1);
      out.push({ kind: level === 1 ? "heading1" : level === 2 ? "heading2" : "heading3", segments: markdownToSegments(heading[2] ?? "") });
      stack = [];
      continue;
    }
    const todo = TODO_LINE.exec(line);
    if (todo) {
      place({ kind: "todo", segments: markdownToSegments(todo[2] ?? ""), checked: todo[1] !== " " }, indent);
      continue;
    }
    const bullet = BULLET_LINE.exec(line);
    if (bullet) {
      place({ kind: "bulleted", segments: markdownToSegments(bullet[1] ?? "") }, indent);
      continue;
    }
    const numbered = NUMBER_LINE.exec(line);
    if (numbered) {
      place({ kind: "numbered", segments: markdownToSegments(numbered[1] ?? "") }, indent);
      continue;
    }
    const quote = QUOTE_LINE.exec(line);
    if (quote) {
      place({ kind: "quote", segments: markdownToSegments(quote[1] ?? "") }, indent);
      continue;
    }
    place({ kind: "paragraph", segments: markdownToSegments(line) }, indent);
  }
  return out;
}

function indentWidth(raw: string): number {
  const lead = /^[ \t]*/u.exec(raw)?.[0] ?? "";
  let width = 0;
  for (const char of lead) width += char === "\t" ? 4 : 1;
  return width;
}

/** 这些块能带子块(标题/代码/分隔线不能)。 */
function canHaveChildren(kind: PastedBlock["kind"] | NotionBlockModel["kind"]): boolean {
  return (
    kind === "paragraph" ||
    kind === "bulleted" ||
    kind === "numbered" ||
    kind === "todo" ||
    kind === "quote" ||
    kind === "toggle" ||
    kind === "callout"
  );
}

/** 追加请求里的一个新块(与 core 的 NotionNewChildSchema 同形)。 */
export interface AppendChild {
  kind: TurnIntoKind | "divider";
  markdown: string;
  rich?: NotionSegment[];
  language?: string;
  checked?: boolean;
  emoji?: string;
  children?: AppendChild[];
}

/** 粘贴块 → 本地块树(每个块一个新本地 id,嵌套保留)。 */
export function pastedToLocal(items: readonly PastedBlock[], newId: () => string): NotionBlockModel[] {
  return items.map((item) => {
    const made = makeLocalBlock(
      newId(),
      item.kind,
      item.kind === "code" ? plainSegments(item.text ?? "") : item.segments,
    );
    if (made.kind === "todo") made.checked = item.checked === true;
    if (made.kind === "code" && item.language) made.language = item.language;
    if (item.children?.length) made.children = pastedToLocal(item.children, newId);
    return made;
  });
}

/** 粘贴块 → 追加请求的 children。 */
export function pastedToAppend(items: readonly PastedBlock[]): AppendChild[] {
  return items.map((item) => ({
    kind: item.kind,
    markdown: item.kind === "code" ? (item.text ?? "") : "",
    ...(item.segments.length > 0 && item.kind !== "code" ? { rich: item.segments } : {}),
    ...(item.kind === "code" && item.language ? { language: item.language } : {}),
    ...(item.kind === "todo" ? { checked: item.checked === true } : {}),
    ...(item.children?.length ? { children: pastedToAppend(item.children) } : {}),
  }));
}

/** 本地块(带子树)→ 追加请求的块;含不支持复制的块(图片、表格…)返回 null。 */
export function blockToAppend(block: NotionBlockModel): AppendChild | null {
  const children: AppendChild[] = [];
  for (const child of block.children) {
    const converted = blockToAppend(child);
    if (!converted) return null;
    children.push(converted);
  }
  const withChildren = (entry: AppendChild): AppendChild => (children.length > 0 ? { ...entry, children } : entry);
  switch (block.kind) {
    case "code":
      if (children.length > 0) return null;
      return { kind: "code", markdown: block.text, language: block.language };
    case "heading":
      return withChildren({
        kind: block.level === 1 ? "heading1" : block.level === 2 ? "heading2" : "heading3",
        markdown: "",
        rich: block.segments,
      });
    case "todo":
      return withChildren({ kind: "todo", markdown: "", rich: block.segments, checked: block.checked });
    case "callout":
      return withChildren({
        kind: "callout",
        markdown: "",
        rich: block.segments,
        ...(block.emoji ? { emoji: block.emoji } : {}),
      });
    case "paragraph":
    case "bulleted":
    case "numbered":
    case "quote":
    case "toggle":
      return withChildren({ kind: block.kind, markdown: "", rich: block.segments });
    default:
      return null;
  }
}

/** 块子树的层数(只有自己 = 0)。 */
function subtreeDepth(block: NotionBlockModel): number {
  return block.children.reduce((max, child) => Math.max(max, subtreeDepth(child) + 1), 0);
}

/**
 * Tab 缩进:块变成上一个兄弟的最后一个子块。没有上一个兄弟、上一个兄弟不能带子块、
 * 或块的子树已嵌了两层(Notion 单次请求的上限)时返回 null。
 */
export function indentIn(
  blocks: readonly NotionBlockModel[],
  id: string,
): { blocks: NotionBlockModel[]; parentId: string } | null {
  const visit = (list: readonly NotionBlockModel[]): { blocks: NotionBlockModel[]; parentId: string } | null => {
    const index = list.findIndex((block) => block.id === id);
    if (index >= 0) {
      const block = list[index];
      const previous = list[index - 1];
      if (!block || !previous || !canHaveChildren(previous.kind) || subtreeDepth(block) > 1) return null;
      if (blockToAppend(block) === null) return null;
      const merged: NotionBlockModel = { ...previous, children: [...previous.children, block] };
      return {
        blocks: [...list.slice(0, index - 1), merged, ...list.slice(index + 1)],
        parentId: previous.id,
      };
    }
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (!entry || entry.children.length === 0) continue;
      const nested = visit(entry.children);
      if (nested) {
        return { blocks: [...list.slice(0, i), { ...entry, children: nested.blocks }, ...list.slice(i + 1)], parentId: nested.parentId };
      }
    }
    return null;
  };
  return visit(blocks);
}

/** Shift+Tab 减少缩进:块变成父块的下一个兄弟。顶层块返回 null。 */
export function outdentIn(
  blocks: readonly NotionBlockModel[],
  id: string,
): { blocks: NotionBlockModel[]; afterId: string } | null {
  const visit = (list: readonly NotionBlockModel[]): { blocks: NotionBlockModel[]; afterId: string } | null => {
    for (let i = 0; i < list.length; i += 1) {
      const parent = list[i];
      if (!parent) continue;
      const childIndex = parent.children.findIndex((child) => child.id === id);
      if (childIndex >= 0) {
        const child = parent.children[childIndex];
        if (!child || blockToAppend(child) === null) return null;
        const rest: NotionBlockModel = { ...parent, children: parent.children.filter((entry) => entry.id !== id) };
        return {
          blocks: [...list.slice(0, i), rest, child, ...list.slice(i + 1)],
          afterId: parent.id,
        };
      }
      const nested = visit(parent.children);
      if (nested) {
        return { blocks: [...list.slice(0, i), { ...parent, children: nested.blocks }, ...list.slice(i + 1)], afterId: nested.afterId };
      }
    }
    return null;
  };
  return visit(blocks);
}

/** 本地子树与服务端子树按位置配对,返回 [本地 id, 服务端 id](用于登记真实 id)。 */
export function pairBlockIds(
  local: readonly NotionBlockModel[],
  server: readonly NotionBlockModel[],
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  local.forEach((block, index) => {
    const match = server[index];
    if (!match) return;
    pairs.push([block.id, match.id], ...pairBlockIds(block.children, match.children));
  });
  return pairs;
}

/** afterRealId 之后连续 count 个同层兄弟(整块,带子树)。 */
export function locateNewBlocks(
  blocks: readonly NotionBlockModel[],
  afterRealId: string | null,
  count: number,
): NotionBlockModel[] {
  const siblings = (list: readonly NotionBlockModel[]): NotionBlockModel[] | null => {
    if (afterRealId === null) return [...list];
    const index = list.findIndex((block) => block.id === afterRealId);
    if (index >= 0) return list.slice(index + 1);
    for (const block of list) {
      const nested = siblings(block.children);
      if (nested) return nested;
    }
    return null;
  };
  const all = siblings(blocks) ?? [];
  return afterRealId === null ? all.slice(Math.max(0, all.length - count)) : all.slice(0, count);
}

/** 块 id 对应的块在服务端树里最后一个子块(缩进后新副本的位置)。 */
export function lastChildOf(blocks: readonly NotionBlockModel[], parentRealId: string): NotionBlockModel | null {
  const parent = findBlockIn(blocks, parentRealId);
  return parent?.children[parent.children.length - 1] ?? null;
}

// —— 侧栏拖拽移动页面 ——

function findTreeNode(nodes: readonly NotionTreeNodeView[], id: string): NotionTreeNodeView | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findTreeNode(node.children, id);
    if (nested) return nested;
  }
  return null;
}

function parentIdOf(
  nodes: readonly NotionTreeNodeView[],
  id: string,
  parent: string | null = null,
): string | null | undefined {
  for (const node of nodes) {
    if (node.id === id) return parent;
    const nested = parentIdOf(node.children, id, node.id);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * 能不能把页面 dragId 拖进 targetId 下面。Notion 的限制:只能移普通页面,
 * 目标也得是普通页面;不能移到自己或自己的子孙下面;已经在那里就没必要移。
 */
export function canDropPage(
  roots: readonly NotionTreeNodeView[],
  dragId: string,
  targetId: string,
): boolean {
  if (dragId === targetId) return false;
  const dragged = findTreeNode(roots, dragId);
  const target = findTreeNode(roots, targetId);
  if (!dragged || !target) return false;
  if (dragged.object !== "page" || target.object !== "page") return false;
  if (findTreeNode(dragged.children, targetId)) return false;
  return parentIdOf(roots, dragId) !== targetId;
}

/** 本地先把节点挪到新父页面下(与服务端树同样按标题排序),拖拽松手立刻见效。 */
export function moveNodeIn(
  roots: readonly NotionTreeNodeView[],
  id: string,
  targetId: string,
): NotionTreeNodeView[] {
  const moving = findTreeNode(roots, id);
  if (!moving) return [...roots];
  const without = (nodes: readonly NotionTreeNodeView[]): NotionTreeNodeView[] =>
    nodes
      .filter((node) => node.id !== id)
      .map((node) => (node.children.length === 0 ? node : { ...node, children: without(node.children) }));
  const insert = (nodes: readonly NotionTreeNodeView[]): NotionTreeNodeView[] =>
    nodes.map((node) => {
      if (node.id === targetId) {
        const children = [...node.children, moving].sort((a, b) => a.title.localeCompare(b.title));
        return { ...node, children };
      }
      return node.children.length === 0 ? node : { ...node, children: insert(node.children) };
    });
  return insert(without(roots));
}
