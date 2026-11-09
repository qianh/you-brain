import { join } from "node:path";

import { getNotionToken, setNotionToken, type NotionSecretOptions } from "../auth/notion-secrets.js";
import { YouBrainError } from "../domain/errors.js";

import {
  coverOf,
  iconOf,
  NotionApiClient,
  NotionApiError,
  propertiesToPlainText,
  propertyValueText,
  titleOfPage,
  toBlock,
  type NotionBlock,
  type NotionPageStub,
} from "./api-client.js";
import {
  createPayload,
  inlineable,
  needsChildFetch,
  patchPayload,
  sanitizeModel,
  sanitizeTree,
  segmentsToRichText,
  tableOverflow,
  uncreatableIn,
} from "./block-payload.js";
import { blocksToMarkdown, buildBlockModel, tableRowCells, type NotionBlockModel, type NotionSegment } from "./model.js";
import { markdownToSegments, segmentsToMarkdown } from "./markdown-text.js";
import { NotionIndex, type NotionPageBlockRow } from "./store.js";
import { NotionSync, type NotionSyncSummary } from "./sync.js";
import type { NotionDatabaseView, NotionPageView, NotionTableEditBody } from "../http/types.js";

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

  /** 上一轮还有正文没拉完。没有跑过时不算积压,避免空转。 */
  hasPending(): boolean {
    return (this.#lastRun?.pending ?? 0) > 0;
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
    const dbView = isRow && meta.parentId ? this.databaseView(meta.parentId) : null;
    return {
      id: pageId,
      title: meta.title === "" ? "未命名" : meta.title,
      icon: meta.icon,
      coverUrl: meta.coverUrl,
      lastEditedTime: meta.lastEditedTime,
      blocks,
      markdown: blocksToMarkdown(blocks),
      ...(properties ? { properties } : {}),
      ...(dbView ? { database: { id: dbView.databaseId, columns: dbView.columns } } : {}),
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
    const columns = Object.entries(schema).map(([name, def]) => {
      const type = String(def.type ?? "unknown");
      const options = (def[type] as { options?: Array<{ name?: unknown }> } | undefined)?.options;
      return {
        name,
        type,
        ...(Array.isArray(options) ? { options: options.map((option) => String(option.name ?? "")).filter((option) => option !== "") } : {}),
      };
    });
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
  #patchBody(model: NotionBlockModel, markdown: string, rich?: NotionSegment[], languageOverride?: string): Record<string, unknown> {
    if (model.kind === "code") {
      const language = languageOverride ?? model.language;
      return {
        type: "code",
        code: {
          rich_text: [{ type: "text", text: { content: markdown } }],
          ...(language ? { language } : {}),
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
    } else if (model.color && model.color !== "default") {
      // 改文字时带上块颜色,否则 Notion 会把它重置成默认色。
      payload.color = model.color;
    }
    if (model.kind === "heading") payload.is_toggleable = model.toggleable === true;
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
    languageOverride?: string | undefined,
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
    const body = this.#patchBody(target, markdown.trim(), rich, languageOverride);
    if (checkedOverride !== undefined) {
      const payload = body[typeof body.type === "string" ? body.type : ""] as
        | Record<string, unknown>
        | undefined;
      if (payload) payload.checked = checkedOverride;
    }
    const raw = await client.updateBlock(blockId, body);
    const updated = buildBlockModel(toBlock(typeof raw.id === "string" ? raw : { ...raw, id: blockId }));
    return this.#commitLocal(pageId, (roots) =>
      replaceInTree(roots, blockId, (old) => ({ ...updated, children: old.children })),
    );
  }

  /**
   * 写成功后直接改本地索引里的块树,不再整页回拉 Notion(那要 2~3 秒,大页面更久);
   * 与 Notion 的最终对账交给后台同步。数据库行的属性也进全文索引,仍整页重拉。
   */
  async #commitLocal(
    pageId: string,
    change: (roots: NotionBlockModel[]) => NotionBlockModel[],
  ): Promise<NotionPageView> {
    const index = this.#openIndex();
    // 记下本机写入时间:后台同步在静默期内不拉这一页,免得读到 Notion 还没更新的旧内容盖掉本地。
    index.setMeta(`wrote:${pageId}`, String(Date.now()));
    const row = index.listPages().find((candidate) => candidate.pageId === pageId);
    if (!row || row.parentKind === "database") {
      await this.#syncEngine().resyncPage(pageId);
    } else {
      const rows: NotionPageBlockRow[] = [];
      const flatten = (models: readonly NotionBlockModel[], parentBlockId: string | null): void => {
        models.forEach((model, idx) => {
          rows.push({ blockId: model.id, pageId, parentBlockId, idx, model });
          flatten(model.children, model.id);
        });
      };
      flatten(change(index.pageBlocks(pageId)), null);
      index.replaceBlocks(pageId, rows);
      // 有内容了就不再是「确认真空」;清空后交给下一轮同步复核。
      if (rows.length > 0) index.deleteMeta(`empty:${pageId}`);
    }
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
      /** 追加为这个块的子块(缩进)。 */
      parentBlockId?: string | undefined;
      children?: NewChildInput[] | undefined;
      /** 插到页面(或 parentBlockId)子块的最前面;不能与 afterBlockId 同用。 */
      atStart?: boolean | undefined;
    },
  ): Promise<NotionPageView> {
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    const pageId =
      input.pageId ??
      (input.parentBlockId
        ? this.#pageOfBlock(input.parentBlockId)
        : input.afterBlockId
          ? this.#pageOfBlock(input.afterBlockId)
          : null);
    if (!pageId) throw new YouBrainError("INVALID_INPUT", "缺少 pageId、afterBlockId 或 parentBlockId");
    const children = input.children
      ? input.children.map((entry) => this.#newBlockTree(entry, true))
      : [this.#newBlockChild(input.kind ?? "paragraph", input.markdown, input.rich)];
    // afterBlockId 是兄弟:父级取它的父级,靠 `after` 参数定位插入点。
    const parentId = input.parentBlockId
      ? input.parentBlockId
      : input.afterBlockId
        ? (this.#locate(pageId, input.afterBlockId)?.parentId ?? pageId)
        : pageId;
    if (input.atStart && input.afterBlockId) {
      throw new YouBrainError("INVALID_INPUT", "atStart 不能与 afterBlockId 同用");
    }
    const known = new Set<string>();
    const collect = (models: readonly NotionBlockModel[]): void => {
      for (const model of models) {
        known.add(model.id);
        collect(model.children);
      }
    };
    collect(this.#openIndex().pageBlocks(pageId));
    const created = input.atStart
      ? await client.prependBlocks(parentId, children)
      : await client.appendBlocks(parentId, children, input.afterBlockId);
    if (input.children) await this.#appendTableOverflow(client, input.children, created);

    // 本地索引直接插入新块:只展开带子块的那几个(嵌套列表、表格行),不整页重拉。
    const fresh = created.filter((raw) => typeof raw.id === "string" && !known.has(raw.id));
    if (fresh.length !== children.length) {
      // 返回结果对不上请求(接口行为变化等):宁可整页重拉,也不能把块插错位置。
      await this.#syncEngine().resyncPage(pageId);
      const view = await this.page(pageId);
      if (!view) throw new YouBrainError("INVALID_INPUT", "页面刷新失败");
      return view;
    }
    const nested = input.children
      ? input.children.map((entry) => entry.kind === "table" || (entry.children?.length ?? 0) > 0)
      : [false];
    const models = await this.#syncEngine().expandBlocks(
      fresh.map((raw, i) => {
        const block = toBlock(raw);
        return nested[i] ? { ...block, hasChildren: true } : block;
      }),
    );
    const treeParent = input.parentBlockId
      ? input.parentBlockId
      : input.afterBlockId
        ? (this.#locate(pageId, input.afterBlockId)?.parentId ?? null)
        : null;
    const position = input.atStart ? "start" : input.afterBlockId ? { after: input.afterBlockId } : "end";
    return this.#commitLocal(pageId, (roots) => insertIntoTree(roots, treeParent, position, models));
  }

  /**
   * 表格超过单次请求上限的行:按创建结果里的表格块 id,每 100 行续写一次。
   * 返回的是本次新建的顶层块,表格按出现顺序与请求里的表格一一对应。
   */
  async #appendTableOverflow(
    client: NotionApiClient,
    entries: readonly NewChildInput[],
    created: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    const sent = entries.filter((entry) => entry.kind === "table");
    const tables = created.filter((block) => block.type === "table");
    for (const [index, entry] of sent.entries()) {
      const rows = entry.table?.rows ?? [];
      if (rows.length <= TABLE_ROWS_PER_REQUEST) continue;
      const tableId = tables[index]?.id;
      if (typeof tableId !== "string") {
        throw new YouBrainError("INVALID_INPUT", "表格已创建,但没拿到它的 id,超过 100 行的部分未写入");
      }
      const width = tableWidth(rows);
      for (let start = TABLE_ROWS_PER_REQUEST; start < rows.length; start += TABLE_ROWS_PER_REQUEST) {
        await client.appendBlocks(
          tableId,
          rows.slice(start, start + TABLE_ROWS_PER_REQUEST).map((row) => tableRowPayload(row, width)),
        );
      }
    }
  }

  /** 带嵌套子块的新块 payload(Notion 单次请求最多嵌两层)。顶层表格超出的行由 #appendTableOverflow 续写。 */
  #newBlockTree(input: NewChildInput, topLevel = false): Record<string, unknown> {
    if (input.kind === "table") {
      const rows = input.table?.rows ?? [];
      if (rows.length === 0) throw new YouBrainError("INVALID_INPUT", "表格没有行");
      if (!topLevel && rows.length > TABLE_ROWS_PER_REQUEST) {
        throw new YouBrainError("INVALID_INPUT", `嵌套的表格最多 ${TABLE_ROWS_PER_REQUEST} 行`);
      }
      const width = tableWidth(rows);
      return {
        object: "block",
        type: "table",
        table: {
          table_width: width,
          has_column_header: input.table?.hasHeader ?? true,
          has_row_header: input.table?.hasRowHeader ?? false,
          children: rows.slice(0, TABLE_ROWS_PER_REQUEST).map((row) => tableRowPayload(row, width)),
        },
      };
    }
    const child = this.#newBlockChild(
      input.kind,
      input.markdown,
      input.rich,
      input.language,
      input.checked,
      input.emoji,
    );
    if (input.children && input.children.length > 0) {
      const type = String(child.type);
      const payload = child[type] as Record<string, unknown> | undefined;
      if (payload) payload.children = input.children.map((entry) => this.#newBlockTree(entry));
    }
    return child;
  }

  /** Fresh block payload for the "add block" menu kinds. */
  #newBlockChild(
    kind: string,
    markdown: string,
    rich?: NotionSegment[],
    language?: string,
    checked?: boolean,
    emoji?: string,
  ): Record<string, unknown> {
    const richText = segmentsToRichText(
      rich && rich.length > 0 ? rich : markdownToSegments(markdown),
    );
    switch (kind) {
      case "bulleted":
        return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText } };
      case "numbered":
        return { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: richText } };
      case "todo":
        return { object: "block", type: "to_do", to_do: { rich_text: richText, checked: checked ?? false } };
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
          callout: { rich_text: richText, icon: { type: "emoji", emoji: emoji || "💡" }, color: "default" },
        };
      case "toggle":
        return { object: "block", type: "toggle", toggle: { rich_text: richText } };
      case "code":
        return {
          object: "block",
          type: "code",
          code: { rich_text: chunkText(markdown).map((content) => ({ type: "text", text: { content } })), language: language || "plain text" },
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
    const index = this.#openIndex();
    const row = index.listPages().find((candidate) => candidate.pageId === pageId);
    // 普通页面的标题属性就叫 title;数据库行的标题列名各不相同,要先读一次。
    let titleName: string | undefined = "title";
    if (!row || row.parentKind === "database") {
      const full = await client.page(pageId);
      const properties = (full.properties ?? {}) as Record<string, Record<string, unknown>>;
      titleName = Object.entries(properties).find(([, value]) => value?.type === "title")?.[0];
    }
    if (!titleName) throw new YouBrainError("INVALID_INPUT", "这个对象没有标题属性");
    await client.updatePage(pageId, {
      properties: { [titleName]: { title: [{ type: "text", text: { content: title } }] } },
    });
    // 索引以刚写入的为准(不回读 Notion:回读既慢,也可能拿到旧标题),全文索引跟着刷新。
    if (row) index.upsertPage({ ...row, title });
    const view = await this.#commitLocal(pageId, (roots) => roots);
    // 数据库行会整页重拉,回读的标题可能还是旧的,再按刚写入的覆盖一次。
    if (row?.parentKind !== "database") return view;
    index.upsertPage({ ...row, title });
    return (await this.page(pageId)) ?? view;
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

  /**
   * 把页面移到另一个页面下(侧栏拖拽)。Notion 的限制:只能移普通页面,目标必须是普通页面
   * (不能是数据库或数据库里的行),不能移到顶层。本地先校验,免得白发一次请求;
   * 成功后立刻改本地索引,侧栏马上是新结构,下一轮同步再和 Notion 对齐。
   */
  async movePage(pageId: string, parentId: string): Promise<{ roots: NotionTreeNode[] }> {
    const pages = this.#openIndex().listPages();
    const byId = new Map(pages.map((page) => [page.pageId, page]));
    const page = byId.get(pageId);
    const parent = byId.get(parentId);
    if (!page || !parent) throw new YouBrainError("INVALID_INPUT", "页面不存在或还没有同步");
    if (page.object !== "page" || page.parentKind === "database") {
      throw new YouBrainError("INVALID_INPUT", "只能移动普通页面(不能移动数据库或数据库里的行)");
    }
    if (parent.object !== "page" || parent.parentKind === "database") {
      throw new YouBrainError("INVALID_INPUT", "只能移到普通页面下面(不能移到数据库里)");
    }
    if (pageId === parentId) throw new YouBrainError("INVALID_INPUT", "不能把页面移到它自己下面");
    for (let cursor: string | null = parent.parentId, hops = 0; cursor !== null && hops < 200; hops += 1) {
      if (cursor === pageId) throw new YouBrainError("INVALID_INPUT", "不能把页面移到它自己的子页面下面");
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    if (page.parentKind === "page" && page.parentId === parentId) return { roots: await this.tree() };
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    await client.movePage(pageId, parentId);
    this.#openIndex().upsertPage({ ...page, parentKind: "page", parentId });
    return { roots: await this.tree() };
  }

  /** Archive a page (soft-delete in Notion) and remove it from the index. */
  async archivePage(pageId: string): Promise<{ roots: NotionTreeNode[] }> {
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    try {
      await client.archivePage(pageId);
    } catch (error) {
      // Notion 拒绝重复归档;它已经不在了,本地清掉即视为删除成功。
      const message = error instanceof NotionApiError ? error.message : "";
      if (!(error instanceof NotionApiError && /archived/i.test(message))) throw error;
    }
    // Notion 归档会级联整棵子树;本地也要级联删,否则子页面会浮到顶层。
    this.#openIndex().dropSubtree(pageId);
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

  /** 表格编辑:改一行、插入/删除行、切换表头;增删列走整表重建。写完直接更新本地索引。 */
  async tableEdit(body: NotionTableEditBody): Promise<NotionPageView> {
    const pageId = this.#pageOfBlock(body.tableId);
    const table = this.#blockModel(pageId, body.tableId);
    if (table.kind !== "table") throw new YouBrainError("INVALID_INPUT", "这个块不是表格");
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    const tableId = body.tableId;
    const current = await this.#tableRows(client, pageId, table);
    const width = Math.max(1, current.rows[0]?.length ?? 0);
    const fit = (cells: readonly NotionSegment[][]): NotionSegment[][] =>
      Array.from({ length: width }, (_, index) => cells[index] ?? []);
    const setTable = (change: (model: Extract<NotionBlockModel, { kind: "table" }>) => NotionBlockModel) =>
      this.#commitLocal(pageId, (roots) =>
        replaceInTree(roots, tableId, (model) => (model.kind === "table" ? change(model) : model)),
      );
    switch (body.op) {
      case "update-row": {
        const rowId = current.rowIds[body.rowIndex];
        if (!rowId) throw new YouBrainError("INVALID_INPUT", "表格行不存在,先同步知识库");
        const cells = fit(body.cells);
        await client.updateBlock(rowId, { table_row: { cells: cells.map((cell) => segmentsToRichText(cell)) } });
        return setTable((model) => ({
          ...model,
          rows: current.rows.map((row, index) => (index === body.rowIndex ? cells : row)),
          rowIds: current.rowIds,
        }));
      }
      case "insert-row": {
        const cells = fit(body.cells);
        const payload = tableRowPayload(cells, width);
        const after = body.afterIndex >= 0 ? current.rowIds[body.afterIndex] : undefined;
        if (body.afterIndex >= 0 && !after) throw new YouBrainError("INVALID_INPUT", "表格行不存在,先同步知识库");
        const created = after
          ? await client.appendBlocks(tableId, [payload], after)
          : await client.prependBlocks(tableId, [payload]);
        const newId = created.map((raw) => raw.id).find((id) => typeof id === "string" && !current.rowIds.includes(id));
        if (typeof newId !== "string") throw new YouBrainError("INVALID_INPUT", "新行已写入,但没拿到它的 id;请同步知识库");
        const at = body.afterIndex + 1;
        return setTable((model) => ({
          ...model,
          rows: [...current.rows.slice(0, at), cells, ...current.rows.slice(at)],
          rowIds: [...current.rowIds.slice(0, at), newId, ...current.rowIds.slice(at)],
        }));
      }
      case "delete-row": {
        const rowId = current.rowIds[body.rowIndex];
        if (!rowId) throw new YouBrainError("INVALID_INPUT", "表格行不存在,先同步知识库");
        if (current.rowIds.length <= 1) throw new YouBrainError("INVALID_INPUT", "表格至少要保留一行");
        await client.deleteBlock(rowId);
        return setTable((model) => ({
          ...model,
          rows: current.rows.filter((_, index) => index !== body.rowIndex),
          rowIds: current.rowIds.filter((_, index) => index !== body.rowIndex),
        }));
      }
      case "set-header": {
        const hasHeader = body.hasHeader ?? table.hasHeader;
        const hasRowHeader = body.hasRowHeader ?? table.hasRowHeader ?? false;
        await client.updateBlock(tableId, { table: { has_column_header: hasHeader, has_row_header: hasRowHeader } });
        return setTable((model) => ({ ...model, hasHeader, hasRowHeader, rows: current.rows, rowIds: current.rowIds }));
      }
      case "rebuild": {
        // Notion 建表后不能改列数:在原位置后面建一张新表,再删掉旧表。
        const entry: NewChildInput = {
          kind: "table",
          markdown: "",
          table: { hasHeader: body.hasHeader, hasRowHeader: body.hasRowHeader, rows: body.rows },
        };
        const parentId = this.#locate(pageId, tableId)?.parentId ?? pageId;
        const created = await client.appendBlocks(parentId, [this.#newBlockTree(entry, true)], tableId);
        await this.#appendTableOverflow(client, [entry], created);
        const raw = created.find((candidate) => candidate.type === "table" && candidate.id !== tableId);
        if (!raw || typeof raw.id !== "string") throw new YouBrainError("INVALID_INPUT", "新表格已创建,但没拿到它的 id;请同步知识库");
        await client.deleteBlock(tableId);
        const [rebuilt] = await this.#syncEngine().expandBlocks([{ ...toBlock(raw), hasChildren: true }]);
        if (!rebuilt) throw new YouBrainError("INVALID_INPUT", "新表格读取失败;请同步知识库");
        return this.#commitLocal(pageId, (roots) => replaceInTree(roots, tableId, () => rebuilt));
      }
    }
  }

  /** 表格的行与行 id;旧索引没存行 id(或对不上)时,补拉这张表的行并写回索引。 */
  async #tableRows(
    client: NotionApiClient,
    pageId: string,
    table: Extract<NotionBlockModel, { kind: "table" }>,
  ): Promise<{ rows: NotionSegment[][][]; rowIds: string[] }> {
    if (table.rowIds && table.rowIds.length === table.rows.length && table.rows.length > 0) {
      return { rows: table.rows, rowIds: table.rowIds };
    }
    const raws = (await client.blockChildren(table.id)).filter((raw) => raw.type === "table_row");
    const fresh = { rows: raws.map((raw) => tableRowCells(raw.data)), rowIds: raws.map((raw) => raw.id) };
    await this.#commitLocal(pageId, (roots) =>
      replaceInTree(roots, table.id, (model) => (model.kind === "table" ? { ...model, ...fresh } : model)),
    );
    return fresh;
  }

  async #requireClient(): Promise<NotionApiClient> {
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    return client;
  }

  /**
   * Notion 托管的文件(图片、附件等)的签名链接一小时就过期,不能当外链复制:
   * 取一次最新链接、下载、再上传成新文件,用上传 id 建副本。
   */
  async #rehost(client: NotionApiClient, models: readonly NotionBlockModel[]): Promise<NotionBlockModel[]> {
    const out: NotionBlockModel[] = [];
    for (const model of models) {
      const children = await this.#rehost(client, model.children);
      const hosted =
        (model.kind === "image" || model.kind === "video" || model.kind === "audio" || model.kind === "file" || model.kind === "pdf") &&
        model.source === "file" &&
        !model.uploadId;
      if (!hosted) {
        out.push({ ...model, children } as NotionBlockModel);
        continue;
      }
      const fresh = buildBlockModel(toBlock(await client.retrieveBlock(model.id)));
      const url = "url" in fresh ? fresh.url : model.url;
      const response = await fetch(url);
      if (!response.ok) throw new YouBrainError("INVALID_INPUT", "下载 Notion 里的文件失败,稍后再试");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || "file";
      const contentType = response.headers.get("content-type") ?? guessContentType(url);
      const uploadId = await client.uploadFile(name, contentType, bytes);
      out.push({ ...model, children, uploadId } as NotionBlockModel);
    }
    return out;
  }

  /**
   * 在 parentId 下新建一组块(带整棵子树):顶层按 placement 定位,子块拿到新 id 后逐层追加,
   * 不受「单次最多嵌两层」限制。返回新建块的完整模型(从 Notion 读回,带真实 id)。
   */
  async #createTree(
    client: NotionApiClient,
    parentId: string,
    models: readonly NotionBlockModel[],
    placement: { after?: string | undefined; atStart?: boolean | undefined } = {},
    expand = true,
    known: Set<string> = this.#knownIds(parentId),
  ): Promise<NotionBlockModel[]> {
    const raws: Array<Record<string, unknown>> = [];
    let after = placement.after;
    for (let start = 0; start < models.length; start += 100) {
      const batch = models.slice(start, start + 100);
      const payloads = batch.map((model) => createPayload(model));
      const created =
        placement.atStart && start === 0 && !after
          ? await client.prependBlocks(parentId, payloads)
          : await client.appendBlocks(parentId, payloads, after);
      // Notion 返回的是「新块 + 插入点之后的所有兄弟块」(插在末尾时就只有新块),新块总在最前面。
      const fresh = created.slice(0, batch.length);
      if (fresh.length !== batch.length || fresh.some((raw) => typeof raw.id !== "string" || known.has(raw.id))) {
        throw new YouBrainError("INVALID_INPUT", `Notion 返回的新块对不上(返回 ${created.length} 个,新建 ${batch.length} 个),请同步知识库`);
      }
      for (const raw of fresh) known.add(String(raw.id));
      raws.push(...fresh);
      const last = fresh[fresh.length - 1];
      after = typeof last?.id === "string" ? last.id : after;
    }
    for (const [index, model] of models.entries()) {
      const id = String(raws[index]?.id ?? "");
      if (id !== "") await this.#fillChildren(client, id, model, known);
    }
    if (!expand) return [];
    const read = () =>
      this.#syncEngine().expandBlocks(raws.map((raw, index) => ({ ...toBlock(raw), hasChildren: needsChildFetch(models[index]!) })));
    // 读回整棵子树;刚写完 Notion 偶尔还读不全,少了就稍等再读。
    let expanded = await read();
    for (let attempt = 0; attempt < 4 && countTree(expanded) < countTree(models); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      expanded = await read();
    }
    return expanded;
  }

  /** 新块建好后补齐子块:表格续写超出的行,分栏/标签页补第三层以下的内容,其余块逐层追加。 */
  async #fillChildren(client: NotionApiClient, id: string, model: NotionBlockModel, known: Set<string>): Promise<void> {
    if (model.kind === "table") {
      for (const rows of tableOverflow(model)) await client.appendBlocks(id, rows);
      return;
    }
    if (model.kind === "column_list" || model.kind === "tab") {
      // 第二层(列/标签)和第三层(内容)已随请求建好;这里只处理占位和更深的子块。
      const groups = await this.#settledChildren(client, id, Math.max(model.kind === "column_list" ? 2 : 0, model.children.length));
      for (const [index, group] of groups.entries()) {
        known.add(group.id);
        const content = model.children[index]?.children ?? [];
        if (content.length === 0) continue;
        const kids = await this.#settledChildren(client, group.id, content.length);
        for (const [position, child] of content.entries()) {
          const raw = kids[position];
          if (!raw) continue;
          known.add(raw.id);
          if (!inlineable(child)) {
            await this.#createTree(client, group.id, [child], { after: raw.id }, false, known);
            await client.deleteBlock(raw.id);
          } else if (child.children.length > 0) {
            await this.#fillChildren(client, raw.id, child, known);
          }
        }
      }
      return;
    }
    if (model.children.length > 0) await this.#createTree(client, id, model.children, {}, false, known);
  }

  /**
   * 刚建好的块,Notion 的子块列表偶尔会晚一点才出现(读到空列表)。按预期数量重试几次,
   * 免得把内容挂错位置或漏删占位。
   */
  async #settledChildren(client: NotionApiClient, id: string, expected: number): Promise<NotionBlock[]> {
    let list: NotionBlock[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      list = await client.blockChildren(id);
      if (list.length >= expected) return list;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
    throw new YouBrainError("INVALID_INPUT", "Notion 还没返回刚建好的子块,稍后同步知识库再看");
  }

  /** parentId 所在页面里已有的块 id(含页面自己):用来从 Notion 的返回里认出新块。 */
  #knownIds(parentId: string): Set<string> {
    const known = new Set<string>([parentId]);
    const index = this.#openIndex();
    const pageId = index.blockPage(parentId) ?? parentId;
    known.add(pageId);
    const collect = (models: readonly NotionBlockModel[]): void => {
      for (const model of models) {
        known.add(model.id);
        collect(model.children);
      }
    };
    collect(index.pageBlocks(pageId));
    return known;
  }

  /** 目标位置 → 接口的父块 id、本地树的父块 id 与插入方式。 */
  #placement(
    pageId: string,
    target: { afterBlockId?: string | undefined; parentBlockId?: string | undefined; atStart?: boolean | undefined },
  ): { apiParent: string; treeParent: string | null; position: "start" | "end" | { after: string } } {
    if (target.afterBlockId) {
      const located = this.#locate(pageId, target.afterBlockId);
      if (located) return { apiParent: located.parentId ?? pageId, treeParent: located.parentId, position: { after: target.afterBlockId } };
      // 锚点不在索引里(已被删除或还没同步):放到父块(或页面)末尾,不报错丢内容。
      const parent = target.parentBlockId ?? null;
      return { apiParent: parent ?? pageId, treeParent: parent, position: "end" };
    }
    const parent = target.parentBlockId ?? null;
    return { apiParent: parent ?? pageId, treeParent: parent, position: target.atStart ? "start" : "end" };
  }

  /**
   * 移动或复制一组块(带整棵子树)到新位置:转类型、缩进、拖拽排序、上下移动、复制都走这里。
   * Notion 没有块移动接口,只能在新位置重建再删原块;root 可以覆盖第一个块自身的内容(转类型)。
   * 返回页面视图和新建块的模型(与传入块一一对应,前端据此登记新 id)。
   */
  async relocateBlocks(input: {
    blockIds: string[];
    mode: "move" | "copy";
    afterBlockId?: string | undefined;
    parentBlockId?: string | undefined;
    pageId?: string | undefined;
    atStart?: boolean | undefined;
    root?: Record<string, unknown> | undefined;
    /** 移到另一个页面(「移动到」);不给就是同一页面内。 */
    targetPageId?: string | undefined;
  }): Promise<{ page: NotionPageView; created: NotionBlockModel[]; idMap: Array<[string, string]> }> {
    if (input.blockIds.length === 0) throw new YouBrainError("INVALID_INPUT", "没有要移动的块");
    const pageId = this.#pageOfBlock(input.blockIds[0]!);
    for (const id of input.blockIds) {
      if (this.#pageOfBlock(id) !== pageId) throw new YouBrainError("INVALID_INPUT", "只能在同一页面里移动块");
    }
    let models = input.blockIds.map((id) => this.#blockModel(pageId, id));
    if (input.root) {
      const first = models[0]!;
      models = [sanitizeModel(input.root, first.id, first.children), ...models.slice(1)];
    }
    const blocked = uncreatableIn(models);
    if (blocked) throw new YouBrainError("INVALID_INPUT", `「${blocked}」无法通过 Notion 接口重建,不能移动或复制`);
    const moving = new Set<string>();
    const collect = (list: readonly NotionBlockModel[]): void => {
      for (const model of list) {
        moving.add(model.id);
        collect(model.children);
      }
    };
    collect(models);
    const anchor = input.parentBlockId ?? input.afterBlockId;
    // 原地转类型时 after 就是自己;其余情况目标不能落在被移动的子树里。
    const inPlace = input.afterBlockId !== undefined && input.blockIds.includes(input.afterBlockId);
    if (anchor && moving.has(anchor) && !(inPlace && input.parentBlockId === undefined)) {
      throw new YouBrainError("INVALID_INPUT", "不能把块移到它自己里面");
    }
    const targetPageId = input.targetPageId ?? pageId;
    if (input.parentBlockId && this.#pageOfBlock(input.parentBlockId) !== targetPageId) {
      throw new YouBrainError("INVALID_INPUT", "目标位置不在目标页面里");
    }
    if (targetPageId !== pageId) {
      const target = this.#openIndex().listPages().find((row) => row.pageId === targetPageId);
      if (!target || target.object !== "page") throw new YouBrainError("INVALID_INPUT", "只能移到普通页面里(先同步知识库)");
    }
    const client = await this.#requireClient();
    const place = this.#placement(targetPageId, input);
    const prepared = await this.#rehost(client, models);
    const created = await this.#createTree(client, place.apiParent, prepared, {
      after: typeof place.position === "object" ? place.position.after : undefined,
      atStart: place.position === "start",
    });
    if (input.mode === "move") {
      for (const id of input.blockIds) await client.deleteBlock(id);
    }
    let page: NotionPageView;
    if (targetPageId === pageId) {
      page = await this.#commitLocal(pageId, (roots) => {
        let next = insertIntoTree(roots, place.treeParent, place.position, created);
        if (input.mode === "move") for (const id of input.blockIds) next = removeFromTree(next, id);
        return next;
      });
    } else {
      await this.#commitLocal(targetPageId, (roots) => insertIntoTree(roots, place.treeParent, place.position, created));
      page = await this.#commitLocal(pageId, (roots) =>
        input.mode === "move" ? input.blockIds.reduce((next, id) => removeFromTree(next, id), roots) : roots,
      );
    }
    // 原块 id → 新块 id(整棵子树逐层对应):前端据此把本地 id 指到新块上。
    const idMap: Array<[string, string]> = [];
    const pair = (from: readonly NotionBlockModel[], to: readonly NotionBlockModel[]): void => {
      from.forEach((model, index) => {
        const match = to[index];
        if (!match) return;
        idMap.push([model.id, match.id]);
        pair(model.children, match.children);
      });
    };
    pair(models, created);
    return { page, created, idMap };
  }

  /**
   * 复制页面(侧栏「复制」):在同一个父页面下建「原标题 (副本)」,图标和正文一起复制;
   * 子页面、同步块这类接口建不了的块跳过。
   */
  async duplicatePage(pageId: string, suffix: string): Promise<{ pageId: string; roots: NotionTreeNode[] }> {
    const index = this.#openIndex();
    const source = index.listPages().find((row) => row.pageId === pageId);
    if (!source || source.object !== "page" || source.parentKind !== "page" || !source.parentId) {
      throw new YouBrainError("INVALID_INPUT", "只能复制普通子页面(顶层页面和数据库行请在 Notion 里复制)");
    }
    const client = await this.#requireClient();
    const created = await this.createPage({ parentId: source.parentId, title: `${source.title}${suffix}` });
    if (source.icon) {
      await client.updatePage(created.pageId, { icon: { type: "emoji", emoji: source.icon } }).catch(() => undefined);
      const row = index.listPages().find((candidate) => candidate.pageId === created.pageId);
      if (row) index.upsertPage({ ...row, icon: source.icon });
    }
    const strip = (models: readonly NotionBlockModel[]): NotionBlockModel[] =>
      models.filter((model) => uncreatableIn([{ ...model, children: [] }]) === null).map((model) => ({ ...model, children: strip(model.children) }) as NotionBlockModel);
    const models = strip(index.pageBlocks(pageId));
    if (models.length > 0) {
      const blocks = await this.#createTree(client, created.pageId, await this.#rehost(client, models));
      await this.#commitLocal(created.pageId, () => blocks);
    }
    return { pageId: created.pageId, roots: await this.tree() };
  }

  /** 改块的内容或属性(颜色、可折叠、图标、链接、说明、公式……),块类型不变。 */
  async patchBlock(blockId: string, input: Record<string, unknown>): Promise<NotionPageView> {
    const pageId = this.#pageOfBlock(blockId);
    const previous = this.#blockModel(pageId, blockId);
    const model = sanitizeModel(input, blockId, previous.children);
    const client = await this.#requireClient();
    const raw = await client.updateBlock(blockId, patchPayload(model, previous));
    let updated = buildBlockModel(toBlock(typeof raw.id === "string" ? raw : { ...raw, id: blockId }));
    if (updated.kind === "table" && previous.kind === "table") {
      updated = { ...updated, rows: previous.rows, rowIds: previous.rowIds ?? [] };
    }
    return this.#commitLocal(pageId, (roots) => replaceInTree(roots, blockId, (old) => ({ ...updated, children: old.children })));
  }

  /** 新建一组任意类型的块(带子树):插入媒体、书签、分栏、公式、目录、页面链接等。 */
  async createBlocks(input: {
    models: unknown[];
    pageId?: string | undefined;
    afterBlockId?: string | undefined;
    parentBlockId?: string | undefined;
    atStart?: boolean | undefined;
  }): Promise<{ page: NotionPageView; created: NotionBlockModel[] }> {
    const pageId =
      input.pageId ??
      (input.afterBlockId ? this.#pageOfBlock(input.afterBlockId) : input.parentBlockId ? this.#pageOfBlock(input.parentBlockId) : null);
    if (!pageId) throw new YouBrainError("INVALID_INPUT", "缺少 pageId、afterBlockId 或 parentBlockId");
    const models = sanitizeTree(input.models);
    if (models.length === 0) throw new YouBrainError("INVALID_INPUT", "没有要新建的块");
    const client = await this.#requireClient();
    const place = this.#placement(pageId, input);
    const created = await this.#createTree(client, place.apiParent, models, {
      after: typeof place.position === "object" ? place.position.after : undefined,
      atStart: place.position === "start",
    });
    const page = await this.#commitLocal(pageId, (roots) => insertIntoTree(roots, place.treeParent, place.position, created));
    return { page, created };
  }

  /**
   * 撤销删除:恢复已归档的块(内容和托管文件都在)。Notion 会把恢复的块放到父块末尾,
   * 原位置不是末尾时再移回去(移动会换新 id,idMap 告诉前端)。
   */
  async restoreBlocks(input: {
    blockIds: string[];
    pageId: string;
    afterBlockId?: string | undefined;
    parentBlockId?: string | undefined;
    atStart?: boolean | undefined;
  }): Promise<{ page: NotionPageView; created: NotionBlockModel[]; idMap: Array<[string, string]> }> {
    const client = await this.#requireClient();
    let place: { treeParent: string | null; position: "start" | "end" | { after: string } };
    try {
      place = this.#placement(input.pageId, input);
    } catch {
      place = { treeParent: null, position: "end" };
    }
    const siblings = (): NotionBlockModel[] => {
      const roots = this.#openIndex().pageBlocks(input.pageId);
      if (place.treeParent === null) return roots;
      const find = (list: readonly NotionBlockModel[]): NotionBlockModel | null => {
        for (const model of list) {
          if (model.id === place.treeParent) return model;
          const nested = find(model.children);
          if (nested) return nested;
        }
        return null;
      };
      return find(roots)?.children ?? [];
    };
    const list = siblings();
    const atEnd =
      place.position === "end" ||
      (place.position === "start" && list.length === 0) ||
      (typeof place.position === "object" && list[list.length - 1]?.id === place.position.after);
    const raws: Array<Record<string, unknown>> = [];
    for (const id of input.blockIds) raws.push(await client.restoreBlock(id));
    const models = await this.#syncEngine().expandBlocks(raws.map((raw) => toBlock(raw)));
    // 先按 Notion 的实际位置(父块末尾)记进索引。
    let page = await this.#commitLocal(input.pageId, (roots) => insertIntoTree(roots, place.treeParent, "end", models));
    if (atEnd) return { page, created: models, idMap: [] };
    const moved = await this.relocateBlocks({
      blockIds: input.blockIds,
      mode: "move",
      ...(typeof place.position === "object"
        ? { afterBlockId: place.position.after }
        : place.treeParent
          ? { parentBlockId: place.treeParent, atStart: true }
          : { atStart: true }),
    });
    page = moved.page;
    return moved;
  }

  #users: { at: number; list: Array<{ id: string; name: string }> } | null = null;

  /** 工作区成员(只要真人,不要机器人);缓存 10 分钟。没有权限时返回空列表。 */
  async users(): Promise<Array<{ id: string; name: string }>> {
    if (this.#users && Date.now() - this.#users.at < 600_000) return this.#users.list;
    const client = await this.#openClient();
    if (!client) return [];
    try {
      const list = (await client.listUsers()).filter((user) => user.type === "person" && user.name !== "").map(({ id, name }) => ({ id, name }));
      this.#users = { at: Date.now(), list };
      return list;
    } catch {
      this.#users = { at: Date.now(), list: [] };
      return [];
    }
  }

  /** 上传文件(≤20 MB),返回 file_upload id,建媒体块或设封面/图标时引用。 */
  async uploadFile(input: { filename: string; contentType: string; dataBase64: string }): Promise<{ uploadId: string }> {
    const bytes = Uint8Array.from(Buffer.from(input.dataBase64, "base64"));
    if (bytes.byteLength === 0) throw new YouBrainError("INVALID_INPUT", "文件是空的");
    if (bytes.byteLength > 20 * 1024 * 1024) throw new YouBrainError("INVALID_INPUT", "文件超过 20 MB,Notion 单次上传不支持");
    const client = await this.#requireClient();
    return { uploadId: await client.uploadFile(input.filename, input.contentType || "application/octet-stream", bytes) };
  }

  /** 页面图标与封面:emoji / 外链 / 上传文件,null 表示移除。 */
  async patchPageMeta(input: {
    pageId: string;
    icon?: { emoji: string } | { url: string } | { uploadId: string } | null | undefined;
    cover?: { url: string } | { uploadId: string } | null | undefined;
  }): Promise<NotionPageView> {
    const client = await this.#requireClient();
    const fileRef = (value: { url: string } | { uploadId: string }): Record<string, unknown> =>
      "uploadId" in value
        ? { type: "file_upload", file_upload: { id: value.uploadId } }
        : { type: "external", external: { url: value.url } };
    const body: Record<string, unknown> = {};
    if (input.icon !== undefined) {
      body.icon = input.icon === null ? null : "emoji" in input.icon ? { type: "emoji", emoji: input.icon.emoji } : fileRef(input.icon);
    }
    if (input.cover !== undefined) body.cover = input.cover === null ? null : fileRef(input.cover);
    const raw = await client.updatePage(input.pageId, body);
    const index = this.#openIndex();
    const row = index.listPages().find((candidate) => candidate.pageId === input.pageId);
    if (row) index.upsertPage({ ...row, icon: iconOf(raw), coverUrl: coverOf(raw) });
    const view = await this.page(input.pageId);
    if (!view) throw new YouBrainError("INVALID_INPUT", "页面不存在,先同步知识库");
    return view;
  }

  /** 数据库单元格:按列类型写回 Notion,再更新本地索引里的这一行。 */
  async updateDatabaseCell(input: {
    databaseId: string;
    rowId: string;
    property: string;
    value: string | boolean | string[] | null;
  }): Promise<NotionDatabaseView> {
    const index = this.#openIndex();
    const db = index.database(input.databaseId);
    if (!db) throw new YouBrainError("INVALID_INPUT", "数据库不存在,先同步知识库");
    const type = String((db.schema as Record<string, Record<string, unknown>>)[input.property]?.type ?? "");
    const payload = propertyPayload(type, input.value);
    if (!payload) throw new YouBrainError("INVALID_INPUT", `「${type}」类型的列由 Notion 计算或不支持在这里编辑`);
    const client = await this.#requireClient();
    const raw = await client.updatePage(input.rowId, { properties: { [input.property]: payload } });
    this.#replaceRow(input.databaseId, input.rowId, (raw.properties ?? {}) as Record<string, unknown>);
    return this.#databaseViewOrThrow(input.databaseId);
  }

  /** 新建数据库(「/」菜单的表格视图/数据库):默认带「名称」「标签」「日期」三列;Notion 放在页面末尾。 */
  async createDatabase(input: { pageId: string; title: string; inline: boolean }): Promise<{ page: NotionPageView; databaseId: string }> {
    const client = await this.#requireClient();
    const raw = await client.createDatabase(
      input.pageId,
      input.title,
      { 名称: { title: {} }, 标签: { multi_select: {} }, 状态: { select: { options: [{ name: "未开始" }, { name: "进行中" }, { name: "完成" }] } }, 日期: { date: {} } },
      input.inline,
    );
    const databaseId = String(raw.id ?? "");
    if (databaseId === "") throw new YouBrainError("INVALID_INPUT", "Notion 没有返回新数据库 id");
    const index = this.#openIndex();
    index.upsertPage({
      pageId: databaseId,
      object: "database",
      parentKind: "page",
      parentId: input.pageId,
      title: input.title,
      icon: null,
      coverUrl: null,
      lastEditedTime: String(raw.last_edited_time ?? new Date().toISOString()),
      createdAt: String(raw.created_time ?? new Date().toISOString()),
    });
    await this.#syncEngine().syncDatabase(databaseId);
    const page = await this.#commitLocal(input.pageId, (roots) => [
      ...roots,
      { id: databaseId, children: [], kind: "child_database", title: input.title, databaseId },
    ]);
    return { page, databaseId };
  }

  /** 数据库的列:新增、改名、删除(标题列不能删)。改完重拉这个数据库。 */
  async updateDatabaseSchema(
    input:
      | { op: "add"; databaseId: string; name: string; type: string }
      | { op: "rename"; databaseId: string; name: string; newName: string }
      | { op: "delete"; databaseId: string; name: string },
  ): Promise<NotionDatabaseView> {
    const db = this.#openIndex().database(input.databaseId);
    if (!db) throw new YouBrainError("INVALID_INPUT", "数据库不存在,先同步知识库");
    const schema = db.schema as Record<string, Record<string, unknown>>;
    if (input.op !== "add" && !schema[input.name]) throw new YouBrainError("INVALID_INPUT", "这一列不存在,先同步知识库");
    if (input.op === "delete" && schema[input.name]?.type === "title") throw new YouBrainError("INVALID_INPUT", "标题列不能删除");
    if (input.op === "add" && schema[input.name]) throw new YouBrainError("INVALID_INPUT", "已经有同名的列");
    const client = await this.#requireClient();
    const properties =
      input.op === "add"
        ? { [input.name]: { [input.type]: {} } }
        : input.op === "rename"
          ? { [input.name]: { name: input.newName } }
          : { [input.name]: null };
    await client.updateDatabase(input.databaseId, { properties });
    await this.#syncEngine().syncDatabase(input.databaseId);
    return this.#databaseViewOrThrow(input.databaseId);
  }

  /** 数据库新建一行(只填标题),本地索引立刻多一行。 */
  async addDatabaseRow(input: { databaseId: string; title: string }): Promise<NotionDatabaseView> {
    const index = this.#openIndex();
    const db = index.database(input.databaseId);
    if (!db) throw new YouBrainError("INVALID_INPUT", "数据库不存在,先同步知识库");
    const titleName = Object.entries(db.schema as Record<string, Record<string, unknown>>).find(([, def]) => def.type === "title")?.[0];
    if (!titleName) throw new YouBrainError("INVALID_INPUT", "这个数据库没有标题列");
    const client = await this.#requireClient();
    const raw = await client.createDatabaseRow(input.databaseId, {
      [titleName]: { title: input.title === "" ? [] : [{ type: "text", text: { content: input.title } }] },
    });
    const rowId = String(raw.id ?? "");
    if (rowId === "") throw new YouBrainError("INVALID_INPUT", "Notion 没有返回新行 id");
    index.upsertPage({
      pageId: rowId,
      object: "page",
      parentKind: "database",
      parentId: input.databaseId,
      title: input.title,
      icon: null,
      coverUrl: null,
      lastEditedTime: String(raw.last_edited_time ?? new Date().toISOString()),
      createdAt: String(raw.created_time ?? new Date().toISOString()),
    });
    this.#replaceRow(input.databaseId, rowId, (raw.properties ?? {}) as Record<string, unknown>);
    return this.#databaseViewOrThrow(input.databaseId);
  }

  /** 删除数据库的一行(进 Notion 回收站)。 */
  async deleteDatabaseRow(input: { databaseId: string; rowId: string }): Promise<NotionDatabaseView> {
    await this.archivePage(input.rowId);
    const db = this.#openIndex().database(input.databaseId);
    if (db) {
      this.#openIndex().replaceDatabaseRows(
        input.databaseId,
        db.rows
          .filter((row) => row.rowPageId !== input.rowId)
          .map((row, idx) => ({ ...row, idx, plain: propertiesToPlainText(row.cells) })),
      );
    }
    return this.#databaseViewOrThrow(input.databaseId);
  }

  #replaceRow(databaseId: string, rowId: string, properties: Record<string, unknown>): void {
    const index = this.#openIndex();
    const db = index.database(databaseId);
    if (!db) return;
    const titleOf = (cells: Record<string, unknown>): string => {
      for (const value of Object.values(cells)) {
        const property = value as Record<string, unknown>;
        if (Array.isArray(property?.title)) {
          return (property.title as Array<Record<string, unknown>>).map((part) => String(part.plain_text ?? (part.text as { content?: string } | undefined)?.content ?? "")).join("");
        }
      }
      return "";
    };
    const exists = db.rows.some((row) => row.rowPageId === rowId);
    const rows = exists
      ? db.rows.map((row) => (row.rowPageId === rowId ? { ...row, cells: { ...row.cells, ...properties }, title: titleOf({ ...row.cells, ...properties }) } : row))
      : [...db.rows, { rowPageId: rowId, idx: db.rows.length, title: titleOf(properties), icon: null, cells: properties }];
    index.replaceDatabaseRows(
      databaseId,
      rows.map((row, idx) => ({ ...row, idx, plain: propertiesToPlainText(row.cells) })),
    );
    const page = index.listPages().find((candidate) => candidate.pageId === rowId);
    const updated = rows.find((row) => row.rowPageId === rowId);
    if (page && updated) index.upsertPage({ ...page, title: updated.title });
  }

  #databaseViewOrThrow(databaseId: string): NotionDatabaseView {
    const view = this.databaseView(databaseId);
    if (!view) throw new YouBrainError("INVALID_INPUT", "数据库不存在,先同步知识库");
    return view;
  }

  async deleteBlock(blockId: string): Promise<NotionPageView> {
    const pageId = this.#pageOfBlock(blockId);
    const client = await this.#openClient();
    if (!client) throw new YouBrainError("INVALID_INPUT", "还没有保存 Notion 集成令牌");
    await client.deleteBlock(blockId);
    return this.#commitLocal(pageId, (roots) => removeFromTree(roots, blockId));
  }
}

