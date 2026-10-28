import type { NotionApiClient, NotionPageStub } from "./api-client.js";
import { propertiesToPlainText } from "./api-client.js";
import {
  buildBlockModel,
  tableRowCells,
  type NotionBlockModel,
} from "./model.js";
import type { NotionIndex, NotionPageBlockRow } from "./store.js";

export interface NotionSyncSummary {
  objectsSeen: number;
  pagesSynced: number;
  databasesSynced: number;
  removed: number;
  failed: number;
  /** Content passes left for the next sync tick; 0 means the workspace is current. */
  pending: number;
  error: string | null;
}

export interface NotionSyncOptions {
  /** Wall-clock budget for content fetches per pass. Remaining work reports as `pending`. */
  budgetMs?: number;
  now?: () => Date;
}

const MAX_DEPTH = 6;
const MAX_BLOCKS_PER_PAGE = 800;

/**
 * Incremental workspace sync.
 *
 * Pass 1 lists everything the integration can see (cheap pagination) and
 * reconciles the tree. Pass 2 refetches content only for pages whose
 * last_edited_time moved, bounded by a time budget so a large first import
 * spreads over several passes instead of hammering the API.
 */
export class NotionSync {
  readonly #client: NotionApiClient;
  readonly #index: NotionIndex;

  constructor(client: NotionApiClient, index: NotionIndex) {
    this.#client = client;
    this.#index = index;
  }

  async syncAll(options: NotionSyncOptions = {}): Promise<NotionSyncSummary> {
    const startedAt = Date.now();
    const budgetMs = options.budgetMs ?? 30_000;
    const summary: NotionSyncSummary = {
      objectsSeen: 0,
      pagesSynced: 0,
      databasesSynced: 0,
      removed: 0,
      failed: 0,
      pending: 0,
      error: null,
    };
    try {
      const stubs = new Map<string, NotionPageStub>();
      for await (const stub of this.#client.searchAll()) {
        stubs.set(stub.id, stub);
      }
      summary.objectsSeen = stubs.size;

      for (const stub of stubs.values()) {
        if (stub.archived) {
          if (this.#index.pageLastEdited(stub.id) !== null) summary.removed += 1;
          this.#index.dropPage(stub.id);
        }
      }
      for (const stub of stubs.values()) {
        if (!stub.archived) this.#index.upsertPage(toPageRow(stub));
      }

      // Oldest first so backfills read roughly chronologically.
      const dirty = [...stubs.values()]
        .filter((stub) => !stub.archived && this.#isDirty(stub))
        .sort((a, b) => a.createdTime.localeCompare(b.createdTime));

      for (const stub of dirty) {
        if (Date.now() - startedAt >= budgetMs) {
          summary.pending = dirty.length - (summary.pagesSynced + summary.databasesSynced + summary.failed);
          return summary;
        }
        try {
          if (stub.object === "database") {
            await this.#syncDatabase(stub.id);
            summary.databasesSynced += 1;
          } else {
            await this.#syncPage(stub);
            summary.pagesSynced += 1;
          }
        } catch (error) {
          summary.failed += 1;
          // Record the failure so one broken page cannot loop the sync forever.
          this.#markSynced(stub, stub.lastEditedTime);
          this.#index.setMeta(`failed:${stub.id}`, error instanceof Error ? error.message : String(error));
        }
      }
      this.#index.setMeta("lastSyncAt", new Date().toISOString());
      return summary;
    } catch (error) {
      summary.error = error instanceof Error ? error.message : String(error);
      return summary;
    }
  }

  #isDirty(stub: NotionPageStub): boolean {
    return this.#index.meta(`synced:${stub.id}`) !== stub.lastEditedTime;
  }

  #markSynced(stub: NotionPageStub, at: string): void {
    this.#index.setMeta(`synced:${stub.id}`, at);
    this.#index.setMeta(`failed:${stub.id}`, "");
  }

