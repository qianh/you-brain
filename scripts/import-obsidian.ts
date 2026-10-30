#!/usr/bin/env bun
/**
 * Import a local Obsidian vault into the Notion workspace behind the
 * U-Brain knowledge base.
 *
 * - Mirrors the vault's folder tree as nested Notion pages under a
 *   workspace-level root page ("Obsidian").
 * - Converts markdown to native blocks: headings, lists, todos, quotes,
 *   callouts, code, tables, dividers; frontmatter becomes a callout.
 * - Obsidian-specific syntax: [[wikilinks]] and ==highlights== degrade to
 *   plain text / bold; embedded local images are uploaded via the File
 *   Upload API when possible, otherwise a placeholder line is left.
 * - Skips attachments (pic/), templates, Excalidraw drawings, hidden dirs.
 * - Idempotent: a manifest in the app data dir maps vault paths to created
 *   page ids, so a rerun resumes instead of duplicating.
 *
 * Usage:
 *   bun scripts/import-obsidian.ts --dry     # plan only, no API calls
 *   bun scripts/import-obsidian.ts           # full import
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative } from "node:path";

import { markdownToSegments } from "../packages/core/src/notion/markdown-text.js";

const VAULT = "/Users/john/private/md";
const DATA_DIR = join(homedir(), "Library", "Application Support", "you-brain");
const MANIFEST_PATH = join(DATA_DIR, "obsidian-import.json");
const ROOT_TITLE = "Obsidian";
const DRY = process.argv.includes("--dry");

/** Top-level dirs that hold attachments or non-content artifacts. */
const SKIP_DIRS = new Set(["pic", "Templates", "Excalidraw", "_infio_prompts", "node_modules"]);

const NOTION = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

// --- Notion API ------------------------------------------------------------

const token = Bun.spawnSync(["security", "find-generic-password", "-s", "you-brain/notion", "-a", "token", "-w"])
  .stdout.toString().trim();
if (!token) {
  console.error("Keychain 里没有 you-brain/notion 令牌");
  process.exit(1);
}

let lastCall = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = Record<string, unknown>>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    const gap = 300 - (Date.now() - lastCall);
    if (gap > 0) await sleep(gap);
    lastCall = Date.now();
    let response: Response;
    try {
      response = await fetch(`${NOTION}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "notion-version": VERSION,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      if (attempt < 3) { await sleep(1000 * attempt); continue; }
      throw new Error(`网络错误:${path}`);
    }
    if (response.status === 429 && attempt < 6) { await sleep(1500 * attempt); continue; }
    if (response.status >= 500 && attempt < 3) { await sleep(1200 * attempt); continue; }
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text === "" ? null : JSON.parse(text); } catch { parsed = null; }
    if (!response.ok) {
      const err = (parsed as { message?: string } | null) ?? {};
      throw new Error(`HTTP ${response.status} ${path}:${err.message ?? text.slice(0, 200)}`);
    }
    return parsed as T;
  }
}

/** Upload local image bytes and return a file_upload id usable in blocks. */
export async function uploadImage(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
  const created = await api<{ id: string; upload_url: string }>("POST", "/file_uploads", {
    mode: "single_part",
    filename,
    content_type: mime,
  });
  // The binary part goes to /send as multipart form-data with a `file` field;
  // this gateway rejects a raw body and demands exact-case Notion-Version.
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), filename);
  const send = await fetch(`${NOTION}/file_uploads/${created.id}/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "Notion-Version": VERSION },
    body: form,
  });
  if (!send.ok) throw new Error(`上传失败 HTTP ${send.status}`);
  return created.id;
}

// --- Vault scan -------------------------------------------------------------

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listFiles(full));
    } else if (
      entry.name.endsWith(".md") &&
      !entry.name.endsWith(".excalidraw.md") &&
      statSync(full).size > 0
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Every non-hidden file in the vault, for resolving bare embed names. */
function listAllFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAllFiles(full));
    else out.push(full);
  }
  return out;
}

const contentFiles = listFiles(VAULT).sort((a, b) => a.localeCompare(b));
const allVaultFiles = listAllFiles(VAULT);

function resolveEmbed(name: string): string | null {
  const clean = name.split("|")[0].trim();
  const direct = join(VAULT, clean);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  const hit = allVaultFiles.find((f) => basename(f) === clean);
  return hit ?? null;
}

// --- Markdown → block tree --------------------------------------------------

