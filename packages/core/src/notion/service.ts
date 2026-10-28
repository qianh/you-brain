import { join } from "node:path";

import { getNotionToken, setNotionToken, type NotionSecretOptions } from "../auth/notion-secrets.js";
import { YouBrainError } from "../domain/errors.js";

import {
  NotionApiClient,
  NotionApiError,
  propertiesToPlainText,
  propertyValueText,
  titleOfPage,
  type NotionPageStub,
} from "./api-client.js";
import { blocksToMarkdown, type NotionBlockModel } from "./model.js";
import { NotionIndex } from "./store.js";
import { NotionSync, type NotionSyncSummary } from "./sync.js";
import type { NotionDatabaseView, NotionPageView } from "../http/types.js";

export type { NotionDatabaseView, NotionPageView };

export interface NotionTreeNode {
  id: string;
  object: "page" | "database";
  title: string;
  icon: string | null;
  children: NotionTreeNode[];
}

export interface NotionStatus {
  hasToken: boolean;
  pages: number;
  lastSyncAt: string | null;
  lastError: string | null;
  syncing: boolean;
  /** Summary of the most recent pass (memory only). */
  lastRun?: NotionSyncSummary;
}

/** Only Notion-owned hosts may be proxied; other images load in the browser directly. */
const PROXY_HOST_SUFFIXES = [".amazonaws.com", ".notion.so", "notion.so"];

export class NotionService {
  readonly #dataDir: string;
  readonly #secretOptions: NotionSecretOptions;
  readonly #fetch: typeof fetch | undefined;
  #index: NotionIndex | null = null;
  #client: NotionApiClient | null = null;
  #token: string | null = null;
  #syncing = false;
  #lastError: string | null = null;
  #lastRun: NotionSyncSummary | undefined;

