/**
 * 渲染模型 → Notion 接口的块 payload(新建与 PATCH 两种)。
 *
 * 新建、复制、移动(Notion 没有块移动接口,只能新建 + 删除)、转类型、撤销重做都走这里,
 * 所以任何能在接口里新建的块类型(图片、表格、分栏、公式、标签页……)都能被移动和复制。
 */

import { YouBrainError } from "../domain/errors.js";

import type { NotionBlockModel, NotionSegment } from "./model.js";
import { markdownToSegments } from "./markdown-text.js";

/** 接口能新建的提及类型;其余(如链接预览)写回时退化成带链接的文字,免得整块保存失败。 */
const WRITABLE_MENTIONS = new Set(["page", "database", "user", "date", "template_mention"]);

/** NotionSegment → API rich_text 形状(写入端必须用 API 形状,不是渲染模型)。 */
export function segmentsToRichText(segments: readonly NotionSegment[]): Array<Record<string, unknown>> {
  return segments.flatMap((segment): Array<Record<string, unknown>> => {
    const annotations = {
      bold: segment.bold,
      italic: segment.italic,
      strikethrough: segment.strikethrough,
      underline: segment.underline,
      code: segment.code,
      color: segment.color,
    };
    if (segment.equation !== undefined) {
      return [{ type: "equation", equation: { expression: segment.equation }, annotations }];
    }
    const mentionType = typeof segment.mention?.type === "string" ? segment.mention.type : null;
    if (segment.mention && mentionType && WRITABLE_MENTIONS.has(mentionType)) {
      return [{ type: "mention", mention: { type: mentionType, [mentionType]: segment.mention[mentionType] }, annotations }];
    }
    const url = writableUrl(segment.href) ?? mentionUrl(segment.mention);
    // 单段文字上限 2000 字符:长段落切成多段,格式不变。
    return chunk(segment.text).map((content) => ({
      // plain_text / href 是接口只读字段,写入时带上会被校验拒绝(带链接的段落必现),只发 text.link。
      type: "text",
      text: url ? { content, link: { url } } : { content },
      annotations,
    }));
  });
}

function chunk(text: string, size = 2000): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

/** Notion 只收 http(s)/mailto/tel 链接;file://、本地路径等会让整块保存失败,退化成纯文字。 */
function writableUrl(href: string | null | undefined): string | null {
  if (!href || !/^(https?:\/\/|mailto:|tel:)/iu.test(href)) return null;
  return /^https?:/iu.test(href) && !URL.canParse(href) ? null : href;
}

function mentionUrl(mention: Record<string, unknown> | undefined): string | null {
  if (!mention) return null;
  const type = typeof mention.type === "string" ? mention.type : "";
  const url = (mention[type] as { url?: unknown } | undefined)?.url;
  return typeof url === "string" && /^https?:/iu.test(url) ? url : null;
}

/** 模型 kind → 接口的块 type。不能新建的返回 null。 */
export function apiTypeOf(model: NotionBlockModel): string | null {
  switch (model.kind) {
    case "paragraph":
    case "quote":
    case "callout":
    case "toggle":
    case "code":
    case "divider":
    case "image":
    case "video":
    case "audio":
    case "file":
    case "pdf":
    case "bookmark":
    case "embed":
    case "equation":
    case "table_of_contents":
    case "breadcrumb":
    case "link_to_page":
    case "column_list":
    case "column":
    case "table":
    case "tab":
      return model.kind;
    case "heading":
      return `heading_${model.level}`;
    case "bulleted":
      return "bulleted_list_item";
    case "numbered":
      return "numbered_list_item";
    case "todo":
      return "to_do";
    default:
      return null;
  }
}

const KIND_LABELS: Record<string, string> = {
  child_page: "子页面",
  child_database: "内嵌数据库",
  synced: "同步块",
  link_preview: "链接预览",
  unknown: "Notion 专有块",
};

/** 子树里第一个接口没法新建的块(子页面、同步块等);都能建返回 null。 */
export function uncreatableIn(models: readonly NotionBlockModel[]): string | null {
  for (const model of models) {
    if (apiTypeOf(model) === null) {
      const type = model.kind === "unknown" ? model.type : model.kind;
      return KIND_LABELS[model.kind] ? `${KIND_LABELS[model.kind]}(${type})` : type;
    }
    const nested = uncreatableIn(model.children);
    if (nested) return nested;
  }
  return null;
}

