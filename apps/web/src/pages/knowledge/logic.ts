import type { NotionBlockModel, NotionSegment, NotionTreeNodeView } from "@you-brain/core/http/types.js";

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