  constructor(options: { dataDir: string; fetch?: typeof fetch } & NotionSecretOptions) {
    this.#dataDir = options.dataDir;
    this.#fetch = options.fetch;
    this.#secretOptions = {
      platform: options.platform,
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.store ? { store: options.store } : {}),
    };
  }

  close(): void {
    this.#index?.close();
    this.#index = null;
  }

  #openIndex(): NotionIndex {
    if (!this.#index) {
      this.#index = new NotionIndex(join(this.#dataDir, "notion-index.sqlite"));
    }
    return this.#index;
  }

  async #openClient(): Promise<NotionApiClient | null> {
    if (!this.#client) {
      this.#token ??= await getNotionToken(this.#secretOptions);
      if (!this.#token) return null;
      this.#client = new NotionApiClient({
        token: this.#token,
        ...(this.#fetch ? { fetch: this.#fetch } : {}),
      });
    }
    return this.#client;
  }

  async setToken(token: string): Promise<void> {
    await setNotionToken(token, this.#secretOptions);
    this.#client = null;
    this.#token = null;
  }

  async hasToken(): Promise<boolean> {
    return (await this.#openClient()) !== null;
  }

  async testConnection(): Promise<{ ok: true; name: string; workspaceName: string | null } | { ok: false; error: string }> {
    const client = await this.#openClient();
    if (!client) return { ok: false, error: "还没有保存 Notion 集成令牌" };
    try {
      const me = await client.me();
      return { ok: true, name: me.name, workspaceName: me.workspaceName };
    } catch (error) {
      return { ok: false, error: describeNotionError(error) };
    }
  }

  async status(): Promise<NotionStatus> {
    const hasToken = (await this.#openClient()) !== null;
    const index = this.#openIndex();
    return {
      hasToken,
      pages: index.countPages(),
      lastSyncAt: index.meta("lastSyncAt"),
      lastError: this.#lastError,
      syncing: this.#syncing,
      ...(this.#lastRun ? { lastRun: this.#lastRun } : {}),
    };
  }

  /** One bounded sync pass. Safe to call concurrently — later calls wait. */
  async sync(budgetMs?: number): Promise<NotionSyncSummary> {
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    if (this.#syncing) {
      return { objectsSeen: 0, pagesSynced: 0, databasesSynced: 0, removed: 0, failed: 0, pending: 1, error: null };
    }
    this.#syncing = true;
    try {
      const sync = new NotionSync(client, this.#openIndex());
      const summary = await sync.syncAll(budgetMs === undefined ? {} : { budgetMs });
      this.#lastRun = summary;
      this.#lastError = summary.error ?? (summary.failed > 0 ? `${summary.failed} 个对象同步失败` : null);
      return summary;
    } catch (error) {
      this.#lastError = describeNotionError(error);
      throw error;
    } finally {
      this.#syncing = false;
    }
  }

  /** Workspace tree, database rows excluded (they render inside their database). */
  async tree(): Promise<NotionTreeNode[]> {
    const index = this.#openIndex();
    const pages = index.listPages().filter((page) => page.parentKind !== "database");
    const nodes = new Map<string, NotionTreeNode>();
    for (const page of pages) {
      nodes.set(page.pageId, {
        id: page.pageId,
        object: page.object,
        title: page.title === "" ? "未命名" : page.title,
        icon: page.icon,
        children: [],
      });
    }
    const roots: NotionTreeNode[] = [];
    for (const page of pages) {
      const node = nodes.get(page.pageId);
      if (!node) continue;
      const parent =
        page.parentKind === "workspace" || page.parentId === null
          ? null
          : nodes.get(page.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sortNode = (node: NotionTreeNode): void => {
      node.children.sort((a, b) => a.title.localeCompare(b.title));
      for (const child of node.children) sortNode(child);
    };
    roots.sort((a, b) => a.title.localeCompare(b.title));
    for (const root of roots) sortNode(root);
    return roots;
  }

  async page(pageId: string): Promise<NotionPageView | null> {
    const index = this.#openIndex();
    const pages = index.listPages();
    const meta = pages.find((page) => page.pageId === pageId);
    if (!meta) return null;
    const blocks = index.pageBlocks(pageId);
    const isRow = meta.parentKind === "database";
    let properties: Record<string, string> | undefined;
    if (isRow && meta.parentId) {
      const database = index.database(meta.parentId);
      const row = database?.rows.find((candidate) => candidate.rowPageId === pageId);
      if (row) {
        properties = flattenCells(row.cells);
      }
    }
    return {
      id: pageId,
      title: meta.title === "" ? "未命名" : meta.title,
      icon: meta.icon,
      coverUrl: meta.coverUrl,
      lastEditedTime: meta.lastEditedTime,
      blocks,
      markdown: blocksToMarkdown(blocks),
      ...(properties ? { properties } : {}),
    };
  }

  search(query: string, limit = 20) {
    return this.#openIndex().search(query, limit);
  }

  database(databaseId: string) {
    return this.#openIndex().database(databaseId);
  }

  /** Database rendered for the knowledge base view: ordered columns + text cells. */
  databaseView(databaseId: string): NotionDatabaseView | null {
    const db = this.#openIndex().database(databaseId);
    if (!db) return null;
    const schema = db.schema as Record<string, Record<string, unknown>>;
    const columns = Object.entries(schema).map(([name, def]) => ({
      name,
      type: String(def.type ?? "unknown"),
    }));
    const rows = db.rows.map((row) => {
      const cells = columns.map((column) => ({
        name: column.name,
        type: column.type,
        text: propertyValueText(row.cells[column.name]),
      }));
      return { id: row.rowPageId, title: row.title, icon: row.icon, cells };
    });
    return { databaseId: db.databaseId, title: db.title, columns, rows };
  }

  /** Resolve a block's file URL for the asset proxy. Notion-hosted URLs only. */
  async asset(blockId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const url = await this.assetUrl(blockId);
    if (!url) return null;
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 24 * 1024 * 1024) return null;
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get("content-type") ?? guessContentType(url),
    };
  }

  async assetUrl(blockId: string): Promise<string | null> {
    const index = this.#openIndex();
    const pageId = index.blockPage(blockId);
    if (!pageId) return null;
    const find = (models: readonly NotionBlockModel[]): string | null => {
      for (const model of models) {
        if (model.id === blockId) {
          if (model.kind === "image" || model.kind === "file" || model.kind === "pdf" || model.kind === "bookmark") {
            return model.url;
          }
          return null;
        }
        const nested = find(model.children);
        if (nested) return nested;
      }
      return null;
    };
    const url = find(index.pageBlocks(pageId));
    if (!url) return null;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return null;
    }
    const allowed = PROXY_HOST_SUFFIXES.some(
      (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
    );
    return allowed ? url : null;
  }

  /** Plain markdown for MCP `get_notion_page`. */
  async pageMarkdown(pageId: string): Promise<string | null> {
    const view = await this.page(pageId);
    if (!view) return null;
    const header = view.properties
      ? Object.entries(view.properties)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\n")
      : "";
    const body = view.markdown;
    return header === "" ? `# ${view.title}\n\n${body}` : `# ${view.title}\n\n${header}\n\n${body}`;
  }
}

function flattenCells(cells: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(cells)) {
    const text = cellDisplay(value);
    if (text !== "") out[name] = text;
  }
  return out;
}

/** One-line display for a raw property cell on the page detail view. */
function cellDisplay(value: unknown): string {
  const property = value as Record<string, unknown>;
  if (!property || typeof property !== "object") return "";
  const type = property.type;
  if (type === "title") return "";
  return propertyValueLine(property);
}

function propertyValueLine(property: Record<string, unknown>): string {
  const type = property.type;
  if (type === "rich_text") {
    const parts = Array.isArray(property.rich_text) ? (property.rich_text as Array<Record<string, unknown>>) : [];
    return parts.map((part) => String(part.plain_text ?? "")).join("");
  }
  if (type === "number" || type === "url" || type === "email") {
    return property[type] === null || property[type] === undefined ? "" : String(property[type]);
  }
  if (type === "date") {
    const date = property.date as Record<string, unknown> | null;
    return date ? [date.start, date.end].filter(Boolean).join(" → ") : "";
  }
  if (type === "checkbox") return property.checkbox === true ? "✓" : "";
  return propertiesToPlainText({ [String(type)]: property });
}

export function describeNotionError(error: unknown): string {
  if (error instanceof NotionApiError) {
    if (error.status === 401) return "Notion 令牌无效或已被撤销";
    if (error.status === 403) return "该页面没有共享给集成";
    if (error.status === 404) return "对象不存在或没有共享给集成";
    if (error.status === 429) return "请求太快,被 Notion 限流";
    return `Notion API 错误:${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function guessContentType(url: string): string {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

/** Used by tests and the MCP layer to render stub titles consistently. */
export function stubTitle(stub: NotionPageStub, raw?: Record<string, unknown>): string {
  if (stub.title !== "") return stub.title;
  if (raw) return titleOfPage(raw);
  return "未命名";
}
