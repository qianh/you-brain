import type { NotionApiClient, NotionPageStub } from "./api-client.js";
import { propertiesToPlainText, titleOfPage } from "./api-client.js";
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
/** 同时拉几页正文。Notion 普通工作区平均每秒 3 次请求，这一路正好用满。 */
const CONTENT_CONCURRENCY = 3;

/**
 * Incremental workspace sync.
 *
 * Pass 1 lists everything the integration can see (cheap pagination) and
 * reconciles the tree. Pass 2 refetches content only for pages whose
 * last_edited_time moved. Content pages run a few at a time so a first import
 * finishes inside one pass instead of restarting the listing on every tick.
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
      // Notion search never returns archived or unshared objects, so anything
      // still indexed but absent from this pass is gone server-side. But
      // search is also eventually consistent and transiently misses pages, so
      // one absence only strikes; two consecutive absences drop the row.
      const seen = new Set(stubs.keys());
      for (const row of this.#index.listPages()) {
        const missingKey = `missing:${row.pageId}`;
        if (seen.has(row.pageId)) {
          this.#index.setMeta(missingKey, "");
          continue;
        }
        const strike = this.#index.meta(missingKey);
        if (strike !== null && strike !== "") {
          this.#index.dropPage(row.pageId);
          this.#index.setMeta(missingKey, "");
          summary.removed += 1;
        } else {
          this.#index.setMeta(missingKey, new Date().toISOString());
        }
      }

      // Oldest first so backfills read roughly chronologically.
      const dirty = [...stubs.values()]
        .filter((stub) => !stub.archived && this.#isDirty(stub))
        .sort((a, b) => a.createdTime.localeCompare(b.createdTime));

      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < dirty.length) {
          if (Date.now() - startedAt >= budgetMs) return;
          const stub = dirty[cursor];
          cursor += 1;
          if (!stub) return;
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
      };
      const workers = Math.min(CONTENT_CONCURRENCY, dirty.length);
      await Promise.all(Array.from({ length: workers }, () => worker()));
      const done = summary.pagesSynced + summary.databasesSynced + summary.failed;
      if (done < dirty.length) {
        summary.pending = dirty.length - done;
        return summary;
      }
      this.#index.setMeta("lastSyncAt", new Date().toISOString());
      return summary;
    } catch (error) {
      summary.error = error instanceof Error ? error.message : String(error);
      return summary;
    }
  }

  #isDirty(stub: NotionPageStub): boolean {
    if (this.#index.meta(`synced:${stub.id}`) !== stub.lastEditedTime) return true;
    // 内容丢失兜底:时间戳没变,但块没了(被误清或并发写丢)。真空页一定带
    // empty 标记,数据库行正文在属性里,两者都不是的就是丢了,重拉一次。
    if (
      stub.parentKind !== "database" &&
      this.#index.meta(`empty:${stub.id}`) === null &&
      this.#index.pageBlocks(stub.id).length === 0
    ) {
      return true;
    }
    return false;
  }

  /** Re-fetch one page's content right away (used after a local write). */
  async resyncPage(pageId: string): Promise<void> {
    const page = this.#index
      .listPages()
      .find((candidate) => candidate.pageId === pageId);
    if (!page) return;
    const full = await this.#client.page(pageId);
    const properties = (full.properties ?? {}) as Record<string, unknown>;
    const stub: NotionPageStub = {
      id: pageId,
      object: "page",
      parentId: page.parentId,
      parentKind: page.parentKind === "database" ? "database" : page.parentKind === "workspace" ? "workspace" : page.parentKind === "page" ? "page" : "other",
      title: titleOfPage(full) || page.title,
      icon: page.icon,
      coverUrl: page.coverUrl,
      lastEditedTime: typeof full.last_edited_time === "string" ? full.last_edited_time : page.lastEditedTime,
      createdTime: page.createdAt,
      archived: false,
      propertyText: page.parentKind === "database" ? propertiesToPlainText(properties) : "",
    };
    this.#index.upsertPage({
      pageId,
      object: "page",
      parentKind: stub.parentKind,
      parentId: stub.parentId,
      title: stub.title,
      icon: stub.icon,
      coverUrl: stub.coverUrl,
      lastEditedTime: stub.lastEditedTime,
      createdAt: stub.createdTime,
    });
    await this.#syncPage(stub);
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
    // Appending child blocks does NOT bump the page's last_edited_time, so a
    // page caught mid-write (created empty, content still being pushed) would
    // be pinned empty forever if we marked it synced here. Only trust an empty
    // fetch after seeing it empty twice; otherwise re-check next pass. Database
    // rows are exempt — their body is legitimately empty, content lives in
    // properties.
    if (
      storeRows.length === 0 &&
      stub.parentKind !== "database" &&
      this.#index.meta(`empty:${stub.id}`) === null
    ) {
      this.#index.setMeta(`empty:${stub.id}`, new Date().toISOString());
      return;
    }
    // empty 标记语义:"" = 确认真空,null = 上轮有内容(用于丢块自愈判断)。
    if (storeRows.length === 0) {
      this.#index.setMeta(`empty:${stub.id}`, "");
    } else {
      this.#index.deleteMeta(`empty:${stub.id}`);
    }
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
