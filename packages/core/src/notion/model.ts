/**
 * Render model for Notion content.
 *
 * Raw API block payloads are flattened into these shapes at sync time and
 * stored as JSON. The web renderer and the MCP tools consume only this model,
 * so Notion schema changes stay contained here.
 */

import { richTextSegments } from "./api-client.js";

export interface NotionSegment {
  text: string;
  href: string | null;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
}

interface BlockBase {
  id: string;
  children: NotionBlockModel[];
}

export type NotionBlockModel = BlockBase &
  (
    | { kind: "paragraph"; segments: NotionSegment[] }
    | { kind: "quote"; segments: NotionSegment[] }
    | { kind: "callout"; segments: NotionSegment[]; emoji: string | null; color: string }
    | { kind: "toggle"; segments: NotionSegment[] }
    | { kind: "heading"; level: 1 | 2 | 3; segments: NotionSegment[] }
    | { kind: "bulleted"; segments: NotionSegment[] }
    | { kind: "numbered"; segments: NotionSegment[] }
    | { kind: "todo"; segments: NotionSegment[]; checked: boolean }
    | { kind: "code"; language: string; text: string; caption: NotionSegment[] }
    | { kind: "divider" }
    | { kind: "image"; url: string; caption: NotionSegment[] }
    | { kind: "file"; url: string; name: string }
    | { kind: "pdf"; url: string; name: string }
    | { kind: "bookmark"; url: string; caption: NotionSegment[] }
    | { kind: "embed"; url: string }
    | { kind: "link_preview"; url: string }
    | { kind: "link_to_page"; targetId: string | null; targetKind: "page" | "database" }
    | { kind: "child_page"; title: string; pageId: string }
    | { kind: "child_database"; title: string; databaseId: string }
    | { kind: "table_of_contents" }
    | { kind: "breadcrumb" }
    | { kind: "equation"; expression: string }
    | { kind: "column_list" }
    | { kind: "column"; widthRatio: number | null }
    | { kind: "table"; hasHeader: boolean; rows: NotionSegment[][][] }
    | { kind: "synced"; state: "original" | "duplicate"; note: string | null }
    | { kind: "unknown"; type: string }
  );

/** Plain text of a model, for FTS and MCP output. */
export function blockPlainText(block: NotionBlockModel): string {
  const collect = (value: NotionBlockModel): string => {
    const own = segmentsOf(value).map((segment) => segment.text).join("");
    const kids = value.children.map(collect).join("\n");
    return own === "" ? kids : `${own}\n${kids}`;
  };
  return collect(block).trim();
}

function segmentsOf(block: NotionBlockModel): NotionSegment[] {
  switch (block.kind) {
    case "paragraph":
    case "quote":
    case "callout":
    case "toggle":
    case "bulleted":
    case "numbered":
      return block.segments;
    case "heading":
      return block.segments;
    case "todo":
      return block.segments;
    case "code":
      return block.caption;
    case "bookmark":
      return block.caption;
    default:
      return [];
  }
}

export function pagePlainText(blocks: readonly NotionBlockModel[]): string {
  return blocks.map(blockPlainText).join("\n");
}

