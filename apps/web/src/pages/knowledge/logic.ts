import type { NotionBlockModel, NotionSegment, NotionTreeNodeView } from "@you-brain/core/http/types.js";
import { markdownToSegments } from "@you-brain/core/notion/markdown-text.js";

export type TurnIntoKind =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "toggleHeading1"
  | "toggleHeading2"
  | "toggleHeading3"
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
  { kind: "heading4", labelKey: "knowledgeTypeHeading4" },
  { kind: "toggleHeading1", labelKey: "knowledgeTypeToggleHeading1" },
  { kind: "toggleHeading2", labelKey: "knowledgeTypeToggleHeading2" },
  { kind: "toggleHeading3", labelKey: "knowledgeTypeToggleHeading3" },
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

/** 接口建不了的块(子页面、内嵌数据库、同步块、链接预览、Notion 专有块):只能看,不能移动/复制。 */
const UNCREATABLE_KINDS = new Set(["child_page", "child_database", "synced", "link_preview", "unknown"]);

export function isReadOnlyBlock(block: NotionBlockModel): boolean {
  return UNCREATABLE_KINDS.has(block.kind);
}

/** 移动/复制要在新位置整棵重建:子树里有接口建不了的块就不行。 */
export function canMoveBlock(block: NotionBlockModel): boolean {
  if (isReadOnlyBlock(block) || isLocalPending(block)) return false;
  return block.children.every(canMoveBlock);
}

/** 还没选好来源的媒体/书签/嵌入占位块(只在本地,不写 Notion)。 */
export function isLocalPending(block: NotionBlockModel): boolean {
  if (!isLocalId(block.id)) return false;
  switch (block.kind) {
    case "image":
    case "video":
    case "audio":
    case "file":
    case "pdf":
      return block.url === "" && !block.uploadId;
    case "bookmark":
    case "embed":
      return block.url === "";
    case "equation":
      return block.expression === "";
    case "link_to_page":
      return block.targetId === null;
    default:
      return false;
  }
}

/** 文本类块能设颜色(callout 自带颜色字段,目录也有颜色)。 */
export function canColorBlock(block: NotionBlockModel): boolean {
  return hasSegments(block) || block.kind === "table_of_contents";
}

/** 能带子块的块(缩进、拖进去、折叠内容)。 */
export function acceptsChildren(block: NotionBlockModel): boolean {
  if (block.kind === "heading") return block.toggleable === true;
  return canHaveChildren(block.kind);
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
    case "heading4":
      return { ...base, kind: "heading", level: 4, segments };
    case "toggleHeading1":
      return { ...base, kind: "heading", level: 1, segments, toggleable: true };
    case "toggleHeading2":
      return { ...base, kind: "heading", level: 2, segments, toggleable: true };
    case "toggleHeading3":
      return { ...base, kind: "heading", level: 3, segments, toggleable: true };
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
  } else if (block.color && next.kind !== "code" && next.kind !== "callout") {
    // 块颜色跟着走(Notion 转类型保留颜色)。
    next.color = block.color;
  }
  // 普通标题转成别的块时,子块只能挂在能带子块的块下面;不能带的由调用方拒绝。
  next.children = block.children;
  return next;
}

/** 当前块对应的转换目标(菜单里打勾用)。 */
export function turnIntoKindOf(block: NotionBlockModel): TurnIntoKind | null {
  switch (block.kind) {
    case "heading":
      if (block.toggleable && block.level <= 3) return `toggleHeading${block.level as 1 | 2 | 3}`;
      return `heading${block.level}`;
    case "paragraph":
    case "bulleted":
    case "numbered":
    case "todo":
    case "quote":
    case "callout":
    case "toggle":
    case "code":
      return block.kind;
    default:
      return null;
  }
}

/** 块在树里的位置:父块(null = 页面顶层)与前一个兄弟(null = 第一个)。撤销时按它插回去。 */
export interface BlockPlacement {
  parentId: string | null;
  afterId: string | null;
}