function countTree(models: readonly NotionBlockModel[]): number {
  return models.reduce((sum, model) => sum + 1 + countTree(model.children), 0);
}

/** 把 id 对应的块换成 change 的结果(深度优先,找到即止)。 */
function replaceInTree(
  models: readonly NotionBlockModel[],
  id: string,
  change: (model: NotionBlockModel) => NotionBlockModel,
): NotionBlockModel[] {
  return models.map((model) =>
    model.id === id ? change(model) : { ...model, children: replaceInTree(model.children, id, change) },
  );
}

function removeFromTree(models: readonly NotionBlockModel[], id: string): NotionBlockModel[] {
  return models
    .filter((model) => model.id !== id)
    .map((model) => ({ ...model, children: removeFromTree(model.children, id) }));
}

/** 在 parentId(null = 页面顶层)的子块里插入:最前、某块之后(找不到就放末尾)或末尾。 */
function insertIntoTree(
  models: readonly NotionBlockModel[],
  parentId: string | null,
  position: "start" | "end" | { after: string },
  items: readonly NotionBlockModel[],
): NotionBlockModel[] {
  const place = (list: readonly NotionBlockModel[]): NotionBlockModel[] => {
    if (position === "start") return [...items, ...list];
    if (position === "end") return [...list, ...items];
    const index = list.findIndex((model) => model.id === position.after);
    if (index < 0) return [...list, ...items];
    return [...list.slice(0, index + 1), ...items, ...list.slice(index + 1)];
  };
  if (parentId === null) return place(models);
  return replaceInTree(models, parentId, (parent) => ({ ...parent, children: place(parent.children) }));
}