/** 文本类块的 rich_text(空段给空数组)。 */
function richOf(segments: readonly NotionSegment[]): Array<Record<string, unknown>> {
  return segmentsToRichText(segments.filter((segment) => segment.text !== "" || segment.mention || segment.equation !== undefined));
}

function colorField(model: NotionBlockModel): Record<string, unknown> {
  return model.color && model.color !== "" ? { color: model.color } : {};
}

/** 媒体来源:上传 id > 外链;Notion 托管的旧文件由调用方先转存成上传 id。 */
function mediaSource(model: { url: string; uploadId?: string | undefined; source?: string | undefined }): Record<string, unknown> {
  if (model.uploadId) return { type: "file_upload", file_upload: { id: model.uploadId } };
  if (model.url === "") throw new YouBrainError("INVALID_INPUT", "缺少链接或上传的文件");
  return { type: "external", external: { url: model.url } };
}

/**
 * 块自身内容(不含子块)的 payload,即 `{ [type]: payload }` 里的 payload。
 * forPatch:PATCH 时 Notion 托管的媒体不重发来源(签名链接会过期),只改说明。
 */
export function blockBody(model: NotionBlockModel, forPatch = false, previous?: NotionBlockModel): Record<string, unknown> {
  switch (model.kind) {
    case "paragraph":
      return { rich_text: richOf(model.segments), ...colorField(model), ...(model.icon ? { icon: { type: "emoji", emoji: model.icon } } : {}) };
    case "quote":
    case "toggle":
    case "bulleted":
    case "numbered":
      return { rich_text: richOf(model.segments), ...colorField(model) };
    case "heading":
      return { rich_text: richOf(model.segments), ...colorField(model), is_toggleable: model.toggleable === true };
    case "todo":
      return { rich_text: richOf(model.segments), checked: model.checked, ...colorField(model) };
    case "callout":
      return {
        rich_text: richOf(model.segments),
        icon: { type: "emoji", emoji: model.emoji || "💡" },
        color: model.color || "default",
      };
    case "code":
      return {
        rich_text: chunk(model.text)
          .filter((content) => content !== "")
          .map((content) => ({ type: "text", text: { content } })),
        language: model.language || "plain text",
        caption: segmentsToRichText(model.caption),
      };
    case "divider":
    case "breadcrumb":
      return {};
    case "table_of_contents":
      return { ...colorField(model) };
    case "equation":
      return { expression: model.expression };
    case "image":
    case "video":
    case "audio":
    case "file":
    case "pdf": {
      const caption = { caption: segmentsToRichText(model.caption ?? []) };
      const unchangedHosted =
        forPatch &&
        !model.uploadId &&
        model.source === "file" &&
        previous !== undefined &&
        "url" in previous &&
        previous.url === model.url;
      if (unchangedHosted) return caption;
      return { ...mediaSource(model), ...caption };
    }
    case "bookmark":
      if (model.url === "") throw new YouBrainError("INVALID_INPUT", "书签缺少链接");
      return { url: model.url, caption: segmentsToRichText(model.caption) };
    case "embed":
      if (model.url === "") throw new YouBrainError("INVALID_INPUT", "嵌入缺少链接");
      return { url: model.url, ...(model.caption ? { caption: segmentsToRichText(model.caption) } : {}) };
    case "link_to_page":
      if (!model.targetId) throw new YouBrainError("INVALID_INPUT", "页面链接缺少目标页面");
      return model.targetKind === "database"
        ? { type: "database_id", database_id: model.targetId }
        : { type: "page_id", page_id: model.targetId };
    case "column":
      return model.widthRatio ? { width_ratio: model.widthRatio } : {};
    case "table":
      return {
        table_width: Math.max(1, ...model.rows.map((row) => row.length)),
        has_column_header: model.hasHeader,
        has_row_header: model.hasRowHeader === true,
      };
    case "column_list":
    case "tab":
      return {};
    default:
      throw new YouBrainError("INVALID_INPUT", `「${model.kind}」类型的块无法通过 Notion 接口新建或修改`);
  }
}