  async #syncPage(stub: NotionPageStub): Promise<void> {
    const { roots } = await this.#fetchBlockTree(stub.id);
    const storeRows: NotionPageBlockRow[] = [];
    const flatten = (models: readonly NotionBlockModel[], parentBlockId: string | null): void => {
      models.forEach((model, idx) => {
        storeRows.push({ blockId: model.id, pageId: stub.id, parentBlockId, idx, model });
        flatten(model.children, model.id);
      });
    };
    flatten(roots, null);
    // A database row's content lives in its properties, not its body — keep
    // that text so search covers rows too.
    this.#index.replaceBlocks(stub.id, storeRows, stub.propertyText);
    this.#markSynced(stub, stub.lastEditedTime);
  }

  /**
   * Fetch a page's block tree: root children, then nested children for every
   * block with has_children, capped in depth and count.
   */
  async #fetchBlockTree(pageId: string): Promise<{
    roots: NotionBlockModel[];
    count: number;
  }> {
    let count = 0;
    const roots: NotionBlockModel[] = [];
    const queue: Array<{
      raw: { id: string; type: string; hasChildren: boolean; data: Record<string, unknown> };
      model: NotionBlockModel | null;
      parentModel: NotionBlockModel | null;
      depth: number;
    }> = [];
    const rootRaw = await this.#client.blockChildren(pageId);
    for (const raw of rootRaw) {
      queue.push({ raw, model: null, parentModel: null, depth: 0 });
    }
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { raw, parentModel, depth } = item;
      if (count >= MAX_BLOCKS_PER_PAGE) break;
      // Table rows do not become standalone blocks; they land on their table.
      if (raw.type === "table_row" && parentModel && parentModel.kind === "table") {
        parentModel.rows.push(tableRowCells(raw.data));
        count += 1;
        continue;
      }
      const model = buildBlockModel(raw);
      count += 1;
      if (parentModel) parentModel.children.push(model);
      else roots.push(model);
      if (raw.hasChildren && depth < MAX_DEPTH) {
        const children = await this.#client.blockChildren(raw.id);
        for (const child of children) {
          queue.push({ raw: child, model: null, parentModel: model, depth: depth + 1 });
        }
      }
    }
    return { roots, count };
  }

  async #syncDatabase(databaseId: string): Promise<void> {
    const full = await this.#client.database(databaseId);
    const rows = await this.#client.queryDatabase(databaseId);
    const title = Array.isArray(full.title)
      ? (full.title as Array<Record<string, unknown>>)
          .map((part) => String(part.plain_text ?? ""))
          .join("")
      : "";
    const schema = (full.properties ?? {}) as Record<string, unknown>;
    this.#index.upsertDatabase({ databaseId, title, schema });
    const mapped = rows.map((row) => {
      const properties = (row.properties ?? {}) as Record<string, unknown>;
      const rowTitle = firstTitleText(properties);
      return {
        rowPageId: String(row.id ?? ""),
        idx: 0,
        title: rowTitle,
        icon: null,
        cells: properties,
        plain: propertiesToPlainText(properties),
      };
    });
    this.#index.replaceDatabaseRows(databaseId, mapped);
  }
}

function toPageRow(stub: NotionPageStub) {
  return {
    pageId: stub.id,
    object: stub.object,
    parentKind: stub.parentKind,
    parentId: stub.parentId,
    title: stub.title,
    icon: stub.icon,
    coverUrl: stub.coverUrl,
    lastEditedTime: stub.lastEditedTime,
    createdAt: stub.createdTime,
  };
}

function firstTitleText(properties: Record<string, unknown>): string {
  for (const value of Object.values(properties)) {
    const property = value as Record<string, unknown>;
    if (property?.type !== "title") continue;
    const parts = Array.isArray(property.title) ? property.title : [];
    return parts.map((part) => String((part as Record<string, unknown>).plain_text ?? "")).join("");
  }
  return "";
}