export type MdNode = {
  kind:
    | "paragraph" | "heading" | "bulleted" | "numbered" | "todo" | "quote"
    | "callout" | "code" | "divider" | "table" | "image" | "frontmatter";
  level?: number;
  text?: string;
  language?: string;
  checked?: boolean;
  emoji?: string;
  color?: string;
  url?: string;
  caption?: string;
  rows?: string[][];
  children: MdNode[];
};

/** Notion 代码语言枚举是小写形式,不在表里的落到 plain text。 */
const CODE_LANGS: Record<string, string> = {
  python: "python", py: "python",
  shell: "bash", sh: "bash", bash: "bash", zsh: "bash", console: "bash",
  json: "json", js: "javascript", javascript: "javascript",
  ts: "typescript", typescript: "typescript",
  markdown: "markdown", md: "markdown",
  html: "html", css: "css", sql: "sql", yaml: "yaml", yml: "yaml",
  java: "java", go: "go", golang: "go", rust: "rust", c: "c", cpp: "c++",
  docker: "docker", dockerfile: "docker", diff: "diff", xml: "xml",
  mermaid: "mermaid", powershell: "powershell", pwsh: "powershell", ps1: "powershell",
};

function normalizeLang(raw: string): string {
  const key = raw.trim().toLowerCase();
  return CODE_LANGS[key] ?? "plain text";
}

const CALLOUT_STYLE: Record<string, { emoji: string; color: string }> = {
  note: { emoji: "📝", color: "blue" },
  info: { emoji: "ℹ️", color: "blue" },
  abstract: { emoji: "📄", color: "green" },
  summary: { emoji: "📄", color: "green" },
  tip: { emoji: "💡", color: "green" },
  hint: { emoji: "💡", color: "green" },
  success: { emoji: "✅", color: "green" },
  check: { emoji: "✅", color: "green" },
  question: { emoji: "❓", color: "orange" },
  warning: { emoji: "⚠️", color: "yellow" },
  caution: { emoji: "⚠️", color: "yellow" },
  danger: { emoji: "🚨", color: "red" },
  error: { emoji: "🚨", color: "red" },
  bug: { emoji: "🐞", color: "red" },
  example: { emoji: "📌", color: "purple" },
  quote: { emoji: "💬", color: "gray" },
};

/** Obsidian inline syntax → the subset markdownToSegments-style parsing understands. */
function preprocessInline(text: string): string {
  return text
    .replace(/!\[\[([^\]]+)\]\]/g, (_, n) => `〔图:${n.split("|")[0].trim()}〕`)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/==([^=]+)==/g, "**$1**")
    .replace(/__([^_]+)__/g, "**$1**")
    .replace(/\]\((?!https?:\/\/)[^)]*\)/g, "()"); // local file hrefs: keep label, drop link
}

/** Notion caps a single rich_text object at 2000 chars; split under it. */
function chunkContent(content: string, size = 1900): string[] {
  if (content.length <= size) return [content];
  const chunks: string[] = [];
  for (let at = 0; at < content.length; at += size) chunks.push(content.slice(at, at + size));
  return chunks;
}

/** Plain text (code, frontmatter, placeholders) as chunked rich_text. */
function plainRichText(content: string): Array<Record<string, unknown>> {
  return chunkContent(content).map((text) => ({
    type: "text",
    text: { content: text },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
  }));
}

/** Convert inline markdown to a Notion rich_text array (core parser + Obsidian preprocessing). */
function richText(markdown: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const segment of markdownToSegments(preprocessInline(markdown))) {
    const annotations = {
      bold: segment.bold,
      italic: segment.italic,
      strikethrough: segment.strikethrough,
      underline: segment.underline,
      code: segment.code,
      color: "default",
    };
    for (const text of chunkContent(segment.text)) {
      out.push({
        type: "text",
        text: segment.href ? { content: text, link: { url: segment.href } } : { content: text },
        annotations,
      });
    }
  }
  return out;
}

function parseFrontmatter(lines: string[]): MdNode | null {
  const entries: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (/^\s+-\s+/.test(line) && entries.length > 0) {
      const last = entries[entries.length - 1];
      const item = line.trim().slice(2).trim();
      entries[entries.length - 1] = /:\s*$/.test(last) ? `${last} ${item}` : `${last}, ${item}`;
    } else {
      entries.push(line.trim());
    }
  }
  if (entries.length === 0) return null;
  return { kind: "frontmatter", text: entries.slice(0, 25).join("\n"), children: [] };
}

function splitTableRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

/** Parse markdown into a block tree. Nesting comes from list indentation. */
export function parseMarkdown(source: string): MdNode[] {
  const rawLines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: MdNode[] = [];

  // Frontmatter
  let start = 0;
  if (rawLines[0]?.trim() === "---") {
    const close = rawLines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) {
      const fm = parseFrontmatter(rawLines.slice(1, close));
      if (fm) nodes.push(fm);
      start = close + 1;
    }
  }

  const indentWidth = (s: string): number => {
    let w = 0;
    for (const ch of s) w += ch === "\t" ? 2 : 1;
    return w;
  };
  const listStack: Array<{ width: number; node: MdNode }> = [];

  let i = start;
  while (i < rawLines.length) {
    const line = rawLines[i];

    // Code fence
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const language = normalizeLang(fence[1]);
      const body: string[] = [];
      i += 1;
      while (i < rawLines.length && !/^\s*```/.test(rawLines[i])) {
        body.push(rawLines[i]);
        i += 1;
      }
      i += 1;
      listStack.length = 0;
      nodes.push({ kind: "code", language, text: body.join("\n"), children: [] });
      continue;
    }

    // Table
    if (/^\s*\|.+\|/.test(line)) {
      const rows: string[][] = [];
      while (i < rawLines.length && /^\s*\|.+\|/.test(rawLines[i])) {
        if (!/^\s*\|[\s:|-]+\|?\s*$/.test(rawLines[i])) rows.push(splitTableRow(rawLines[i]));
        i += 1;
      }
      listStack.length = 0;
      if (rows.length > 0) nodes.push({ kind: "table", rows, children: [] });
      continue;
    }

    // Divider
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      listStack.length = 0;
      nodes.push({ kind: "divider", children: [] });
      i += 1;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      listStack.length = 0;
      nodes.push({
        kind: "heading",
        level: Math.min(3, heading[1].length),
        text: heading[2],
        children: [],
      });
      i += 1;
      continue;
    }

    // Quote / callout block (consecutive > lines)
    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < rawLines.length && /^\s*>/.test(rawLines[i])) {
        quoteLines.push(rawLines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      listStack.length = 0;
      const callout = quoteLines[0]?.match(/^\[!(\w+)\][+-]?\s*(.*)$/);
      if (callout) {
        const style = CALLOUT_STYLE[callout[1].toLowerCase()] ?? { emoji: "💡", color: "gray" };
        const body = [callout[2], ...quoteLines.slice(1)].filter((l) => l.trim() !== "").join("\n");
        nodes.push({ kind: "callout", emoji: style.emoji, color: style.color, text: body, children: [] });
      } else {
        const body = quoteLines.filter((l) => l.trim() !== "").join("\n");
        if (body !== "") nodes.push({ kind: "quote", text: body, children: [] });
      }
      continue;
    }

    // Standalone image embed: ![[name]] or ![alt](path)
    const embed = line.trim().match(/^!\[\[([^\]]+)\]\]$/) ?? line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (embed) {
      listStack.length = 0;
      const isWiki = line.trim().startsWith("![[" );
      const target = isWiki ? embed[1] : embed[2];
      const label = isWiki ? target.split("|")[0].trim() : embed[1];
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        // 保留原文
      }
      const resolved = resolveEmbed(isWiki ? decoded : decoded.split("|")[0]);
      const ext = extname(resolved ?? decoded).toLowerCase();
      if (resolved && IMAGE_EXT.has(ext)) {
        const mime = ext === ".jpg" ? "image/jpeg" : ext === ".svg" ? "image/svg+xml" : `image/${ext.slice(1)}`;
        nodes.push({ kind: "image", url: resolved, caption: label, children: [], language: mime });
      } else if (/^https?:\/\//.test(decoded)) {
        nodes.push({ kind: "image", url: decoded, caption: label, children: [], language: "" });
      } else {
        nodes.push({ kind: "paragraph", text: `〔图:${label}〕`, children: [] });
      }
      i += 1;
      continue;
    }

    // List items (may nest)
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      const width = indentWidth(item[1]);
      let content = item[3];
      let kind: MdNode["kind"] = /^\d/.test(item[2]) ? "numbered" : "bulleted";
      const todo = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (todo) {
        kind = "todo";
        content = todo[2];
      }
      const node: MdNode = { kind, text: content, children: [] };
      if (kind === "todo") node.checked = todo![1].toLowerCase() === "x";
      while (listStack.length > 0 && listStack[listStack.length - 1].width >= width) listStack.pop();
      if (listStack.length > 0) listStack[listStack.length - 1].node.children.push(node);
      else nodes.push(node);
      listStack.push({ width, node });
      i += 1;
      continue;
    }

    // Blank line breaks list nesting context
    if (line.trim() === "") {
      listStack.length = 0;
      i += 1;
      continue;
    }

    // Paragraph (single line)
    listStack.length = 0;
    nodes.push({ kind: "paragraph", text: line, children: [] });
    i += 1;
  }
  return nodes;
}

// --- Block tree → Notion API payloads ---------------------------------------

export function toPayload(node: MdNode): Record<string, unknown> {
  switch (node.kind) {
    case "heading":
      return { object: "block", type: `heading_${node.level}`, [`heading_${node.level}`]: { rich_text: richText(node.text ?? "") } };
    case "bulleted":
      return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(node.text ?? "") } };
    case "numbered":
      return { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: richText(node.text ?? "") } };
    case "todo":
      return { object: "block", type: "to_do", to_do: { rich_text: richText(node.text ?? ""), checked: node.checked === true } };
    case "quote":
      return { object: "block", type: "quote", quote: { rich_text: richText(node.text ?? "") } };
    case "callout":
      return {
        object: "block",
        type: "callout",
        callout: {
          rich_text: richText(node.text ?? ""),
          icon: { type: "emoji", emoji: node.emoji ?? "💡" },
          color: node.color ?? "gray",
        },
      };
    case "code":
      return { object: "block", type: "code", code: { rich_text: plainRichText(node.text ?? ""), language: node.language ?? "plain text" } };
    case "divider":
      return { object: "block", type: "divider", divider: {} };
    case "frontmatter":
      return {
        object: "block",
        type: "callout",
        callout: {
          rich_text: plainRichText(node.text ?? ""),
          icon: { type: "emoji", emoji: "📋" },
          color: "gray",
        },
      };
    case "table": {
      const rows = node.rows ?? [];
      const width = Math.max(...rows.map((r) => r.length), 1);
      return {
        object: "block",
        type: "table",
        table: {
          table_width: width,
          has_column_header: true,
          has_row_header: false,
          children: rows.map((cells) => ({
            object: "block",
            type: "table_row",
            table_row: {
              cells: Array.from({ length: width }, (_, c) => richText(cells[c] ?? "")),
            },
          })),
        },
      };
    }
    case "image":
      return {
        object: "block",
        type: "image",
        image: node.url!.startsWith("http")
          ? { type: "external", external: { url: node.url } }
          : { type: "file_upload", file_upload: { id: node.url } },
      };
    default:
      return { object: "block", type: "paragraph", paragraph: { rich_text: richText(node.text ?? "") } };
  }
}

/**
 * Append a block tree under a parent, level by level: the children-append
 * endpoint rejects any top-level `children` key on a block, so nesting is
 * built with follow-up calls keyed on the returned block ids.
 */
export async function pushTree(parentId: string, nodes: MdNode[]): Promise<void> {
  for (let start = 0; start < nodes.length; start += 100) {
    const chunk = nodes.slice(start, start + 100);
    const response = await api<{ results: Array<{ id: string }> }>(
      "PATCH",
      `/blocks/${parentId}/children`,
      { children: chunk.map((node) => toPayload(node)) },
    );
    for (let k = 0; k < chunk.length; k += 1) {
      const createdId = response.results[k]?.id;
      if (createdId && chunk[k].children.length > 0) {
        await pushTree(createdId, chunk[k].children);
      }
    }
  }
}

// --- Page creation ----------------------------------------------------------

function sanitizeTitle(name: string): string {
  return name.replace(/\.md$/i, "").replace(/[\n\r]+/g, " ").trim() || "未命名";
}

async function createPage(options: {
  parentId?: string;
  workspace?: boolean;
  title: string;
  icon?: string;
  nodes: MdNode[];
}): Promise<string> {
  const parent = options.workspace
    ? { type: "workspace", workspace: true }
    : { type: "page_id", page_id: options.parentId };
  const body: Record<string, unknown> = {
    parent,
    properties: { title: { title: [{ type: "text", text: { content: options.title } }] } },
    ...(options.icon ? { icon: { type: "emoji", emoji: options.icon } } : {}),
  };
  const created = await api<{ id: string }>("POST", "/pages", body);
  try {
    await pushTree(created.id, options.nodes);
  } catch (error) {
    // 半成品页面留着的只会变成孤儿页;归档掉,manifest 不记,rerun 重来。
    await api("DELETE", `/blocks/${created.id}`).catch(() => {});
    throw error;
  }
  return created.id;
}

// --- Manifest ---------------------------------------------------------------

interface Manifest {
  vault: string;
  rootPageId: string;
  folders: Record<string, string>;
  files: Record<string, string>;
  importedAt: string;
}

function loadManifest(): Manifest {
  if (existsSync(MANIFEST_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
      if (parsed.vault === VAULT) return parsed;
    } catch {
      // 损坏的 manifest 视为没有
    }
  }
  return { vault: VAULT, rootPageId: "", folders: {}, files: {}, importedAt: "" };
}

function saveManifest(manifest: Manifest): void {
  manifest.importedAt = new Date().toISOString();
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

// --- Image upload pass ------------------------------------------------------

async function materializeImages(nodes: MdNode[]): Promise<void> {
  for (const node of nodes) {
    if (node.kind === "image" && node.url && !node.url.startsWith("http")) {
      try {
        const bytes = new Uint8Array(readFileSync(node.url));
        node.url = await uploadImage(bytes, basename(node.url), node.language || "image/png");
      } catch (error) {
        const label = node.caption ?? basename(node.url);
        console.warn(`  ⚠ 图片上传失败,留占位:${label}(${error instanceof Error ? error.message : error})`);
        node.kind = "paragraph";
        node.text = `〔图:${label}〕`;
      }
    }
    await materializeImages(node.children);
  }
}

// --- Main --------------------------------------------------------------------

interface PlanEntry {
  rel: string;
  isDir: boolean;
  title: string;
  parentRel: string;
  fileCount: number;
}

function buildPlan(): PlanEntry[] {
  const entries: PlanEntry[] = [];
  const dirSet = new Set<string>();
  for (const file of contentFiles) {
    const rel = relative(VAULT, file);
    const parts = rel.split("/");
    for (let d = 1; d < parts.length; d += 1) dirSet.add(parts.slice(0, d).join("/"));
  }
  for (const dir of [...dirSet].sort((a, b) => a.localeCompare(b))) {
    const fileCount = contentFiles.filter((f) => relative(VAULT, f).startsWith(`${dir}/`)).length;
    entries.push({ rel: dir, isDir: true, title: basename(dir), parentRel: dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "", fileCount });
  }
  for (const file of contentFiles) {
    const rel = relative(VAULT, file);
    const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    entries.push({ rel, isDir: false, title: sanitizeTitle(basename(file)), parentRel, fileCount: 0 });
  }
  return entries;
}

function pageTitle(raw: Record<string, unknown>): string {
  const properties = (raw.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const property of Object.values(properties)) {
    if (property?.type !== "title") continue;
    const parts = (property.title ?? []) as Array<Record<string, unknown>>;
    return parts.map((part) => String(part.plain_text ?? "")).join("");
  }
  return "";
}

/**
 * One-off cleanup: the first (buggy) run created empty pages for files that
 * failed mid-import. Walk the already-imported folder pages, find child pages
 * that carry a pending file's title but no content, and archive them.
 */
async function cleanOrphans(): Promise<void> {
  const manifest = loadManifest();
  const pending = new Map(buildPlan().filter((e) => !e.isDir && !manifest.files[e.rel]).map((e) => [e.title, e]));
  console.log(`清扫孤儿页:${Object.keys(manifest.folders).length} 个目录页里找 ${pending.size} 个未入库文件的同名页…`);
  let removed = 0;
  for (const [folderRel, folderId] of Object.entries(manifest.folders)) {
    let cursor: string | undefined;
    do {
      const page: Record<string, unknown> = {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      };
      const listing = await api<{ results: Array<Record<string, unknown>>; next_cursor: string | null; has_more: boolean }>(
        "GET",
        `/blocks/${folderId}/children?${new URLSearchParams(Object.entries(page).map(([k, v]) => [k, String(v)])).toString()}`,
      );
      for (const block of listing.results) {
        if (block.type !== "child_page") continue;
        const title = String((block.child_page as Record<string, unknown>).title ?? "");
        const entry = pending.get(title);
        if (!entry || entry.parentRel !== folderRel) continue;
        // 首轮失败页只带了个前缀块,直接归档,重导会补全量内容。
        await api("DELETE", `/blocks/${block.id}`);
        pending.delete(title);
        removed += 1;
        console.log(`  🗑 归档半成品页:${folderRel}/${title}`);
      }
      cursor = listing.has_more && listing.next_cursor ? listing.next_cursor : undefined;
    } while (cursor);
  }
  console.log(`清扫完成,归档 ${removed} 个孤儿页`);
}

async function main(): Promise<void> {
  // Debug: print the parsed block tree of one file without any API calls.
  const parseTarget = process.argv.find((arg) => arg.startsWith("--parse="));
  if (parseTarget) {
    const file = parseTarget.slice("--parse=".length);
    const nodes = parseMarkdown(readFileSync(file, "utf8"));
    console.log(JSON.stringify(nodes, null, 2).slice(0, 6000));
    return;
  }

  if (process.argv.includes("--clean")) {
    await cleanOrphans();
    return;
  }

  const plan = buildPlan();
  const dirCount = plan.filter((e) => e.isDir).length;
  console.log(`Obsidian 库:${VAULT}`);
  console.log(`待导入:${dirCount} 个目录页 + ${contentFiles.length - dirCount} 篇笔记 → 根页面「${ROOT_TITLE}」`);
  if (plan.length === 0) {
    console.log("没有可导入的内容");
    return;
  }
  if (DRY) {
    for (const entry of plan) {
      console.log(`${"  ".repeat(entry.rel.split("/").length - 1)}${entry.isDir ? "📁" : "📄"} ${entry.isDir ? entry.title : entry.title}${entry.isDir ? ` (${entry.fileCount})` : ""}`);
    }
    return;
  }

  const manifest = loadManifest();
  if (!manifest.rootPageId) {
    // Prefer a workspace-level root; fall back to under the first shared page.
    try {
      manifest.rootPageId = await createPage({ workspace: true, title: ROOT_TITLE, icon: "📓", nodes: [] });
      console.log(`已创建工作区根页面「${ROOT_TITLE}」:${manifest.rootPageId}`);
    } catch (error) {
      const search = await api<{ results: Array<{ id: string; object: string; parent?: Record<string, unknown> }> }>(
        "POST",
        "/search",
        { page_size: 20, filter: { value: "page", property: "object" } },
      );
      const root = search.results.find((r) => r.parent?.workspace === true) ?? search.results[0];
      if (!root) throw error;
      manifest.rootPageId = root.id;
      console.log(`无法建工作区级页面,改为挂在已有页面下:${manifest.rootPageId}`);
    }
    saveManifest(manifest);
  }

  let done = 0;
  let failed = 0;
  for (const entry of plan) {
    const existing = entry.isDir ? manifest.folders[entry.rel] : manifest.files[entry.rel];
    if (existing) {
      done += 1;
      continue;
    }
    try {
      const parentId = entry.parentRel === "" ? manifest.rootPageId : manifest.folders[entry.parentRel];
      if (!parentId) throw new Error(`父页面缺失:${entry.parentRel}`);
      let pageId: string;
      if (entry.isDir) {
        pageId = await createPage({ parentId, title: entry.title, icon: "📁", nodes: [] });
        manifest.folders[entry.rel] = pageId;
      } else {
        const nodes = parseMarkdown(readFileSync(join(VAULT, entry.rel), "utf8"));
        await materializeImages(nodes);
        pageId = await createPage({ parentId, title: entry.title, nodes });
        manifest.files[entry.rel] = pageId;
      }
      saveManifest(manifest);
      done += 1;
      console.log(`[${done}/${plan.length}] ${entry.isDir ? "📁" : "📄"} ${entry.rel}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${entry.rel}:${error instanceof Error ? error.message : error}`);
      if (failed >= 10) {
        console.error("连续失败过多,停止。已导入的部分记录在 manifest,修复后重跑即可续传。");
        break;
      }
    }
  }
  console.log(`\n完成:${done - failed} 新建 + ${Object.keys(manifest.files).length + Object.keys(manifest.folders).length - (done - failed)} 已存在,${failed} 失败`);
  console.log(`根页面:https://notion.so/${manifest.rootPageId.replaceAll("-", "")}`);
}

if (import.meta.main) {
  await main();
}