/** Notion 单次请求里一个数组最多 100 个元素(表格行也一样)。 */
export const ROWS_PER_REQUEST = 100;

function tableRow(row: readonly NotionSegment[][], width: number): Record<string, unknown> {
  return {
    object: "block",
    type: "table_row",
    table_row: { cells: Array.from({ length: width }, (_, index) => segmentsToRichText(row[index] ?? [])) },
  };
}

const PLACEHOLDER: Record<string, unknown> = { object: "block", type: "paragraph", paragraph: { rich_text: [] } };

/**
 * 新建用的 payload,只带「建块时必须一起给」的子块:表格的前 100 行、分栏的列(每列一个占位段落)、
 * 标签页的标签段落。其余子块由调用方拿到新块 id 后逐层追加,这样不受「单次最多嵌两层」的限制。
 */
export function createPayload(model: NotionBlockModel): Record<string, unknown> {
  const type = apiTypeOf(model);
  if (!type) throw new YouBrainError("INVALID_INPUT", `「${uncreatableIn([model])}」无法通过 Notion 接口新建`);
  const body = blockBody(model);
  if (model.kind === "table") {
    const width = Number(body.table_width);
    const rows = model.rows.length > 0 ? model.rows : [[[]]];
    body.children = rows.slice(0, ROWS_PER_REQUEST).map((row) => tableRow(row, width));
  } else if (model.kind === "column_list") {
    const columns: Array<NotionBlockModel | null> =
      model.children.length >= 2 ? model.children : [...model.children, ...Array.from({ length: 2 - model.children.length }, () => null)];
    body.children = columns.map((column) => ({
      object: "block",
      type: "column",
      column: {
        ...(column && column.kind === "column" && column.widthRatio ? { width_ratio: column.widthRatio } : {}),
        children: secondLevel(column?.children ?? []),
      },
    }));
  } else if (model.kind === "tab") {
    body.children = model.children.map((label) => ({
      object: "block",
      type: "paragraph",
      paragraph: { ...blockBody(label), children: secondLevel(label.children) },
    }));
  }
  return { object: "block", type, [type]: body };
}

/** 能直接放进分栏/标签页请求第二层的块(自身建块时不需要再带子块)。 */
export function inlineable(model: NotionBlockModel): boolean {
  return model.kind !== "table" && model.kind !== "column_list" && model.kind !== "tab";
}

/**
 * 分栏的列、标签页的标签下面的内容:直接带进请求(Notion 单次最多嵌两层,正好到这一层);
 * 表格、分栏这类自己还要带子块的放占位段落,建好后再替换。空的放一个占位段落(列至少要有一个子块)。
 */
function secondLevel(children: readonly NotionBlockModel[]): Array<Record<string, unknown>> {
  if (children.length === 0) return [PLACEHOLDER];
  return children.map((child) => (inlineable(child) ? createPayload(child) : PLACEHOLDER));
}

/** 新建后还要逐层追加的子块(表格行、分栏/标签页已在 createPayload 里处理,这里不算)。 */
export function needsChildFetch(model: NotionBlockModel): boolean {
  return model.children.length > 0 || model.kind === "table" || model.kind === "column_list" || model.kind === "tab";
}

/** 表格超过 100 行的部分,按 100 行一批。 */
export function tableOverflow(model: NotionBlockModel): Array<Array<Record<string, unknown>>> {
  if (model.kind !== "table" || model.rows.length <= ROWS_PER_REQUEST) return [];
  const width = Math.max(1, ...model.rows.map((row) => row.length));
  const batches: Array<Array<Record<string, unknown>>> = [];
  for (let start = ROWS_PER_REQUEST; start < model.rows.length; start += ROWS_PER_REQUEST) {
    batches.push(model.rows.slice(start, start + ROWS_PER_REQUEST).map((row) => tableRow(row, width)));
  }
  return batches;
}