export function placementOf(blocks: readonly NotionBlockModel[], id: string): BlockPlacement | null {
  const visit = (list: readonly NotionBlockModel[], parentId: string | null): BlockPlacement | null => {
    const index = list.findIndex((block) => block.id === id);
    if (index >= 0) return { parentId, afterId: index > 0 ? (list[index - 1]?.id ?? null) : null };
    for (const block of list) {
      const nested = visit(block.children, block.id);
      if (nested) return nested;
    }
    return null;
  };
  return visit(blocks, null);
}

/** 按位置插入一组块(afterId 找不到就放到父块末尾)。 */
export function insertAtPlacement(
  blocks: readonly NotionBlockModel[],
  placement: BlockPlacement,
  items: readonly NotionBlockModel[],
): NotionBlockModel[] {
  const place = (list: readonly NotionBlockModel[]): NotionBlockModel[] => {
    if (placement.afterId === null) return [...items, ...list];
    const index = list.findIndex((block) => block.id === placement.afterId);
    if (index < 0) return [...list, ...items];
    return [...list.slice(0, index + 1), ...items, ...list.slice(index + 1)];
  };
  if (placement.parentId === null) return place(blocks);
  return updateBlockIn(blocks, placement.parentId, (parent) => ({ ...parent, children: place(parent.children) }));
}

/** 块是否在 ancestorId 的子树里(含自己)。 */
export function isInside(blocks: readonly NotionBlockModel[], ancestorId: string, id: string): boolean {
  const ancestor = findBlockIn(blocks, ancestorId);
  return ancestor !== null && findBlockIn([ancestor], id) !== null;
}

/** 文档顺序的所有块 id(深度优先)。 */
export function documentOrder(blocks: readonly NotionBlockModel[]): string[] {
  return collectIds(blocks);
}

/** 选中的一组块去掉「祖先也被选中」的(整棵子树一起处理),按文档顺序。 */
export function topmostSelected(blocks: readonly NotionBlockModel[], ids: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const visit = (list: readonly NotionBlockModel[]): void => {
    for (const block of list) {
      if (ids.has(block.id)) out.push(block.id);
      else visit(block.children);
    }
  };
  visit(blocks);
  return out;
}