/** Lightweight markdown for LLM consumption (MCP get_notion_page). */
export function blocksToMarkdown(blocks: readonly NotionBlockModel[]): string {
  const lines: string[] = [];
  const walk = (models: readonly NotionBlockModel[], depth: number): void => {
    const indent = "  ".repeat(depth);
    for (const block of models) {
      const text = segmentsOf(block)
        .map((segment) => segment.text)
        .join("");
      switch (block.kind) {
        case "heading":
          lines.push(`${"#".repeat(block.level)} ${text}`);
          break;
        case "bulleted":
          lines.push(`${indent}- ${text}`);
          walk(block.children, depth + 1);
          break;
        case "numbered":
          lines.push(`${indent}1. ${text}`);
          walk(block.children, depth + 1);
          break;
        case "todo":
          lines.push(`${indent}- [${block.checked ? "x" : " "}] ${text}`);
          walk(block.children, depth + 1);
          break;
        case "quote":
          lines.push(`> ${text}`);
          break;
        case "code":
          lines.push("```" + block.language, block.text, "```");
          break;
        case "divider":
          lines.push("---");
          break;
        case "callout":
          lines.push(`${block.emoji ?? "💡"} ${text}`);
          walk(block.children, depth);
          break;
        case "toggle":
          lines.push(`${indent}▸ ${text}`);
          walk(block.children, depth + 1);
          break;
        case "image":
          lines.push(`[图片] ${block.caption.map((s) => s.text).join("")}`.trim());
          break;
        case "file":
          lines.push(`[附件] ${block.name}`);
          break;
        case "bookmark":
          lines.push(`[链接] ${block.url}`);
          break;
        case "child_page":
          lines.push(`[子页面] ${block.title}`);
          break;
        case "child_database":
          lines.push(`[数据库] ${block.title}`);
          break;
        case "equation":
          lines.push(`$$${block.expression}$$`);
          break;
        case "table":
          for (const [index, row] of block.rows.entries()) {
            const line = `| ${tableRowText(row)} |`;
            lines.push(line);
            if (index === 0 && block.hasHeader) {
              lines.push(`|${row.map(() => " --- ").join("|")}|`);
            }
          }
          break;
        case "unknown":
          if (text !== "") lines.push(text);
          break;
        default:
          if (text !== "") lines.push(text);
          walk(block.children, depth);
          break;
      }
    }
  };
  walk(blocks, 0);
  return lines.join("\n");
}

const HEADING_TYPES: Record<string, 1 | 2 | 3> = {
  heading_1: 1,
  heading_2: 2,
  heading_3: 3,
};

/** Build a render model from a raw API block. Children are attached by the sync pass. */
export function buildBlockModel(raw: {
  id: string;
  type: string;
  hasChildren: boolean;
  data: Record<string, unknown>;
}): NotionBlockModel {
  const data = raw.data;
  const base = { id: raw.id, children: [] as NotionBlockModel[] };
  const segments = () => segmentsFrom(data.rich_text);
  if (HEADING_TYPES[raw.type]) {
    return { ...base, kind: "heading", level: HEADING_TYPES[raw.type]!, segments: segments() };
  }
  switch (raw.type) {
    case "paragraph":
      return { ...base, kind: "paragraph", segments: segments() };
    case "quote":
      return { ...base, kind: "quote", segments: segments() };
    case "callout":
      return {
        ...base,
        kind: "callout",
        segments: segments(),
        emoji: iconEmoji(data.icon),
        color: stringOf(data.color) ?? "default",
      };
    case "toggle":
      return { ...base, kind: "toggle", segments: segments() };
    case "bulleted_list_item":
      return { ...base, kind: "bulleted", segments: segments() };
    case "numbered_list_item":
      return { ...base, kind: "numbered", segments: segments() };
    case "to_do":
      return {
        ...base,
        kind: "todo",
        segments: segments(),
        checked: data.checked === true,
      };
    case "code":
      return {
        ...base,
        kind: "code",
        language: stringOf(data.language) ?? "",
        text: segmentsFrom(data.rich_text).map((s) => s.text).join(""),
        caption: segmentsFrom(data.caption),
      };
    case "divider":
      return { ...base, kind: "divider" };
    case "image":
      return {
        ...base,
        kind: "image",
        url: fileUrl(data) ?? "",
        caption: segmentsFrom(data.caption),
      };
    case "file":
      return {
        ...base,
        kind: "file",
        url: fileUrl(data) ?? "",
        name: fileName(data),
      };
    case "pdf":
      return {
        ...base,
        kind: "pdf",
        url: fileUrl(data) ?? "",
        name: fileName(data),
      };
    case "bookmark":
      return {
        ...base,
        kind: "bookmark",
        url: stringOf(data.url) ?? "",
        caption: segmentsFrom(data.caption),
      };
    case "embed":
      return { ...base, kind: "embed", url: stringOf(data.url) ?? "" };
    case "link_preview":
      return { ...base, kind: "link_preview", url: stringOf(data.url) ?? "" };
    case "link_to_page": {
      const linkType = stringOf(data.type);
      const pageId = stringOf(data.page_id);
      const databaseId = stringOf(data.database_id);
      const isDatabase = linkType === "database_id";
      return {
        ...base,
        kind: "link_to_page",
        targetId: isDatabase ? databaseId : pageId,
        targetKind: isDatabase ? "database" : "page",
      };
    }
    case "child_page":
      return {
        ...base,
        kind: "child_page",
        title: stringOf(data.title) ?? "",
        pageId: raw.id,
      };
    case "child_database":
      return {
        ...base,
        kind: "child_database",
        title: stringOf(data.title) ?? "",
        databaseId: raw.id,
      };
    case "table_of_contents":
      return { ...base, kind: "table_of_contents" };
    case "breadcrumb":
      return { ...base, kind: "breadcrumb" };
    case "equation":
      return {
        ...base,
        kind: "equation",
        expression: stringOf((data.equation as Record<string, unknown> | undefined)?.expression) ?? "",
      };
    case "column_list":
      return { ...base, kind: "column_list" };
    case "column":
      return {
        ...base,
        kind: "column",
        widthRatio: ratioOf(data.width_ratio),
      };
    case "table":
      return { ...base, kind: "table", hasHeader: data.has_column_header === true, rows: [] };
    case "table_row": {
      // Table rows live under table blocks; the model attaches their cells to the parent.
      return { ...base, kind: "unknown", type: "table_row" };
    }
    case "synced_block":
      return {
        ...base,
        kind: "synced",
        state: (data.synced_from as Record<string, unknown> | null) ? "duplicate" : "original",
        note: null,
      };
    default:
      return { ...base, kind: "unknown", type: raw.type };
  }
}