/** PATCH 用:块类型不变,只改内容与属性。 */
export function patchPayload(model: NotionBlockModel, previous: NotionBlockModel): Record<string, unknown> {
  const type = apiTypeOf(model);
  if (!type) throw new YouBrainError("INVALID_INPUT", `「${uncreatableIn([model])}」不支持修改`);
  if (type !== apiTypeOf(previous)) {
    throw new YouBrainError("INVALID_INPUT", "Notion 不允许直接改块类型,请用「转换为」");
  }
  const body = blockBody(model, true, previous);
  if (model.kind === "table") {
    // 列数建表后不能改,PATCH 只改表头设置。
    delete body.table_width;
  }
  return { [type]: body };
}

/** 前端发来的模型做一次形状收敛:只信任已知字段,文本缺省按空处理。 */
export function sanitizeModel(input: Record<string, unknown>, id: string, children: NotionBlockModel[]): NotionBlockModel {
  const kind = String(input.kind ?? "");
  const segments = Array.isArray(input.segments) ? (input.segments as NotionSegment[]) : [];
  const caption = Array.isArray(input.caption) ? (input.caption as NotionSegment[]) : [];
  const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
  const color = typeof input.color === "string" && input.color !== "default" ? { color: input.color } : {};
  const media = {
    url: str(input.url),
    ...(typeof input.uploadId === "string" && input.uploadId !== "" ? { uploadId: input.uploadId } : {}),
    ...(input.source === "file" || input.source === "external" ? { source: input.source as "file" | "external" } : {}),
  };
  const base = { id, children };
  switch (kind) {
    case "paragraph":
      return { ...base, ...color, kind, segments, ...(typeof input.icon === "string" ? { icon: input.icon } : {}) };
    case "quote":
    case "toggle":
    case "bulleted":
    case "numbered":
      return { ...base, ...color, kind, segments };
    case "heading": {
      const level = Number(input.level);
      return {
        ...base,
        ...color,
        kind,
        level: level === 2 || level === 3 || level === 4 ? level : 1,
        segments,
        ...(input.toggleable === true ? { toggleable: true } : {}),
      };
    }
    case "todo":
      return { ...base, ...color, kind, segments, checked: input.checked === true };
    case "callout":
      return { ...base, kind, segments, emoji: str(input.emoji, "💡") || "💡", color: str(input.color, "default") || "default" };
    case "code":
      return { ...base, kind, text: str(input.text), language: str(input.language, "plain text"), caption };
    case "divider":
    case "breadcrumb":
    case "column_list":
    case "tab":
      return { ...base, kind };
    case "table_of_contents":
      return { ...base, ...color, kind };
    case "equation":
      return { ...base, kind, expression: str(input.expression) };
    case "image":
    case "video":
    case "audio":
      return { ...base, kind: kind as "image", ...media, caption };
    case "file":
    case "pdf":
      return { ...base, kind: kind as "file", ...media, name: str(input.name, "附件"), caption };
    case "bookmark":
      return { ...base, kind, url: str(input.url), caption };
    case "embed":
      return { ...base, kind, url: str(input.url), caption };
    case "link_to_page":
      return {
        ...base,
        kind,
        targetId: typeof input.targetId === "string" ? input.targetId : null,
        targetKind: input.targetKind === "database" ? "database" : "page",
      };
    case "column":
      return { ...base, kind, widthRatio: typeof input.widthRatio === "number" ? input.widthRatio : null };
    case "table": {
      const rows = Array.isArray(input.rows) ? (input.rows as NotionSegment[][][]) : [];
      return { ...base, kind, hasHeader: input.hasHeader === true, hasRowHeader: input.hasRowHeader === true, rows };
    }
    default:
      throw new YouBrainError("INVALID_INPUT", `不支持新建「${kind}」类型的块`);
  }
}

/** 前端发来的整棵子树(新建用):逐层收敛,id 丢弃(Notion 会分配)。 */
export function sanitizeTree(input: unknown): NotionBlockModel[] {
  if (!Array.isArray(input)) return [];
  return input.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return sanitizeModel(record, `new-${index}`, sanitizeTree(record.children));
  });
}

/** markdown 文本 → 段落(兼容旧的 markdown 入参)。 */
export function segmentsFromMarkdown(markdown: string): NotionSegment[] {
  return markdownToSegments(markdown);
}