interface NewChildInput {
  kind: string;
  markdown: string;
  rich?: NotionSegment[] | undefined;
  language?: string | undefined;
  checked?: boolean | undefined;
  emoji?: string | undefined;
  table?: { hasHeader: boolean; hasRowHeader?: boolean | undefined; rows: NotionSegment[][][] } | undefined;
  children?: NewChildInput[] | undefined;
}

/** Notion 单次请求里一个数组最多 100 个元素,表格行也一样。 */
const TABLE_ROWS_PER_REQUEST = 100;

function tableWidth(rows: readonly NotionSegment[][][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 1);
}

/** 一行表格:列数不足的补空单元格,与 table_width 对齐。 */
function tableRowPayload(row: readonly NotionSegment[][], width: number): Record<string, unknown> {
  return {
    object: "block",
    type: "table_row",
    table_row: { cells: Array.from({ length: width }, (_, index) => segmentsToRichText(row[index] ?? [])) },
  };
}

/** Notion 单个 rich_text 的 content 上限 2000 字符,长代码要切段。 */
function chunkText(text: string, size = 2000): string[] {
  // 空代码块:rich_text 给空数组,而不是一个 content 为空串的文本(Notion 可能拒收)。
  if (text === "") return [];
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

/** 数据库单元格的写入形状;公式、汇总、关联、人员、文件等列不能在这里写,返回 null。 */
function propertyPayload(type: string, value: string | boolean | string[] | null): Record<string, unknown> | null {
  const text = typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : value === true ? "true" : "";
  const rich = (content: string) => (content === "" ? [] : [{ type: "text", text: { content } }]);
  switch (type) {
    case "title":
      return { title: rich(text) };
    case "rich_text":
      return { rich_text: rich(text) };
    case "number": {
      if (text.trim() === "") return { number: null };
      const number = Number(text);
      if (!Number.isFinite(number)) throw new YouBrainError("INVALID_INPUT", "这一列只能填数字");
      return { number };
    }
    case "url":
    case "email":
    case "phone_number":
      return { [type]: text.trim() === "" ? null : text.trim() };
    case "checkbox":
      return { checkbox: value === true || text === "true" };
    case "select":
    case "status":
      return { [type]: text.trim() === "" ? null : { name: text.trim() } };
    case "multi_select": {
      const names = (Array.isArray(value) ? value : text.split(/[,,]/u)).map((name) => name.trim()).filter((name) => name !== "");
      return { multi_select: names.map((name) => ({ name })) };
    }
    case "date":
      return { date: text.trim() === "" ? null : { start: text.trim() } };
    default:
      return null;
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
