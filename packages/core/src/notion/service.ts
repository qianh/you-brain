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
import { blocksToMarkdown, type NotionBlockModel, type NotionSegment } from "./model.js";
import { markdownToSegments, segmentsToMarkdown } from "./markdown-text.js";
import { NotionIndex } from "./store.js";
import { NotionSync, type NotionSyncSummary } from "./sync.js";
import type { NotionDatabaseView, NotionPageView } from "../http/types.js";

export type { NotionDatabaseView, NotionPageView };

/** Block kinds whose text can be edited in place. */
const EDITABLE_KINDS = new Set([
  "paragraph",
  "heading",
  "bulleted",
  "numbered",
  "todo",
  "quote",
  "callout",
  "toggle",
  "code",
]);

/** Turn-into targets the UI offers, mapped to block model kinds. */
const TURN_INTO_KINDS = new Set([
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bulleted",
  "numbered",
  "todo",
  "quote",
  "callout",
  "toggle",
  "code",
]);

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

/** NotionSegment → API rich_text 形状(写入端必须用 API 形状,不是渲染模型)。 */
function segmentsToRichText(segments: readonly NotionSegment[]): Array<Record<string, unknown>> {
  return segments.map((segment) => ({
    type: "text",
    plain_text: segment.text,
    text: segment.href
      ? { content: segment.text, link: { url: segment.href } }
      : { content: segment.text },
    href: segment.href,
    annotations: {
      bold: segment.bold,
      italic: segment.italic,
      strikethrough: segment.strikethrough,
      underline: segment.underline,
      code: segment.code,
      color: segment.color,
    },
  }));
}

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

  // --- 写操作(有限编辑) --------------------------------------------------

  #syncEngine(): NotionSync {
    const client = this.#client;
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    return new NotionSync(client, this.#openIndex());
  }

  /** Which page a block belongs to, from the index. */
  #pageOfBlock(blockId: string): string {
    const pageId = this.#openIndex().blockPage(blockId);
    if (!pageId) throw new YouBrainError("INVALID_INPUT", "块不在已同步的页面里,先同步知识库");
    return pageId;
  }

  #blockModel(pageId: string, blockId: string): NotionBlockModel {
    const find = (models: readonly NotionBlockModel[]): NotionBlockModel | null => {
      for (const model of models) {
        if (model.id === blockId) return model;
        const nested = find(model.children);
        if (nested) return nested;
      }
      return null;
    };
    const model = find(this.#openIndex().pageBlocks(pageId));
    if (!model) throw new YouBrainError("INVALID_INPUT", "块不存在,先同步知识库");
    return model;
  }

  #assertEditable(model: NotionBlockModel): void {
    if (!EDITABLE_KINDS.has(model.kind)) {
      throw new YouBrainError("INVALID_INPUT", `「${model.kind}」类型的内容暂不支持在 you-brain 编辑`);
    }
  }

  /** Build the PATCH body matching the block's own type. */
  #patchBody(model: NotionBlockModel, markdown: string, rich?: NotionSegment[]): Record<string, unknown> {
    if (model.kind === "code") {
      return {
        type: "code",
        code: {
          rich_text: [{ type: "text", text: { content: markdown } }],
          ...(model.language ? { language: model.language } : {}),
        },
      };
    }
    const richText = segmentsToRichText(
      rich && rich.length > 0 ? rich : markdownToSegments(markdown),
    );
    const types: Record<string, string> = {
      paragraph: "paragraph",
      heading: `heading_${model.kind === "heading" ? model.level : 1}`,
      bulleted: "bulleted_list_item",
      numbered: "numbered_list_item",
      todo: "to_do",
      quote: "quote",
      callout: "callout",
      toggle: "toggle",
    };
    const type = types[model.kind] ?? "paragraph";
    const payload: Record<string, unknown> = { rich_text: richText };
    if (model.kind === "todo") payload.checked = model.checked;
    if (model.kind === "callout") {
      payload.icon = model.emoji ? { type: "emoji", emoji: model.emoji } : undefined;
      payload.color = model.color;
    }
    return { type, [type]: payload };
  }

  /** Synthetic model for a turn-into target, reusing the source's text. */
  #modelForKind(target: TurnIntoKind, source: NotionBlockModel): NotionBlockModel {
    const base = { id: source.id, children: source.children };
    const markdown = this.#modelMarkdown(source);
    switch (target) {
      case "heading1":
        return { ...base, kind: "heading", level: 1, segments: markdownToSegments(markdown) };
      case "heading2":
        return { ...base, kind: "heading", level: 2, segments: markdownToSegments(markdown) };
      case "heading3":
        return { ...base, kind: "heading", level: 3, segments: markdownToSegments(markdown) };
      case "bulleted":
        return { ...base, kind: "bulleted", segments: markdownToSegments(markdown) };
      case "numbered":
        return { ...base, kind: "numbered", segments: markdownToSegments(markdown) };
      case "todo":
        return {
          ...base,
          kind: "todo",
          segments: markdownToSegments(markdown),
          checked: source.kind === "todo" ? source.checked : false,
        };
      case "quote":
        return { ...base, kind: "quote", segments: markdownToSegments(markdown) };
      case "callout":
        return {
          ...base,
          kind: "callout",
          segments: markdownToSegments(markdown),
          emoji: source.kind === "callout" ? source.emoji : "💡",
          color: source.kind === "callout" ? source.color : "default",
        };
      case "toggle":
        return { ...base, kind: "toggle", segments: markdownToSegments(markdown) };
      case "code":
        return { ...base, kind: "code", language: source.kind === "code" ? source.language : "plain text", text: markdown, caption: [] };
      default:
        return { ...base, kind: "paragraph", segments: markdownToSegments(markdown) };
    }
  }

  /** Current text of a block as markdown (code blocks: raw text). */
  #modelMarkdown(model: NotionBlockModel): string {
    if (model.kind === "code") return model.text;
    if (model.kind === "paragraph") return segmentsToMarkdown(model.segments);
    if (model.kind === "heading" || model.kind === "todo") return segmentsToMarkdown(model.segments);
    if (
      model.kind === "bulleted" ||
      model.kind === "numbered" ||
      model.kind === "quote" ||
      model.kind === "callout" ||
      model.kind === "toggle"
    ) {
      return segmentsToMarkdown(model.segments);
    }
    if (model.kind === "equation") return model.expression;
    return "";
  }

  async updateBlock(
    blockId: string,
    markdown: string,
    turnInto?: TurnIntoKind | undefined,
    checkedOverride?: boolean | undefined,
    rich?: NotionSegment[] | undefined,
  ): Promise<NotionPageView> {
    const pageId = this.#pageOfBlock(blockId);
    const model = this.#blockModel(pageId, blockId);
    const target =
      turnInto && TURN_INTO_KINDS.has(turnInto) && turnInto !== "paragraph"
        ? this.#modelForKind(turnInto, model)
        : turnInto === "paragraph"
          ? this.#modelForKind("paragraph", model)
          : model;
    this.#assertEditable(target);
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    const body = this.#patchBody(target, markdown.trim(), rich);
    if (checkedOverride !== undefined) {
      const payload = body[typeof body.type === "string" ? body.type : ""] as
        | Record<string, unknown>
        | undefined;
      if (payload) payload.checked = checkedOverride;
    }
    await client.updateBlock(blockId, body);
    await this.#syncEngine().resyncPage(pageId);
    const view = await this.page(pageId);
    if (!view) throw new YouBrainError("INVALID_INPUT", "页面刷新失败");
    return view;
  }

  async appendBlock(
    input: {
      pageId?: string | undefined;
      afterBlockId?: string | undefined;
      markdown: string;
      kind?: string | undefined;
      rich?: NotionSegment[] | undefined;
    },
  ): Promise<NotionPageView> {
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    const pageId = input.pageId ?? (input.afterBlockId ? this.#pageOfBlock(input.afterBlockId) : null);
    if (!pageId) throw new YouBrainError("INVALID_INPUT", "缺少 pageId 或 afterBlockId");
    const child = this.#newBlockChild(input.kind ?? "paragraph", input.markdown, input.rich);
    // afterBlockId 是兄弟:父级取它的父级,靠 `after` 参数定位插入点。
    const parentId = input.afterBlockId
      ? (this.#locate(pageId, input.afterBlockId)?.parentId ?? pageId)
      : pageId;
    await client.appendBlocks(parentId, [child], input.afterBlockId);
    await this.#syncEngine().resyncPage(pageId);
    const view = await this.page(pageId);
    if (!view) throw new YouBrainError("INVALID_INPUT", "页面刷新失败");
    return view;
  }

  /** Fresh block payload for the "add block" menu kinds. */
  #newBlockChild(kind: string, markdown: string, rich?: NotionSegment[]): Record<string, unknown> {
    const richText = segmentsToRichText(
      rich && rich.length > 0 ? rich : markdownToSegments(markdown),
    );
    switch (kind) {
      case "bulleted":
        return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText } };
      case "numbered":
        return { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: richText } };
      case "todo":
        return { object: "block", type: "to_do", to_do: { rich_text: richText, checked: false } };
      case "heading1":
        return { object: "block", type: "heading_1", heading_1: { rich_text: richText } };
      case "heading2":
        return { object: "block", type: "heading_2", heading_2: { rich_text: richText } };
      case "heading3":
        return { object: "block", type: "heading_3", heading_3: { rich_text: richText } };
      case "quote":
        return { object: "block", type: "quote", quote: { rich_text: richText } };
      case "callout":
        return {
          object: "block",
          type: "callout",
          callout: { rich_text: richText, icon: { type: "emoji", emoji: "💡" }, color: "default" },
        };
      case "toggle":
        return { object: "block", type: "toggle", toggle: { rich_text: richText } };
      case "code":
        return {
          object: "block",
          type: "code",
          code: { rich_text: [{ type: "text", text: { content: markdown } }], language: "plain text" },
        };
      case "divider":
        return { object: "block", type: "divider", divider: {} };
      default:
        return { object: "block", type: "paragraph", paragraph: { rich_text: richText } };
    }
  }

  /**
   * Move a childless block one position up or down by copying itself after the
   * right neighbor and archiving the original — the API has no move endpoint.
   * Blocks with children are refused: a copy would strand them.
   */
  async moveBlock(blockId: string, direction: "up" | "down"): Promise<NotionPageView> {
    const pageId = this.#pageOfBlock(blockId);
    const model = this.#blockModel(pageId, blockId);
    this.#assertEditable(model);
    if (model.children.length > 0) {
      throw new YouBrainError("INVALID_INPUT", "带子块的内容暂不支持移动");
    }
    const located = this.#locate(pageId, blockId);
    if (!located) throw new YouBrainError("INVALID_INPUT", "块不在页面里");
    const { list, index, parentId } = located;
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    const neighborIndex = direction === "up" ? index - 1 : index + 1;
    const neighbor = list[neighborIndex];
    if (!neighbor) {
      const unchanged = await this.page(pageId);
      if (!unchanged) throw new YouBrainError("INVALID_INPUT", "页面刷新失败");
      return unchanged;
    }
    this.#assertEditable(neighbor);
    if (neighbor.children.length > 0) {
      throw new YouBrainError("INVALID_INPUT", "相邻块带有子块,暂不支持移动");
    }
    // Move up = move the previous sibling down; move down = insert after the next one.
    const copyOfSelf = { ...this.#patchBody(model, this.#modelMarkdown(model)), object: "block" as const };
    const parentForInsert = parentId ?? pageId;
    if (direction === "down") {
      await client.appendBlocks(parentForInsert, [copyOfSelf], neighbor.id);
      await client.deleteBlock(blockId);
    } else {
      const copyOfNeighbor = { ...this.#patchBody(neighbor, this.#modelMarkdown(neighbor)), object: "block" as const };
      await client.appendBlocks(parentForInsert, [copyOfNeighbor], model.id);
      await client.deleteBlock(neighbor.id);
    }
    await this.#syncEngine().resyncPage(pageId);
    const view = await this.page(pageId);
    if (!view) throw new YouBrainError("INVALID_INPUT", "页面刷新失败");
    return view;
  }

  /** Duplicate a childless block right below itself. */
  async duplicateBlock(blockId: string): Promise<NotionPageView> {
    const pageId = this.#pageOfBlock(blockId);
    const model = this.#blockModel(pageId, blockId);
    this.#assertEditable(model);
    if (model.children.length > 0) {
      throw new YouBrainError("INVALID_INPUT", "带子块的内容暂不支持复制");
    }
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    const copy = { ...this.#patchBody(model, this.#modelMarkdown(model)), object: "block" as const };
    const parent = this.#locate(pageId, blockId)?.parentId ?? pageId;
    await client.appendBlocks(parent, [copy], blockId);
    await this.#syncEngine().resyncPage(pageId);
    const view = await this.page(pageId);
    if (!view) throw new YouBrainError("INVALID_INPUT", "页面刷新失败");
    return view;
  }

  /** Rename a page or a database row (its title property). */
  async patchTitle(pageId: string, title: string): Promise<NotionPageView> {
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    const full = await client.page(pageId);
    const properties = (full.properties ?? {}) as Record<string, Record<string, unknown>>;
    const titleName = Object.entries(properties).find(([, value]) => value?.type === "title")?.[0];
    if (!titleName) throw new YouBrainError("INVALID_INPUT", "这个对象没有标题属性");
    await client.updatePage(pageId, {
      properties: { [titleName]: { title: [{ type: "text", text: { content: title } }] } },
    });
    await this.#syncEngine().resyncPage(pageId);
    const view = await this.page(pageId);
    if (!view) throw new YouBrainError("INVALID_INPUT", "页面刷新失败");
    return view;
  }

  /**
   * Create a page under an existing one and register it in the index right
   * away, so the sidebar shows it without waiting for the next full sync
   * (content fills in on the next sync pass).
   */
  async createPage(input: { parentId?: string | undefined; title: string }): Promise<{
    pageId: string;
    view: NotionPageView | null;
  }> {
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    const parentId = input.parentId ?? (await this.#firstRootId());
    if (!parentId) {
      throw new YouBrainError("INVALID_INPUT", "还没有可用的父页面:先在 Notion 里把一个页面共享给集成");
    }
    const created = await client.createPage(parentId, input.title);
    const pageId = String(created.id ?? "");
    if (pageId === "") throw new YouBrainError("INVALID_INPUT", "Notion 没有返回新页面 id");
    this.#openIndex().upsertPage({
      pageId,
      object: "page",
      parentKind: "page",
      parentId,
      title: input.title,
      icon: null,
      coverUrl: null,
      lastEditedTime: String(created.last_edited_time ?? new Date().toISOString()),
      createdAt: String(created.created_time ?? new Date().toISOString()),
    });
    try {
      await this.#syncEngine().resyncPage(pageId);
    } catch {
      // 新页面还没有内容;索引里已有标题,下一轮全量同步补内容。
    }
    return { pageId, view: await this.page(pageId) };
  }

  /** Archive a page (soft-delete in Notion) and remove it from the index. */
  async archivePage(pageId: string): Promise<{ roots: NotionTreeNode[] }> {
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    await client.archivePage(pageId);
    this.#openIndex().dropPage(pageId);
    return { roots: await this.tree() };
  }

  async #firstRootId(): Promise<string | null> {
    const roots = await this.tree();
    const first = roots.find((node) => node.object === "page") ?? roots[0];
    return first ? first.id : null;
  }

  /** Locate a block within the page tree, together with its parent id and siblings. */
  #locate(
    pageId: string,
    blockId: string,
  ): { parentId: string | null; list: NotionBlockModel[]; index: number } | null {
    const visit = (
      list: readonly NotionBlockModel[],
      parentId: string | null,
    ): { parentId: string | null; list: NotionBlockModel[]; index: number } | null => {
      const index = list.findIndex((model) => model.id === blockId);
      if (index >= 0) return { parentId, list: [...list], index };
      for (const model of list) {
        const nested = visit(model.children, model.id);
        if (nested) return nested;
      }
      return null;
    };
    return visit(this.#openIndex().pageBlocks(pageId), null);
  }

  async deleteBlock(blockId: string): Promise<NotionPageView> {
    const pageId = this.#pageOfBlock(blockId);
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    await client.deleteBlock(blockId);
    await this.#syncEngine().resyncPage(pageId);
    const view = await this.page(pageId);
    if (!view) throw new YouBrainError("INVALID_INPUT", "页面刷新失败");
    return view;
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