/** 复制成 Markdown(带行内格式、嵌套缩进、表格、媒体链接)。 */
export function blocksToMarkdownText(blocks: readonly NotionBlockModel[]): string {
  const lines: string[] = [];
  const walk = (list: readonly NotionBlockModel[], depth: number): void => {
    let number = 0;
    for (const block of list) {
      const indent = "    ".repeat(depth);
      number = block.kind === "numbered" ? number + 1 : 0;
      const text = segmentsToMarkdown(segmentsOf(block));
      let nested = depth + 1;
      switch (block.kind) {
        case "heading":
          lines.push(`${indent}${"#".repeat(block.level)} ${text}`);
          nested = depth;
          break;
        case "bulleted":
          lines.push(`${indent}- ${text}`);
          break;
        case "numbered":
          lines.push(`${indent}${number}. ${text}`);
          break;
        case "todo":
          lines.push(`${indent}- [${block.checked ? "x" : " "}] ${text}`);
          break;
        case "quote":
          lines.push(`${indent}> ${text}`);
          break;
        case "callout":
          lines.push(`${indent}> ${block.emoji ?? "💡"} ${text}`);
          break;
        case "toggle":
          lines.push(`${indent}- ${text}`);
          break;
        case "code":
          lines.push(`${indent}\`\`\`${block.language === "plain text" ? "" : block.language}`, ...block.text.split("\n").map((line) => indent + line), `${indent}\`\`\``);
          break;
        case "divider":
          lines.push(`${indent}---`);
          break;
        case "equation":
          lines.push(`${indent}$$${block.expression}$$`);
          break;
        case "image":
          lines.push(`${indent}![${segmentsText(block.caption)}](${block.url})`);
          break;
        case "video":
        case "audio":
        case "file":
        case "pdf":
          lines.push(`${indent}[${block.kind === "file" || block.kind === "pdf" ? block.name : segmentsText(block.caption) || block.url}](${block.url})`);
          break;
        case "bookmark":
        case "embed":
        case "link_preview":
          lines.push(`${indent}${block.url}`);
          break;
        case "child_page":
        case "child_database":
          lines.push(`${indent}${block.title}`);
          break;
        case "table": {
          block.rows.forEach((row, index) => {
            lines.push(`${indent}| ${row.map((cell) => segmentsToMarkdown(cell).replaceAll("|", "\\|").replaceAll("\n", "<br>")).join(" | ")} |`);
            if (index === 0) lines.push(`${indent}|${row.map(() => " --- ").join("|")}|`);
          });
          break;
        }
        case "column_list":
        case "column":
        case "tab":
        case "synced":
          nested = depth;
          break;
        default:
          if (text !== "") lines.push(`${indent}${text}`);
          break;
      }
      walk(block.children, nested);
    }
  };
  walk(blocks, 0);
  return lines.join("\n");
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

/** Markdown 表格:每行是一组单元格,每格是富文本。 */
export interface PastedTable {
  hasHeader: boolean;
  rows: NotionSegment[][][];
}

export interface PastedBlock {
  kind: TurnIntoKind | "divider" | "table" | "image" | "equation";
  /** image 的链接。 */
  url?: string;
  /** equation 的 LaTeX。 */
  expression?: string;
  segments: NotionSegment[];
  /** code 块的裸文本与语言。 */
  text?: string;
  language?: string;
  checked?: boolean;
  /** kind 为 table 时的行。 */
  table?: PastedTable;
  /** 缩进形成的子块(Notion 单次请求最多嵌两层,更深的并入第二层)。 */
  children?: PastedBlock[];
}

const HEADING_LINE = /^(#{1,6})\s+(.*)$/u;
const TODO_LINE = /^[-*+]\s+\[([ xX])\]\s+(.*)$/u;
const BULLET_LINE = /^[-*+]\s+(.*)$/u;
const NUMBER_LINE = /^\d+[.)]\s+(.*)$/u;
const QUOTE_LINE = /^>\s?(.*)$/u;
const IMAGE_LINE = /^!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)$/u;
const MATH_LINE = /^\$\$(.+)\$\$$/u;
const RULE_LINE = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const FENCE_LINE = /^```\s*([\w+#-]*)\s*$/u;
const TABLE_DELIMITER_CELL = /^:?-+:?$/u;
const TABLE_BREAK = /<br\s*\/?>/giu;

/** 拆一行表格的单元格:去掉首尾的 |,按未转义的 | 切开;不含 | 的行不是表格行。 */
function splitTableRow(line: string): string[] | null {
  let body = line.trim();
  if (!body.includes("|")) return null;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** 表格单元格的富文本:<br> 换成换行,其余按行内 Markdown 解析。 */
function tableCellSegments(cell: string): NotionSegment[] {
  return markdownToSegments(cell.replace(TABLE_BREAK, "\n"));
}

/**
 * 从 lines[start] 起识别一张 GFM 表格:表头行 + 分隔行(列数一致),
 * 之后直到空行或不含 | 的行都是数据行;列数多的截掉、少的补空。
 * 不是表格返回 null。
 */
function parseTableAt(lines: readonly string[], start: number): { table: PastedTable; next: number } | null {
  const header = splitTableRow(lines[start] ?? "");
  const delimiter = splitTableRow(lines[start + 1] ?? "");
  if (!header || !delimiter || delimiter.length !== header.length) return null;
  if (!delimiter.every((cell) => TABLE_DELIMITER_CELL.test(cell))) return null;
  const width = header.length;
  const toRow = (cells: readonly string[]): NotionSegment[][] =>
    Array.from({ length: width }, (_, index) => tableCellSegments(cells[index] ?? ""));
  const rows = [toRow(header)];
  let next = start + 2;
  while (next < lines.length) {
    const line = (lines[next] ?? "").trim();
    if (line === "") break;
    const cells = splitTableRow(line);
    if (!cells) break;
    rows.push(toRow(cells));
    next += 1;
  }
  return { table: { hasHeader: true, rows }, next };
}

/**
 * 把粘贴的 Markdown 文本拆成块:标题、列表、待办、引用、代码围栏、分隔线、表格,
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
    // 嵌套不限层数:新建时由 core 逐层追加子块。
    const parent = stack[stack.length - 1];
    if (parent && canHaveChildren(parent.block.kind)) {
      (parent.block.children ??= []).push(block);
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
    const table = parseTableAt(lines, index);
    if (table) {
      out.push({ kind: "table", segments: [], table: table.table });
      stack = [];
      index = table.next - 1;
      continue;
    }
    if (RULE_LINE.test(line)) {
      out.push({ kind: "divider", segments: [] });
      stack = [];
      continue;
    }
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1]?.length ?? 1);
      out.push({ kind: `heading${level as 1 | 2 | 3 | 4}`, segments: markdownToSegments(heading[2] ?? "") });
      stack = [];
      continue;
    }
    const image = IMAGE_LINE.exec(line);
    if (image) {
      out.push({ kind: "image", segments: markdownToSegments(image[1] ?? ""), url: image[2] ?? "" });
      stack = [];
      continue;
    }
    const math = MATH_LINE.exec(line);
    if (math) {
      out.push({ kind: "equation", segments: [], expression: (math[1] ?? "").trim() });
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
  kind: TurnIntoKind | "divider" | "table";
  markdown: string;
  rich?: NotionSegment[];
  language?: string;
  checked?: boolean;
  emoji?: string;
  table?: PastedTable;
  children?: AppendChild[];
}

/** 粘贴块 → 本地块树(每个块一个新本地 id,嵌套保留)。 */
export function pastedToLocal(items: readonly PastedBlock[], newId: () => string): NotionBlockModel[] {
  return items.map((item) => {
    if (item.kind === "table") {
      const table = item.table ?? { hasHeader: true, rows: [] };
      return { id: newId(), children: [], kind: "table", hasHeader: table.hasHeader, rows: table.rows };
    }
    if (item.kind === "image") {
      return { id: newId(), children: [], kind: "image", url: item.url ?? "", caption: item.segments, source: "external" };
    }
    if (item.kind === "equation") {
      return { id: newId(), children: [], kind: "equation", expression: item.expression ?? "" };
    }
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
    kind: item.kind === "image" || item.kind === "equation" ? "paragraph" : item.kind,
    markdown: item.kind === "code" ? (item.text ?? "") : "",
    ...(item.segments.length > 0 && item.kind !== "code" ? { rich: item.segments } : {}),
    ...(item.kind === "code" && item.language ? { language: item.language } : {}),
    ...(item.kind === "todo" ? { checked: item.checked === true } : {}),
    ...(item.kind === "table" && item.table ? { table: item.table } : {}),
    ...(item.children?.length ? { children: pastedToAppend(item.children) } : {}),
  }));
}

/** Notion 单次追加:顶层最多 100 个,连同子块与表格行总共最多 1000 个。 */
const APPEND_MAX_CHILDREN = 100;
const APPEND_MAX_BLOCKS = 1000;
/** 表格第一次请求最多带的行数(其余由 core 分批续写,不计入这次请求)。 */
const TABLE_ROWS_PER_REQUEST = 100;

function appendWeight(child: AppendChild): number {
  const rows = child.kind === "table" ? Math.min(child.table?.rows.length ?? 0, TABLE_ROWS_PER_REQUEST) : 0;
  return 1 + rows + (child.children ?? []).reduce((sum, entry) => sum + appendWeight(entry), 0);
}

/** 把追加的块切成多次请求,每批都不超过 Notion 的数量上限;顺序不变。 */
export function appendBatches(children: readonly AppendChild[]): AppendChild[][] {
  const batches: AppendChild[][] = [];
  let current: AppendChild[] = [];
  let weight = 0;
  for (const child of children) {
    const next = appendWeight(child);
    if (current.length > 0 && (current.length >= APPEND_MAX_CHILDREN || weight + next > APPEND_MAX_BLOCKS)) {
      batches.push(current);
      current = [];
      weight = 0;
    }
    current.push(child);
    weight += next;
  }
  if (current.length > 0) batches.push(current);
  return batches;
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
      if (!block || !previous || !acceptsChildren(previous) || !canMoveBlock(block)) return null;
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
        if (!child || !canMoveBlock(child)) return null;
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

// —— 表格编辑 ——

type TableBlock = Extract<NotionBlockModel, { kind: "table" }>;

/** 表格编辑操作(与 core 的 NotionTableEditSchema 同形,少了 tableId)。 */
export type TableOp =
  | { op: "update-row"; rowIndex: number; cells: NotionSegment[][] }
  | { op: "insert-row"; afterIndex: number; cells: NotionSegment[][] }
  | { op: "delete-row"; rowIndex: number }
  | { op: "set-header"; hasHeader?: boolean; hasRowHeader?: boolean }
  | { op: "rebuild"; hasHeader: boolean; hasRowHeader: boolean; rows: NotionSegment[][][] };

export function tableWidthOf(table: TableBlock): number {
  return Math.max(1, ...table.rows.map((row) => row.length));
}

/** 本地先应用表格操作(乐观更新);行宽对齐到列数,与 core 一致。 */
export function applyTableOp(table: TableBlock, op: TableOp): TableBlock {
  const width = tableWidthOf(table);
  const fit = (cells: readonly NotionSegment[][]): NotionSegment[][] =>
    Array.from({ length: width }, (_, index) => cells[index] ?? []);
  switch (op.op) {
    case "update-row":
      return { ...table, rows: table.rows.map((row, index) => (index === op.rowIndex ? fit(op.cells) : row)) };
    case "insert-row": {
      const at = op.afterIndex + 1;
      return { ...table, rows: [...table.rows.slice(0, at), fit(op.cells), ...table.rows.slice(at)] };
    }
    case "delete-row":
      return table.rows.length <= 1 ? table : { ...table, rows: table.rows.filter((_, index) => index !== op.rowIndex) };
    case "set-header":
      return {
        ...table,
        hasHeader: op.hasHeader ?? table.hasHeader,
        hasRowHeader: op.hasRowHeader ?? table.hasRowHeader ?? false,
      };
    case "rebuild":
      return { ...table, hasHeader: op.hasHeader, hasRowHeader: op.hasRowHeader, rows: op.rows };
  }
}

/** 在第 after 列之后插入一个空列(after = -1 插到最前)。 */
export function insertTableColumn(rows: readonly NotionSegment[][][], after: number): NotionSegment[][][] {
  return rows.map((row) => [...row.slice(0, after + 1), [], ...row.slice(after + 1)]);
}

/** 删除第 col 列;只剩一列时不删。 */
export function deleteTableColumn(rows: readonly NotionSegment[][][], col: number): NotionSegment[][][] {
  if (rows.every((row) => row.length <= 1)) return rows.map((row) => [...row]);
  return rows.map((row) => row.filter((_, index) => index !== col));
}

export function isEmptyRow(row: readonly NotionSegment[][]): boolean {
  return row.every((cell) => cell.every((segment) => segment.text.trim() === ""));
}
