export interface InlineNode {
  kind: "text" | "strong" | "em" | "code" | "link";
  text: string;
  href?: string;
}

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string; id: string }
  | { kind: "paragraph"; text: string; meta?: boolean }
  | { kind: "list"; ordered: boolean; items: string[]; checks?: Array<boolean | null> }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string; lang?: string }
  | { kind: "table"; text: string; header: string[]; rows: string[][]; align: Array<"left" | "center" | "right"> }
  | { kind: "rule" };

export interface TocItem {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  /** 「A · B」聚合出的虚拟父项:没有自己的锚点,点击跳到组内第一条。 */
  virtual?: boolean;
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/iu;
const LANG = /^[\w+-]{1,32}$/u;

/** Only http(s) and mailto survive. Scheme check is case-insensitive and rejects control characters. */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed === "" || /[\u0000-\u001F\u007F]/u.test(trimmed)) return false;
  return SAFE_HREF.test(trimmed);
}

export function plainInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function slugify(text: string): string {
  const slug = plainInline(text)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : "section";
}

export function extractToc(blocks: readonly MarkdownBlock[]): TocItem[] {
  const items: TocItem[] = [];
  for (const block of blocks) {
    if (block.kind !== "heading") continue;
    items.push({ id: block.id, level: block.level, text: plainInline(block.text) });
  }
  return groupTocByPrefix(items);
}

/**
 * 正文聚合:连续的「## A · B」章节(连续 ≥2 条)收拢为
 * 「## A」项目标题 + 「### B」子标题,锚点与内容顺序不变。
 */
export function groupSectionsByPrefix(blocks: readonly MarkdownBlock[]): MarkdownBlock[] {
  const out: MarkdownBlock[] = [];
  // run:正在聚合的同前缀章节;按"章节"为单位暂存,聚合与否只数章节数。
  let run: {
    prefix: string;
    sections: Array<{ heading: MarkdownBlock; sub: MarkdownBlock | null; body: MarkdownBlock[] }>;
  } | null = null;

  const flushRun = (): void => {
    if (!run) return;
    const grouped = run.sections.length >= 2;
    for (const [index, section] of run.sections.entries()) {
      if (grouped) {
        // 父标题每组只发一次,占用组首原锚点;组首自己的子标题换新锚点,内容一条不丢。
        if (index === 0) {
          const heading = section.heading;
          if (heading.kind === "heading") out.push({ ...heading, text: run.prefix });
        }
        if (section.sub) out.push(section.sub);
      } else {
        out.push(section.heading);
      }
      for (const block of section.body) out.push(block);
    }
    run = null;
  };

  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 2) {
      const prefix = sectionPrefix(block.text);
      if (prefix !== null) {
        const samePrefix = run !== null && run.prefix === prefix;
        if (!samePrefix) flushRun();
        const sub = block.text.slice(prefix.length).replace(/^[^\p{Letter}\p{Number}]+/u, "").trim();
        run ??= { prefix, sections: [] };
        run.sections.push({
          heading: block,
          sub: sub ? { ...block, level: 3, text: sub, ...(samePrefix ? {} : { id: `${block.id}-sub` }) } : null,
          body: [],
        });
        continue;
      }
    }
    if (block.kind === "heading") {
      flushRun();
      out.push(block);
      continue;
    }
    // 非标题内容属于当前章节;不在聚合段时直接输出。
    if (run) run.sections[run.sections.length - 1]?.body.push(block);
    else out.push(block);
  }
  flushRun();
  return out;
}

/** 「A · B」的前缀 A;没有「·」分隔的标题返回 null。 */
function sectionPrefix(text: string): string | null {
  const match = plainInline(text).match(/^(.{1,40}?)\s*·\s*\S/u);
  const prefix = match?.[1]?.trim();
  return prefix ? prefix : null;
}

/** 数字分身文档的统一解析入口:正文按项目前缀聚合,目录与渲染共用。 */
export function parsePortraitMarkdown(source: string): MarkdownBlock[] {
  return groupSectionsByPrefix(parseMarkdown(source));
}

/**
 * 「ashare-ledger · 定位」这类标题按前缀聚合:前缀出现两次以上时,
 * 前缀成为虚拟父项(跳到组内第一条),子项缩进一级——目录按项目归组。
 */
function groupTocByPrefix(items: readonly TocItem[]): TocItem[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const prefix = tocPrefix(item.text);
    if (prefix !== null) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const out: TocItem[] = [];
  const emitted = new Set<string>();
  for (const item of items) {
    const prefix = tocPrefix(item.text);
    if (prefix === null || (counts.get(prefix) ?? 0) < 2) {
      out.push(item);
      continue;
    }
    if (!emitted.has(prefix)) {
      emitted.add(prefix);
      out.push({ id: item.id, level: item.level, text: prefix, virtual: true });
    }
    out.push({
      id: item.id,
      level: (item.level === 3 ? 3 : item.level + 1) as 1 | 2 | 3,
      text: item.text.slice(prefix.length).replace(/^[^\p{Letter}\p{Number}]+/u, "").trim() || item.text,
    });
  }
  return out;
}