/** table_row blocks become plain text rows on their parent table model. */
export function tableRowCells(data: Record<string, unknown>): NotionSegment[][] {
  const cells = Array.isArray(data.cells) ? data.cells : [];
  return cells.map((cell) => segmentsFrom(cell));
}

/** Render one table row's cells as text (MCP markdown). */
export function tableRowText(row: NotionSegment[][]): string {
  return row.map((cell) => cell.map((segment) => segment.text).join("")).join(" | ");
}

function segmentsFrom(value: unknown): NotionSegment[] {
  if (!Array.isArray(value)) return [];
  return richTextSegments(value as Array<Record<string, unknown>>).map((segment) => ({
    text: segment.text,
    href: segment.href,
    bold: segment.bold,
    italic: segment.italic,
    strikethrough: segment.strikethrough,
    underline: segment.underline,
    code: segment.code,
    color: segment.color,
  }));
}

function iconEmoji(icon: unknown): string | null {
  if (typeof icon === "object" && icon !== null) {
    const emoji = (icon as Record<string, unknown>).emoji;
    if (typeof emoji === "string") return emoji;
  }
  return null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function ratioOf(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function fileUrl(data: Record<string, unknown>): string | null {
  const external = data.external as { url?: unknown } | null;
  if (external && typeof external.url === "string") return external.url;
  const file = data.file as { url?: unknown } | null;
  if (file && typeof file.url === "string") return file.url;
  return null;
}

function fileName(data: Record<string, unknown>): string {
  const caption = segmentsFrom(data.caption).map((segment) => segment.text).join("");
  if (caption !== "") return caption;
  const url = fileUrl(data);
  if (url) {
    try {
      const path = new URL(url).pathname;
      const last = decodeURIComponent(path.split("/").pop() ?? "");
      if (last !== "") return last;
    } catch {
      // Fall through to the generic name.
    }
  }
  return "附件";
}