/** 「A · B」的前缀 A;没有「·」分隔的标题返回 null。 */
function tocPrefix(text: string): string | null {
  const match = text.match(/^(.{1,40}?)\s*·\s*\S/u);
  const prefix = match?.[1]?.trim();
  return prefix ? prefix : null;
}

export function shouldShowToc(items: readonly TocItem[]): boolean {
  return items.length >= 2;
}

export function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  let index = 0;
  const flush = (): void => {
    if (buffer === "") return;
    nodes.push({ kind: "text", text: buffer });
    buffer = "";
  };
  while (index < input.length) {
    if (input.startsWith("**", index)) {
      const end = input.indexOf("**", index + 2);
      if (end > index + 2) {
        flush();
        nodes.push({ kind: "strong", text: input.slice(index + 2, end) });
        index = end + 2;
        continue;
      }
    }
    const current = input[index] ?? "";
    if (current === "`") {
      const end = input.indexOf("`", index + 1);
      if (end > index) {
        flush();
        nodes.push({ kind: "code", text: input.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    if (current === "[") {
      const close = input.indexOf("]", index + 1);
      if (close > index && input[close + 1] === "(") {
        const end = input.indexOf(")", close + 2);
        const href = end > close ? input.slice(close + 2, end).trim() : "";
        if (end > close && isSafeHref(href)) {
          flush();
          nodes.push({ kind: "link", text: input.slice(index + 1, close), href });
          index = end + 1;
          continue;
        }
      }
    }
    if (current === "*" && input[index + 1] !== "*") {
      const end = input.indexOf("*", index + 1);
      if (end > index + 1) {
        flush();
        nodes.push({ kind: "em", text: input.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    buffer += current;
    index += 1;
  }
  flush();
  return nodes;
}

function headingId(text: string, seen: Map<string, number>): string {
  const base = slugify(text);
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}

function isDivider(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/u.test(trimmed);
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  // A lone `---` is a rule. A divider has to carry a pipe, same as the header row.
  return line.includes("|") && next.includes("|") && isDivider(next);
}

function splitCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function cellAlign(cell: string): "left" | "center" | "right" {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(":");
  const right = trimmed.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

function alignRow(line: string): Array<"left" | "center" | "right"> {
  return splitCells(line).map(cellAlign);
}

const TASK = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/u;
const BULLET = /^\s*[-*]\s+/u;
const ORDERED = /^\s*\d+[.)]\s+/u;

function isTask(line: string): boolean {
  return TASK.test(line);
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  const seen = new Map<string, number>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const rawLang = line.slice(3).trim();
      const lang = LANG.test(rawLang) ? rawLang : "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const text = body.join("\n");
      blocks.push(lang === "" ? { kind: "code", text } : { kind: "code", text, lang });
      continue;
    }
    if (/^(-{3,}|\*{3,})$/u.test(line.trim())) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) {
      const marks = heading[1] ?? "#";
      const level = marks.length === 1 ? 1 : marks.length === 2 ? 2 : 3;
      const text = (heading[2] ?? "").trim();
      blocks.push({ kind: "heading", level, text, id: headingId(text, seen) });
      index += 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      const header = splitCells(line);
      const align = alignRow(lines[index + 1] ?? "");
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim() !== "") {
        rows.push(splitCells(lines[index] ?? ""));
        index += 1;
      }
      const text = [header.join(" | "), ...rows.map((row) => row.join(" | "))].join("\n");
      blocks.push({ kind: "table", text, header, rows, align });
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith(">")) {
        body.push((lines[index] ?? "").replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    if (isTask(line)) {
      const items: string[] = [];
      const checks: Array<boolean | null> = [];
      while (index < lines.length && isTask(lines[index] ?? "")) {
        const match = TASK.exec(lines[index] ?? "");
        const mark = match?.[1] ?? " ";
        checks.push(mark !== " ");
        items.push(match?.[2] ?? "");
        index += 1;
      }
      blocks.push({ kind: "list", ordered: false, items, checks });
      continue;
    }
    if (BULLET.test(line)) {
      const items: string[] = [];
      while (index < lines.length && BULLET.test(lines[index] ?? "") && !isTask(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*[-*]\s+/u, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }
    if (ORDERED.test(line)) {
      const items: string[] = [];
      while (index < lines.length && ORDERED.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*\d+[.)]\s+/u, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }
    const body: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() === "") break;
      if (
        next.startsWith("```") ||
        next.startsWith(">") ||
        /^(#{1,3})\s+/u.test(next) ||
        isTableStart(lines, index) ||
        isTask(next) ||
        BULLET.test(next) ||
        ORDERED.test(next) ||
        /^(-{3,}|\*{3,})$/u.test(next.trim())
      ) {
        break;
      }
      body.push(next);
      index += 1;
    }
    const text = body.join(" ");
    const previous = blocks[blocks.length - 1];
    const meta = previous?.kind === "heading" && previous.level === 1 && /^v\d/iu.test(text) && text.length <= 160;
    blocks.push(meta ? { kind: "paragraph", text, meta: true } : { kind: "paragraph", text });
  }
  return blocks;
}
