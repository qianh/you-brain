import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { MemoryKeychain } from "../../src/auth/secret-store.js";
import { MOVE_PAGE_NOTION_VERSION, NotionApiClient } from "../../src/notion/api-client.js";
import { buildBlockModel, blocksToMarkdown, tableRowCells, type NotionBlockModel } from "../../src/notion/model.js";
import { NotionService, type NotionTreeNode } from "../../src/notion/service.js";
import { NotionSync } from "../../src/notion/sync.js";

// ---------------------------------------------------------------------------
// 模拟 Notion API:一个工作区,含根页面、子页面、数据库(两行)、已归档页面。
// ---------------------------------------------------------------------------

const ROOT_PAGE = "root-1";
const CHILD_PAGE = "child-1";
const ROW_PAGE_A = "row-a";
const ROW_PAGE_B = "row-b";
const DATABASE = "db-1";
const ARCHIVED_PAGE = "gone-1";

interface PageDef {
  id: string;
  parent: Record<string, unknown>;
  title: string;
  lastEdited: string;
  created: string;
  archived?: boolean;
  /** 真实 Notion 搜索不返回已归档对象;置位后 /search 跳过它。 */
  hiddenFromSearch?: boolean;
  blocks: Array<Record<string, unknown>>;
  properties?: Record<string, unknown>;
}

const PAGES: Record<string, PageDef> = {
  [ROOT_PAGE]: {
    id: ROOT_PAGE,
    parent: { type: "workspace", workspace: true },
    title: "工作区首页",
    lastEdited: "2026-10-01T00:00:00.000Z",
    created: "2026-01-01T00:00:00.000Z",
    blocks: [
      blockRaw("p1", "paragraph", { rich_text: [text("你好,")], has_children: false }),
      blockRaw("h1", "heading_1", { rich_text: [text("计划")] }),
      blockRaw("todo1", "to_do", { rich_text: [text("写周报")], checked: false }),
      blockRaw("tbl", "table", { has_column_header: true }, true),
    ],
  },
  [CHILD_PAGE]: {
    id: CHILD_PAGE,
    parent: { type: "page_id", page_id: ROOT_PAGE },
    title: "子页面",
    lastEdited: "2026-10-02T00:00:00.000Z",
    created: "2026-01-02T00:00:00.000Z",
    blocks: [blockRaw("p2", "paragraph", { rich_text: [text("子页面内容")] })],
  },
  [ROW_PAGE_A]: {
    id: ROW_PAGE_A,
    parent: { type: "database_id", database_id: DATABASE },
    title: "第一行",
    lastEdited: "2026-10-03T00:00:00.000Z",
    created: "2026-02-01T00:00:00.000Z",
    blocks: [],
    properties: {
      名称: { type: "title", title: [text("第一行")] },
      状态: { type: "select", select: { name: "进行中" } },
      优先级: { type: "number", number: 2 },
    },
  },
  [ROW_PAGE_B]: {
    id: ROW_PAGE_B,
    parent: { type: "database_id", database_id: DATABASE },
    title: "第二行",
    lastEdited: "2026-10-04T00:00:00.000Z",
    created: "2026-02-02T00:00:00.000Z",
    blocks: [],
    properties: {
      名称: { type: "title", title: [text("第二行")] },
      状态: { type: "select", select: { name: "已完成" } },
      优先级: { type: "number", number: 1 },
    },
  },
  [ARCHIVED_PAGE]: {
    id: ARCHIVED_PAGE,
    parent: { type: "workspace", workspace: true },
    title: "已归档",
    lastEdited: "2026-09-01T00:00:00.000Z",
    created: "2026-03-01T00:00:00.000Z",
    archived: true,
    blocks: [],
  },
};

/** patchTitle 会改写 fixture;每个用例前恢复,防用例间污染。 */
function resetFixture(): void {
  DB_SCHEMA_PATCH = {};
  const rowA = PAGES[ROW_PAGE_A];
  if (rowA) {
    rowA.title = "第一行";
    rowA.lastEdited = "2026-10-03T00:00:00.000Z";
    rowA.properties = {
      名称: { type: "title", title: [text("第一行")] },
      状态: { type: "select", select: { name: "进行中" } },
      优先级: { type: "number", number: 2 },
    };
  }
  const child = PAGES[CHILD_PAGE];
  if (child) {
    child.archived = false;
    child.hiddenFromSearch = false;
    child.lastEdited = "2026-10-02T00:00:00.000Z";
  }
}

const TABLE_ROWS = [
  ["列一", "列二"],
  ["甲", "乙"],
];

function text(content: string): Record<string, unknown> {
  return { type: "text", plain_text: content, text: { content } };
}

function blockRaw(
  id: string,
  type: string,
  data: Record<string, unknown>,
  hasChildren = false,
): Record<string, unknown> {
  return { object: "block", id, type, has_children: hasChildren, [type]: data };
}

/** 顶层第 4 个块是 table,子块是两行 table_row。 */
const TABLE_BLOCK_ID = "tbl";

function apiPage(def: PageDef): Record<string, unknown> {
  return {
    object: "page",
    id: def.id,
    parent: def.parent,
    archived: def.archived === true,
    in_trash: false,
    created_time: def.created,
    last_edited_time: def.lastEdited,
    properties: def.properties ?? {
      title: { type: "title", title: [text(def.title)] },
    },
  };
}

/** 测试里改过的数据库列(新增/改名/删除),每个用例前清空。 */
let DB_SCHEMA_PATCH: Record<string, Record<string, unknown> | null> = {};

function databaseObject(): Record<string, unknown> {
  return {
    object: "database",
    id: DATABASE,
    parent: { type: "page_id", page_id: ROOT_PAGE },
    archived: false,
    created_time: "2026-01-05T00:00:00.000Z",
    last_edited_time: "2026-10-04T00:00:00.000Z",
    title: [text("任务表")],
    properties: (() => {
      const props: Record<string, Record<string, unknown>> = {
        名称: { type: "title" },
        状态: { type: "select" },
        优先级: { type: "number" },
      };
      for (const [name, change] of Object.entries(DB_SCHEMA_PATCH)) {
        if (change === null) delete props[name];
        else if (typeof change.name === "string") {
          props[change.name] = props[name] ?? {};
          delete props[name];
        } else props[name] = { type: Object.keys(change)[0] };
      }
      return props;
    })(),
  };
}

/** fake 里「插到最前面」的 after 标记。 */
const START = "__start__";

/** 真实 Notion 会给每段 rich_text 补上只读的 plain_text / href;写入端不再发送它们,fake 要替它补。 */
function fillReadOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fillReadOnly);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) out[key] = fillReadOnly(child);
  const inner = record.text as { content?: unknown; link?: { url?: unknown } | null } | undefined;
  if (record.type === "text" && inner && typeof inner.content === "string") {
    out.plain_text ??= inner.content;
    out.href ??= typeof inner.link?.url === "string" ? inner.link.url : null;
  }
  return out;
}

function fakeFetch() {
  const calls: string[] = [];
  // 写操作的可变状态:覆盖、删除、插入,让重取 children 反映真实改动。
  const state = {
    overrides: new Map<string, Record<string, unknown>>(),
    deleted: new Set<string>(),
    inserted: new Map<string, Array<{ after: string | null; block: Record<string, unknown> }>>(),
    /** 模拟导入竞态:页面已建、内容还没推。 */
    emptyPages: new Set<string>(),
    /** 「移动页面」请求记录(接口要求新版本头)。 */
    moves: [] as Array<{ pageId: string; parentId: string; version: string | null }>,
    /** 每次追加块请求带的版本头。 */
    appendVersions: [] as Array<string | null>,
    /** 恢复过的块:列子块时排到最后(Notion 的行为)。 */
    restored: new Set<string>(),
    /** 测试里新建的数据库。 */
    createdDatabases: new Map<string, Record<string, unknown>>(),
  };
  const serveChildren = (base: Array<Record<string, unknown>>, parentId: string) => {
    let list = [...base];
    for (const ins of state.inserted.get(parentId) ?? []) {
      // position: start 记作 after = START,插到最前面。
      const idx = ins.after === START ? -1 : ins.after === null ? list.length : list.findIndex((b) => b.id === ins.after);
      list.splice(idx + 1, 0, ins.block);
    }
    list = [...list.filter((b) => !state.restored.has(String(b.id))), ...list.filter((b) => state.restored.has(String(b.id)))];
    list = list
      .filter((b) => !state.deleted.has(String(b.id)))
      .map((b) => {
        const override = state.overrides.get(String(b.id));
        const merged = override ? { ...b, ...override } : b;
        // 真实 Notion 会标出后来追加过子块的块。
        const added = (state.inserted.get(String(b.id)) ?? []).some((entry) => !state.deleted.has(String(entry.block.id)));
        return added ? { ...merged, has_children: true } : merged;
      });
    return list;
  };
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const path = new URL(url).pathname.replace(/^\/v1/u, "");
    const method = (init?.method as string) ?? "GET";
    const key = `${method} ${path}`;
    calls.push(key);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (key === "POST /search") {
      // 有状态分页:cursor 是注入的序号,模拟真实 API 的不透明游标。
      const body = JSON.parse(String(init?.body ?? "{}")) as { start_cursor?: string };
      const all = Object.values(PAGES)
        .filter((def) => def.hiddenFromSearch !== true)
        .map((def) => apiPage(def));
      all.push(databaseObject());
      const start = Number(body.start_cursor ?? "0");
      const slice = all.slice(start, start + 3);
      const more = start + 3 < all.length;
      return json({
        results: slice,
        has_more: more,
        next_cursor: more ? String(start + 3) : null,
      });
    }
    const blockChildrenMatch = /^GET \/blocks\/([^/]+)\/children/u.exec(key);
    if (blockChildrenMatch) {
      const id = decodeURIComponent(blockChildrenMatch[1] ?? "");
      if (id === ROOT_PAGE) {
        return json({ results: serveChildren(PAGES[ROOT_PAGE]?.blocks ?? [], ROOT_PAGE), has_more: false, next_cursor: null });
      }
      if (id === CHILD_PAGE) {
        if (state.emptyPages.has(id)) return json({ results: [], has_more: false, next_cursor: null });
        return json({ results: serveChildren(PAGES[CHILD_PAGE]?.blocks ?? [], CHILD_PAGE), has_more: false, next_cursor: null });
      }
      if (id === TABLE_BLOCK_ID) {
        return json({
          results: serveChildren(
            TABLE_ROWS.map((cells, index) => ({
              object: "block",
              id: `row-${index}`,
              type: "table_row",
              has_children: false,
              table_row: {
                cells: cells.map((value) => [text(value)]),
              },
            })),
            id,
          ),
          has_more: false,
          next_cursor: null,
        });
      }
      // 追加时随请求一起建的子块(新表格的行、分栏的列和列里的内容):按请求里的 children 逐层返回,
      // 子块 id 记作「父 id-c序号」。
      const nestedOf = (block: Record<string, unknown>, blockId: string): Array<Record<string, unknown>> => {
        const payload = block[String(block.type)] as { children?: Array<Record<string, unknown>> } | undefined;
        return (payload?.children ?? []).map((child, index) => {
          const childId = `${blockId}-c${index}`;
          const grand = (child[String(child.type)] as { children?: unknown[] } | undefined)?.children ?? [];
          return { ...child, id: childId, has_children: grand.length > 0 };
        });
      };
      const findInline = (block: Record<string, unknown>, blockId: string): Array<Record<string, unknown>> | null => {
        if (blockId === id) return nestedOf(block, blockId);
        for (const child of nestedOf(block, blockId)) {
          const found = findInline(child, String(child.id));
          if (found) return found;
        }
        return null;
      };
      for (const list of state.inserted.values()) {
        for (const entry of list) {
          const nested = findInline(entry.block, String(entry.block.id));
          if (nested) return json({ results: serveChildren(nested, id), has_more: false, next_cursor: null });
        }
      }
      return json({ results: serveChildren([], id), has_more: false, next_cursor: null });
    }
    if (key === "POST /databases") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const id = `new-db-${state.createdDatabases.size + 1}`;
      // 真实 Notion 返回的每一列都带 type。
      const properties = Object.fromEntries(
        Object.entries((body.properties ?? {}) as Record<string, Record<string, unknown>>).map(([name, config]) => {
          const type = Object.keys(config)[0] ?? "rich_text";
          return [name, { type, ...config }];
        }),
      );
      const db = { object: "database", id, created_time: "2026-10-30T01:00:00.000Z", last_edited_time: "2026-10-30T01:00:00.000Z", ...body, properties };
      state.createdDatabases.set(id, db);
      return json(db);
    }
    const createdDb = /^(GET|POST) \/databases\/([^/]+)(\/query)?$/u.exec(key);
    if (createdDb && state.createdDatabases.has(createdDb[2] ?? "")) {
      return createdDb[3] ? json({ results: [], has_more: false, next_cursor: null }) : json(state.createdDatabases.get(createdDb[2] ?? ""));
    }
    if (key === `GET /databases/${DATABASE}`) return json(databaseObject());
    if (key === `PATCH /databases/${DATABASE}`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { properties: Record<string, Record<string, unknown> | null> };
      Object.assign(DB_SCHEMA_PATCH, body.properties);
      return json(databaseObject());
    }
    if (key === `POST /databases/${DATABASE}/query`) {
      const rowA = PAGES[ROW_PAGE_A];
      const rowB = PAGES[ROW_PAGE_B];
      return json({
        results: [rowA, rowB]
          .filter((def) => def !== undefined)
          .map((def) => ({
            object: "page",
            id: def.id,
            created_time: def.created,
            last_edited_time: def.lastEdited,
            properties: def.properties,
          })),
        has_more: false,
        next_cursor: null,
      });
    }
    const pageMatch = /^GET \/pages\/([^/]+)$/u.exec(key);
    if (pageMatch) {
      const id = decodeURIComponent(pageMatch[1] ?? "");
      const def = PAGES[id];
      if (!def) return json({ code: "object_not_found", message: "not found" }, 404);
      return json(apiPage(def));
    }
    const moveMatch = /^POST \/pages\/([^/]+)\/move$/u.exec(key);
    if (moveMatch) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { parent?: { page_id?: string } };
      const headers = new Headers(init?.headers);
      state.moves.push({
        pageId: decodeURIComponent(moveMatch[1] ?? ""),
        parentId: body.parent?.page_id ?? "",
        version: headers.get("notion-version"),
      });
      return json({ object: "page", id: moveMatch[1] });
    }
    if (key === "POST /pages") {
      const raw = JSON.parse(String(init?.body ?? "{}")) as { parent: { page_id?: string; database_id?: string }; properties: Record<string, unknown> };
      if (raw.parent.database_id) {
        const id = `new-row-${Object.keys(PAGES).length + 1}`;
        PAGES[id] = { id, parent: { type: "database_id", database_id: raw.parent.database_id }, title: "", lastEdited: "2026-10-30T01:00:00.000Z", created: "2026-10-30T01:00:00.000Z", blocks: [], properties: raw.properties };
        return json({ object: "page", id, parent: PAGES[id]?.parent, archived: false, created_time: "2026-10-30T01:00:00.000Z", last_edited_time: "2026-10-30T01:00:00.000Z", properties: raw.properties });
      }
      const body = raw as unknown as {
        parent: { page_id: string };
        properties: { title: { title: Array<{ text: { content: string } }> } };
      };
      const id = `new-page-${Object.keys(PAGES).length + 1}`;
      const title = body.properties.title.title[0]?.text.content ?? "";
      PAGES[id] = {
        id,
        parent: { type: "page_id", page_id: body.parent.page_id },
        title,
        lastEdited: "2026-10-30T01:00:00.000Z",
        created: "2026-10-30T01:00:00.000Z",
        blocks: [],
        properties: { title: { type: "title", title: [text(title)] } },
      };
      return json({
        object: "page",
        id,
        parent: { type: "page_id", page_id: body.parent.page_id },
        archived: false,
        created_time: "2026-10-30T01:00:00.000Z",
        last_edited_time: "2026-10-30T01:00:00.000Z",
        properties: PAGES[id]?.properties,
      });
    }
    const updateBlockMatch = /^PATCH \/blocks\/([^/]+)$/u.exec(key);
    if (updateBlockMatch) {
      const id = decodeURIComponent(updateBlockMatch[1] ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (body.archived === false) {
        // 恢复归档:块回到原位置,返回它原来的样子。
        state.deleted.delete(id);
        // 真实 Notion 把恢复的块放到父块末尾。
        state.restored.add(id);
        const all = [...Object.values(PAGES).flatMap((def) => def.blocks), ...[...state.inserted.values()].flat().map((entry) => entry.block)];
        const raw = all.find((block) => block.id === id) ?? { object: "block", id, type: "paragraph", paragraph: { rich_text: [] } };
        return json({ has_children: false, ...raw, ...(state.overrides.get(id) ?? {}) });
      }
      const filled = fillReadOnly(body) as Record<string, unknown>;
      state.overrides.set(id, filled);
      const type = typeof body.type === "string" ? body.type : Object.keys(body)[0];
      return json({ object: "block", id, type, ...filled });
    }
    const appendMatch = /^PATCH \/blocks\/([^/]+)\/children$/u.exec(key);
    if (appendMatch) {
      const id = decodeURIComponent(appendMatch[1] ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        children: Array<Record<string, unknown>>;
        after?: string;
        position?: { type: string };
      };
      state.appendVersions.push(new Headers(init?.headers).get("notion-version"));
      const after = body.position?.type === "start" ? START : (body.after ?? null);
      const list = state.inserted.get(id) ?? [];
      const created: Array<Record<string, unknown>> = [];
      body.children.forEach((child, index) => {
        // 真实 API 会分配块 id;fake 里补上,页面树才挂得起来。
        const filledChild = fillReadOnly(child) as Record<string, unknown>;
        const withId = child.id ? filledChild : { ...filledChild, id: `new-${state.inserted.size}-${list.length + index}` };
        // 一次追加多个块时,真实 API 按顺序依次排在 after 之后:后一个接在前一个后面。
        const previous = index > 0 ? list[list.length - 1]?.block.id : undefined;
        list.push({ after: typeof previous === "string" ? previous : after, block: withId });
        created.push(withId);
      });
      state.inserted.set(id, list);
      // 真实 Notion 用 position: start 插入时,返回的是整列子块(新块在最前),不只是新块。
      // 真实 Notion 返回「新块 + 插入点之后的所有兄弟块」;插在末尾时就只有新块。
      const all = serveChildren(PAGES[id]?.blocks ?? [], id);
      const firstNew = all.findIndex((block) => block.id === created[0]?.id);
      return json({ results: firstNew >= 0 ? all.slice(firstNew) : created });
    }
    const deleteMatch = /^DELETE \/blocks\/([^/]+)$/u.exec(key);
    if (deleteMatch) {
      const id = decodeURIComponent(deleteMatch[1] ?? "");
      // 真实 Notion 拒绝重复归档。
      if (state.deleted.has(id)) {
        return json(
          {
            object: "error",
            code: "validation_error",
            message: "Can't edit block that is archived. You must unarchive the block before editing.",
          },
          400,
        );
      }
      state.deleted.add(id);
      return json({ object: "block", id, archived: true });
    }
    const patchPageMatch = /^PATCH \/pages\/([^/]+)$/u.exec(key);
    if (patchPageMatch) {
      const id = decodeURIComponent(patchPageMatch[1] ?? "");
      const def = PAGES[id];
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        properties?: Record<string, Record<string, unknown>>;
      };
      if (def) {
        const props = (def.properties ??= {});
        for (const [name, value] of Object.entries(body.properties ?? {})) {
          if (Array.isArray(value.title)) {
            props[name] = { type: "title", title: (value.title as Array<{ text: { content: string } }>).map((part) => text(part.text.content)) };
          } else {
            const type = Object.keys(value)[0] ?? "rich_text";
            props[name] = { type, ...value };
          }
        }
        def.lastEdited = "2026-10-30T00:00:00.000Z";
      }
      return json(def ? apiPage(def) : { id });
    }
    if (key === "GET /users/me") {
      return json({ name: "you-brain", bot: { workspace_name: "John 的工作区" } });
    }
    return json({ code: "object_not_found", message: "not found" }, 404);
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls, state };
}

function client(fetchImpl: typeof fetch): NotionApiClient {
  return new NotionApiClient({
    token: "secret_test",
    fetch: fetchImpl,
    retrySleepMs: async () => undefined,
  });
}

describe("notion sync", () => {
  let dataDir: string;
  let index: import("../../src/notion/store.js").NotionIndex;
  let fetches: ReturnType<typeof fakeFetch>;

  beforeEach(async () => {
    resetFixture();
    dataDir = await mkdtemp(join(tmpdir(), "notion-test-"));
    const { NotionIndex } = await import("../../src/notion/store.js");
    index = new NotionIndex(join(dataDir, "notion-index.sqlite"));
    fetches = fakeFetch();
  });

  test("首个同步拉全工作区:树、块、表格行、数据库", async () => {
    const sync = new NotionSync(client(fetches.fetchImpl), index);
    const summary = await sync.syncAll();
    expect(summary.error).toBeNull();
    // 页面:root、child、row-a、row-b;数据库单独算
    expect(summary.pagesSynced).toBe(4);
    // pages 表同时存页面和数据库(树需要),4 页 + 1 库
    expect(index.countPages()).toBe(5);
    // 归档页不出现在库里
    expect(index.pageLastEdited(ARCHIVED_PAGE)).toBeNull();

    const roots = treeOf(index);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.title).toBe("工作区首页");
    expect(roots[0]?.children.some((node) => node.title === "子页面")).toBe(true);
    expect(roots[0]?.children.some((node) => node.title === "任务表" && node.object === "database")).toBe(true);

    // 块树 + 表格行落到 table.rows
    const blocks = index.pageBlocks(ROOT_PAGE);
    const kinds = blocks.map((block) => block.kind);
    expect(kinds).toContain("paragraph");
    expect(kinds).toContain("heading");
    expect(kinds).toContain("todo");
    const table = blocks.find((block) => block.kind === "table");
    expect(table && table.kind === "table" ? table.rows : []).toHaveLength(2);
    expect(table && table.kind === "table" ? table.rows[0]?.[0]?.[0]?.text : "").toBe("列一");

    // 数据库行
    const db = index.database(DATABASE);
    expect(db?.rows).toHaveLength(2);
    expect(db?.rows[0]?.title).toBe("第一行");
  });

  test("父页面里的 child_page 块不展开:子页面正文仍归子页面,重同步父页面也不抢走", async () => {
    // 真实 Notion:父页面的 child_page 块 id 就是子页面 id,has_children 为 true。
    const rootBlocks = PAGES[ROOT_PAGE]?.blocks ?? [];
    rootBlocks.push(blockRaw(CHILD_PAGE, "child_page", { title: "子页面" }, true));
    try {
      const sync = new NotionSync(client(fetches.fetchImpl), index);
      await sync.syncAll();
      await sync.resyncPage(ROOT_PAGE);
      expect(index.pageBlocks(CHILD_PAGE).map((block) => block.id)).toEqual(["p2"]);
      const childBlock = index.pageBlocks(ROOT_PAGE).find((block) => block.kind === "child_page");
      expect(childBlock?.children).toEqual([]);
    } finally {
      rootBlocks.pop();
    }
  });

  test("增量:只重新拉取 last_edited 变化的页面", async () => {
    const sync = new NotionSync(client(fetches.fetchImpl), index);
    await sync.syncAll();
    const callsAfterFirst = fetches.calls.filter((call) => call.startsWith("GET /blocks/")).length;

    // 子页面有改动
    const child = PAGES[CHILD_PAGE];
    if (child) child.lastEdited = "2026-10-20T00:00:00.000Z";
    const summary = await sync.syncAll();
    expect(summary.pagesSynced).toBe(1);
    const callsAfterSecond = fetches.calls.filter((call) => call.startsWith("GET /blocks/")).length;
    // 只多了一次子页面内容请求
    expect(callsAfterSecond - callsAfterFirst).toBe(1);
  });

  test("归档删除与搜索", async () => {
    const sync = new NotionSync(client(fetches.fetchImpl), index);
    await sync.syncAll();
    // 把子页面标记归档
    const child = PAGES[CHILD_PAGE];
    if (child) {
      child.archived = true;
      child.lastEdited = "2026-10-21T00:00:00.000Z";
    }
    const summary = await sync.syncAll();
    expect(summary.removed).toBe(1);
    expect(index.pageLastEdited(CHILD_PAGE)).toBeNull();

    // FTS:中文短语可搜到
    const hits = index.search("周报", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("工作区首页");
  });

  test("幽灵清理:连续两轮缺席才移除", async () => {
    const sync = new NotionSync(client(fetches.fetchImpl), index);
    await sync.syncAll();
    // 真实 Notion 归档后搜索就查不到;索引里的残留行必须被 diff 清掉。
    const child = PAGES[CHILD_PAGE];
    if (child) child.hiddenFromSearch = true;
    // 第一轮缺席:只记一笔,不删(搜索是最终一致的,会瞬时漏页)
    const first = await sync.syncAll();
    expect(first.removed).toBe(0);
    expect(index.pageLastEdited(CHILD_PAGE)).not.toBeNull();
    // 第二轮缺席:确认真被删,清掉
    const second = await sync.syncAll();
    expect(second.removed).toBe(1);
    expect(index.pageLastEdited(CHILD_PAGE)).toBeNull();
    expect(index.countPages()).toBe(4);
  });

  test("瞬时漏页不清内容", async () => {
    const sync = new NotionSync(client(fetches.fetchImpl), index);
    await sync.syncAll();
    const child = PAGES[CHILD_PAGE];
    if (child) child.hiddenFromSearch = true;
    await sync.syncAll(); // 一次缺席:只记一笔
    expect(index.pageLastEdited(CHILD_PAGE)).not.toBeNull();
    if (child) child.hiddenFromSearch = false;
    await sync.syncAll(); // 搜索恢复:行和内容原样保留
    expect(index.pageLastEdited(CHILD_PAGE)).not.toBeNull();
    expect(index.pageBlocks(CHILD_PAGE).length).toBeGreaterThan(0);
  });

  test("误删后自愈:块丢了会被重拉", async () => {
    const sync = new NotionSync(client(fetches.fetchImpl), index);
    await sync.syncAll();
    const child = PAGES[CHILD_PAGE];
    if (child) child.hiddenFromSearch = true;
    await sync.syncAll();
    await sync.syncAll(); // 两轮缺席:行被清,marker 残留
    expect(index.pageLastEdited(CHILD_PAGE)).toBeNull();
    if (child) child.hiddenFromSearch = false;
    await sync.syncAll(); // 搜索恢复:元数据回来,内容也要重拉
    expect(index.pageLastEdited(CHILD_PAGE)).not.toBeNull();
    expect(index.pageBlocks(CHILD_PAGE).length).toBeGreaterThan(0);
  });

  test("空页复查:导入竞态拉空后不永久钉空", async () => {
    const sync = new NotionSync(client(fetches.fetchImpl), index);
    // 第一轮:页面已建、内容还没推(追加子块不会 bump last_edited_time)
    fetches.state.emptyPages.add(CHILD_PAGE);
    await sync.syncAll();
    expect(index.meta(`synced:${CHILD_PAGE}`)).toBeNull();
    expect(index.meta(`empty:${CHILD_PAGE}`)).not.toBeNull();
    // 第二轮:内容已推完,正常落块
    fetches.state.emptyPages.delete(CHILD_PAGE);
    await sync.syncAll();
    expect(index.pageBlocks(CHILD_PAGE).length).toBeGreaterThan(0);
    expect(index.meta(`synced:${CHILD_PAGE}`)).not.toBeNull();
    // 第三轮:干净页不再重复拉
    const before = fetches.calls.filter((call) => call.startsWith("GET /blocks/")).length;
    await sync.syncAll();
    const after = fetches.calls.filter((call) => call.startsWith("GET /blocks/")).length;
    expect(after - before).toBe(0);
  });

  test("连续两轮拉空才认定真空页", async () => {
    const sync = new NotionSync(client(fetches.fetchImpl), index);
    fetches.state.emptyPages.add(CHILD_PAGE);
    await sync.syncAll();
    await sync.syncAll();
    expect(index.meta(`synced:${CHILD_PAGE}`)).not.toBeNull();
    expect(index.pageBlocks(CHILD_PAGE)).toHaveLength(0);
  });
});

function treeOf(index: import("../../src/notion/store.js").NotionIndex) {
  // 复用 service.tree 的逻辑路径:经由 NotionService 检查更完整,这里轻量重建。
  const pages = index.listPages().filter((page) => page.parentKind !== "database");
  const roots = pages.filter((page) => page.parentKind === "workspace");
  return roots.map((root) => ({
    title: root.title,
    children: pages
      .filter((page) => page.parentId === root.pageId)
      .map((page) => ({ title: page.title, object: page.object })),
  }));
}

describe("notion model", () => {
  test("buildBlockModel 覆盖主要类型", () => {
    const heading = buildBlockModel({ id: "a", type: "heading_2", hasChildren: false, data: { rich_text: [text("标题")] } });
    expect(heading).toMatchObject({ kind: "heading", level: 2 });
    const todo = buildBlockModel({ id: "b", type: "to_do", hasChildren: false, data: { rich_text: [text("任务")], checked: true } });
    expect(todo).toMatchObject({ kind: "todo", checked: true });
    const callout = buildBlockModel({ id: "c", type: "callout", hasChildren: false, data: { rich_text: [text("提示")], icon: { type: "emoji", emoji: "💡" }, color: "blue_background" } });
    expect(callout).toMatchObject({ kind: "callout", emoji: "💡", color: "blue_background" });
    const unknown = buildBlockModel({ id: "d", type: "future_block", hasChildren: false, data: {} });
    expect(unknown).toMatchObject({ kind: "unknown", type: "future_block" });
  });

  test("tableRowCells 与 markdown 导出", () => {
    const row = tableRowCells({ cells: [[text("甲")], [text("乙")]] });
    expect(row).toHaveLength(2);
    expect(row[0]?.[0]?.text).toBe("甲");

    const tree = [
      buildBlockModel({ id: "h", type: "heading_1", hasChildren: false, data: { rich_text: [text("标题")] } }),
      buildBlockModel({ id: "t", type: "to_do", hasChildren: false, data: { rich_text: [text("买咖啡")], checked: true } }),
      buildBlockModel({ id: "p", type: "paragraph", hasChildren: false, data: { rich_text: [text("正文")] } }),
    ];
    const markdown = blocksToMarkdown(tree);
    expect(markdown).toContain("# 标题");
    expect(markdown).toContain("- [x] 买咖啡");
    expect(markdown).toContain("正文");
  });
});


function findModel(models: import("../../src/notion/model.js").NotionBlockModel[], id: string) {
  const visit = (list: import("../../src/notion/model.js").NotionBlockModel[]): import("../../src/notion/model.js").NotionBlockModel | null => {
    for (const model of list) {
      if (model.id === id) return model;
      const nested = visit(model.children);
      if (nested) return nested;
    }
    return null;
  };
  return visit(models);
}

describe("notion api client retries", () => {
  test("追加子块遇到 5xx 不重发(避免重复建块);读请求照常重试", async () => {
    const calls: string[] = [];
    let failNext = true;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const method = (init?.method as string) ?? "GET";
      calls.push(`${method} ${new URL(String(input)).pathname}`);
      if (failNext) {
        failNext = false;
        return new Response("bad gateway", { status: 502 });
      }
      return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = client(fetchImpl);
    await expect(api.appendBlocks("p", [{ type: "paragraph", paragraph: { rich_text: [] } }])).rejects.toThrow();
    expect(calls).toEqual(["PATCH /v1/blocks/p/children"]);
    failNext = true;
    await api.blockChildren("p");
    expect(calls.slice(1)).toEqual(["GET /v1/blocks/p/children", "GET /v1/blocks/p/children"]);
  });
});

describe("block model", () => {
  test("公式块、标题 4、可折叠标题、块颜色、视频从接口形状读出", () => {
    const equation = buildBlockModel({ id: "e", type: "equation", hasChildren: false, data: { expression: "E=mc^2" } });
    expect(equation.kind === "equation" ? equation.expression : null).toBe("E=mc^2");
    const h4 = buildBlockModel({ id: "h", type: "heading_4", hasChildren: true, data: { rich_text: [text("四")], is_toggleable: true, color: "blue" } });
    expect(h4.kind === "heading" ? [h4.level, h4.toggleable, h4.color] : null).toEqual([4, true, "blue"]);
    const video = buildBlockModel({ id: "v", type: "video", hasChildren: false, data: { type: "external", external: { url: "https://youtu.be/x" }, caption: [] } });
    expect(video.kind === "video" ? [video.url, video.source] : null).toEqual(["https://youtu.be/x", "external"]);
  });
});

describe("notion write path", () => {
  let dataDir: string;
  let fake: ReturnType<typeof fakeFetch>;

  const prepare = async (): Promise<NotionService> => {
    const { NotionIndex } = await import("../../src/notion/store.js");
    const { NotionSync } = await import("../../src/notion/sync.js");
    const index = new NotionIndex(join(dataDir, "notion-index.sqlite"));
    await new NotionSync(client(fake.fetchImpl), index).syncAll();
    index.close();
    const service = new NotionService({
      dataDir,
      platform: "darwin",
      memory: new MemoryKeychain(),
      fetch: fake.fetchImpl,
    });
    await service.setToken("secret_test");
    return service;
  };

  beforeEach(async () => {
    resetFixture();
    dataDir = await mkdtemp(join(tmpdir(), "notion-write-"));
    fake = fakeFetch();
  });

  test("编辑段落:markdown 渲染成粗体并回读", async () => {
    const service = await prepare();
    const view = await service.updateBlock("p1", "**加粗** 你好");
    const model = findModel(view.blocks, "p1");
    expect(model && model.kind === "paragraph" ? model.segments[0]?.bold : false).toBe(true);
    // view.markdown 是给 LLM 的纯文本;markdown 标注在块的 segment 上(上面已断言)。
    expect(view.markdown).toContain("加粗 你好");
  });

  test("turn-into:标题变文本,追加新块落在正确位置", async () => {
    const service = await prepare();
    const turned = await service.updateBlock("h1", "计划", "paragraph");
    const model = findModel(turned.blocks, "h1");
    expect(model?.kind).toBe("paragraph");

    const appended = await service.appendBlock({ afterBlockId: "p1", markdown: "新段落", kind: "todo" });
    const ids = appended.blocks.map((block) => block.id);
    expect(ids.indexOf("p1")).toBeGreaterThanOrEqual(0);
    // 新块在 p1 之后、h1 之前
    const newId = ids.find((id) => !["p1", "h1", "todo1", "tbl"].includes(id));
    expect(newId).toBeTruthy();
    if (newId) {
      expect(ids.indexOf(newId)).toBe(ids.indexOf("p1") + 1);
      const model = findModel(appended.blocks, newId);
      expect(model?.kind).toBe("todo");
    }
  });

  test("批量追加(粘贴 Markdown):多个块一次落在 after 之后且保持顺序", async () => {
    const service = await prepare();
    const before = ["p1", "h1", "todo1", "tbl"];
    const appended = await service.appendBlock({
      afterBlockId: "p1",
      markdown: "",
      children: [
        { kind: "paragraph", markdown: "", rich: [{ text: "甲", href: null, bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" }] },
        { kind: "numbered", markdown: "乙" },
        { kind: "todo", markdown: "丙", checked: true },
      ],
    });
    const ids = appended.blocks.map((block) => block.id);
    const fresh = ids.filter((id) => !before.includes(id));
    expect(fresh).toHaveLength(3);
    expect(ids.slice(ids.indexOf("p1") + 1, ids.indexOf("p1") + 4)).toEqual(fresh);
    expect(fresh.map((id) => findModel(appended.blocks, id)?.kind)).toEqual(["paragraph", "numbered", "todo"]);
    const todo = findModel(appended.blocks, fresh[2] ?? "");
    expect(todo && todo.kind === "todo" ? todo.checked : false).toBe(true);
  });

  test("写入后直接更新本地索引,不再整页回拉 Notion", async () => {
    const service = await prepare();
    const before = fake.calls.length;
    await service.updateBlock("p1", "**改了**");
    const appended = await service.appendBlock({ afterBlockId: "p1", markdown: "新段", kind: "paragraph" });
    const newId = appended.blocks[1]?.id ?? "";
    await service.patchTitle(ROOT_PAGE, "新标题");
    const view = await service.deleteBlock("todo1");
    const reads = fake.calls.slice(before).filter((call) => call.startsWith("GET "));
    expect(reads).toEqual([]);
    const text = (id: string) => {
      const model = findModel(view.blocks, id);
      return model && "segments" in model ? model.segments.map((segment) => segment.text).join("") : null;
    };
    expect(view.title).toBe("新标题");
    expect(view.blocks.map((block) => block.id)).toEqual(["p1", newId, "h1", "tbl"]);
    expect(text("p1")).toBe("改了");
    expect(text(newId)).toBe("新段");
    // 表格行等未改动的块原样保留;全文索引跟着更新
    const table = findModel(view.blocks, "tbl");
    expect(table && table.kind === "table" ? table.rows.length : 0).toBe(2);
    expect(service.search("新段").some((hit) => hit.pageId === ROOT_PAGE)).toBe(true);
  });

  const seg = (value: string) => ({
    text: value, href: null, bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default",
  });
  const textOf = (model: NotionBlockModel | null) =>
    model && "segments" in model ? model.segments.map((segment) => segment.text).join("") : null;

  test("移动整棵子树:表格可以移动,行内容不丢,原块删除", async () => {
    const service = await prepare();
    const { page, created } = await service.relocateBlocks({ blockIds: ["tbl"], mode: "move", afterBlockId: "p1" });
    const ids = page.blocks.map((block) => block.id);
    expect(ids).not.toContain("tbl");
    expect(ids[1]).toBe(created[0]?.id);
    expect(ids.slice(2)).toEqual(["h1", "todo1"]);
    const table = created[0];
    expect(table?.kind).toBe("table");
    expect(table && table.kind === "table" ? table.rows.map((row) => row.map((cell) => cell.map((s) => s.text).join(""))) : []).toEqual(TABLE_ROWS);
    expect(fake.state.deleted.has("tbl")).toBe(true);
  });

  test("移动返回原 id → 新 id 的对应(整棵子树)", async () => {
    const service = await prepare();
    const { created } = await service.createBlocks({
      afterBlockId: "p1",
      models: [{ kind: "toggle", segments: [seg("父")], children: [{ kind: "paragraph", segments: [seg("子")], children: [] }] }],
    });
    const parent = created[0]!;
    const child = parent.children[0]!;
    const moved = await service.relocateBlocks({ blockIds: [parent.id], mode: "move", atStart: true });
    const newParent = moved.created[0]!;
    expect(moved.idMap).toEqual([
      [parent.id, newParent.id],
      [child.id, newParent.children[0]!.id],
    ]);
  });

  test("新建任意块:三层嵌套、分栏与图片;复制与转类型保留子树", async () => {
    const service = await prepare();
    const { page, created } = await service.createBlocks({
      afterBlockId: "p1",
      models: [
        {
          kind: "bulleted",
          segments: [seg("一")],
          children: [{ kind: "bulleted", segments: [seg("二")], children: [{ kind: "paragraph", segments: [seg("三")], children: [] }] }],
        },
        {
          kind: "column_list",
          children: [
            { kind: "column", children: [{ kind: "paragraph", segments: [seg("左")], children: [] }] },
            { kind: "column", children: [{ kind: "paragraph", segments: [seg("右")], children: [] }] },
          ],
        },
        { kind: "image", url: "https://example.com/a.png", caption: [seg("说明")], children: [] },
      ],
    });
    expect(created.map((model) => model.kind)).toEqual(["bulleted", "column_list", "image"]);
    const list = created[0]!;
    expect(textOf(list.children[0]?.children[0] ?? null)).toBe("三");
    const columns = created[1]!.children;
    expect(columns.map((column) => textOf(column.children[0] ?? null))).toEqual(["左", "右"]);
    const image = created[2]!;
    expect(image.kind === "image" ? [image.url, image.caption[0]?.text] : []).toEqual(["https://example.com/a.png", "说明"]);
    expect(page.blocks.map((block) => block.id).slice(0, 4)).toEqual(["p1", ...created.map((model) => model.id)]);

    // 复制:副本带整棵子树,原块还在
    const copy = await service.relocateBlocks({ blockIds: [list.id], mode: "copy", afterBlockId: list.id });
    expect(textOf(copy.created[0]?.children[0]?.children[0] ?? null)).toBe("三");
    expect(copy.page.blocks.some((block) => block.id === list.id)).toBe(true);

    // 转类型:原地重建成可折叠标题,带颜色,子块跟着走
    const turned = await service.relocateBlocks({
      blockIds: [list.id],
      mode: "move",
      afterBlockId: list.id,
      root: { kind: "heading", level: 2, toggleable: true, color: "blue", segments: [seg("一")] },
    });
    const heading = turned.created[0]!;
    expect(heading.kind === "heading" ? [heading.level, heading.toggleable, heading.color] : []).toEqual([2, true, "blue"]);
    expect(textOf(heading.children[0] ?? null)).toBe("二");
    expect(findModel(turned.page.blocks, list.id)).toBeNull();
  });

  test("分栏里放表格、标签页带内容:第二层随请求建,表格先占位再替换", async () => {
    const service = await prepare();
    const { created } = await service.createBlocks({
      afterBlockId: "p1",
      models: [
        {
          kind: "column_list",
          children: [
            { kind: "column", children: [{ kind: "paragraph", segments: [seg("左")], children: [{ kind: "paragraph", segments: [seg("左下")], children: [] }] }] },
            { kind: "column", children: [{ kind: "table", hasHeader: true, rows: [[[seg("A")], [seg("B")]]], children: [] }] },
          ],
        },
        { kind: "tab", children: [{ kind: "paragraph", segments: [seg("标签一")], children: [{ kind: "paragraph", segments: [seg("内容一")], children: [] }] }] },
      ],
    });
    const [columns, tabs] = created;
    expect(textOf(columns?.children[0]?.children[0] ?? null)).toBe("左");
    expect(textOf(columns?.children[0]?.children[0]?.children[0] ?? null)).toBe("左下");
    const right = columns?.children[1]?.children ?? [];
    expect(right.map((model) => model.kind)).toEqual(["table"]);
    expect(textOf(tabs?.children[0]?.children[0] ?? null)).toBe("内容一");
  });

  test("刚在本机写过的页面,后台同步读到滞后的旧内容时不覆盖", async () => {
    const service = await prepare();
    await service.deleteBlock("todo1");
    // 模拟 Notion 写后读滞后:页面已改(时间戳变了),但子块列表还是删除前的样子。
    fake.state.deleted.delete("todo1");
    const root = PAGES[ROOT_PAGE]!;
    const lastEdited = root.lastEdited;
    root.lastEdited = "2026-10-31T00:00:00.000Z";
    try {
      await service.sync();
      const view = await service.page(ROOT_PAGE);
      expect(view?.blocks.map((block) => block.id)).toEqual(["p1", "h1", "tbl"]);
    } finally {
      root.lastEdited = lastEdited;
    }
  });

  test("移动到另一个页面;复制页面连正文一起", async () => {
    const service = await prepare();
    const moved = await service.relocateBlocks({ blockIds: ["p1"], mode: "move", targetPageId: CHILD_PAGE, atStart: false });
    expect(moved.page.id).toBe(ROOT_PAGE);
    expect(moved.page.blocks.map((block) => block.id)).toEqual(["h1", "todo1", "tbl"]);
    const child = await service.page(CHILD_PAGE);
    expect(child?.blocks.map((block) => textOf(block))).toEqual(["子页面内容", "你好,"]);
    expect(moved.idMap[0]?.[0]).toBe("p1");

    const copy = await service.duplicatePage(CHILD_PAGE, " (副本)");
    const view = await service.page(copy.pageId);
    expect(view?.title).toBe("子页面 (副本)");
    expect(view?.blocks.map((block) => textOf(block))).toEqual(["子页面内容", "你好,"]);
    await expect(service.duplicatePage(ROOT_PAGE, " (副本)")).rejects.toThrow("子页面");
  });

  test("移到最前面:返回整列子块时认出真正的新块,原块删除后新块还在", async () => {
    const service = await prepare();
    const { page, created } = await service.relocateBlocks({ blockIds: ["todo1"], mode: "move", atStart: true });
    expect(created[0]?.id).not.toBe("todo1");
    expect(created[0]?.kind).toBe("todo");
    expect(page.blocks.map((block) => block.id)).toEqual([created[0]!.id, "p1", "h1", "tbl"]);
  });

  test("改属性:颜色与可折叠写进 PATCH,改文字时颜色不丢;删除可以撤销", async () => {
    const service = await prepare();
    await service.patchBlock("p1", { kind: "paragraph", segments: [seg("你好,")], color: "red_background" });
    expect((fake.state.overrides.get("p1")?.paragraph as Record<string, unknown>).color).toBe("red_background");
    await service.updateBlock("p1", "", undefined, undefined, [seg("改字")]);
    expect((fake.state.overrides.get("p1")?.paragraph as Record<string, unknown>).color).toBe("red_background");
    await expect(service.patchBlock("p1", { kind: "heading", level: 1, segments: [] })).rejects.toThrow("转换为");

    await service.deleteBlock("todo1");
    const restored = await service.restoreBlocks({ blockIds: ["todo1"], pageId: ROOT_PAGE, afterBlockId: "h1" });
    // Notion 恢复到末尾后再移回原位置:新 id 在 h1 后面,内容不变
    const back = restored.idMap[0]?.[1];
    expect(restored.idMap[0]?.[0]).toBe("todo1");
    expect(restored.page.blocks.map((block) => block.id)).toEqual(["p1", "h1", back ?? "", "tbl"]);
    expect(restored.page.blocks[2]?.kind).toBe("todo");
  });

  test("内嵌数据库:改单元格、新建行、删除行,本地索引立刻更新", async () => {
    const service = await prepare();
    let view = await service.updateDatabaseCell({ databaseId: DATABASE, rowId: ROW_PAGE_A, property: "优先级", value: "5" });
    expect(view.rows.find((row) => row.id === ROW_PAGE_A)?.cells.find((cell) => cell.name === "优先级")?.text).toBe("5");
    view = await service.updateDatabaseCell({ databaseId: DATABASE, rowId: ROW_PAGE_A, property: "名称", value: "改名" });
    expect(view.rows.find((row) => row.id === ROW_PAGE_A)?.title).toBe("改名");
    await expect(service.updateDatabaseCell({ databaseId: DATABASE, rowId: ROW_PAGE_A, property: "优先级", value: "abc" })).rejects.toThrow("数字");
    view = await service.addDatabaseRow({ databaseId: DATABASE, title: "第三行" });
    const added = view.rows.find((row) => row.title === "第三行");
    expect(added).toBeDefined();
    view = await service.deleteDatabaseRow({ databaseId: DATABASE, rowId: added!.id });
    expect(view.rows.some((row) => row.title === "第三行")).toBe(false);
    expect(view.columns.find((column) => column.name === "状态")?.type).toBe("select");
  });

  test("数据库的列:新增、改名、删除;数据库行页面带列信息", async () => {
    const service = await prepare();
    let view = await service.updateDatabaseSchema({ op: "add", databaseId: DATABASE, name: "备注", type: "rich_text" });
    expect(view.columns.map((column) => column.name)).toContain("备注");
    view = await service.updateDatabaseSchema({ op: "rename", databaseId: DATABASE, name: "备注", newName: "说明" });
    expect(view.columns.map((column) => column.name)).toContain("说明");
    view = await service.updateDatabaseSchema({ op: "delete", databaseId: DATABASE, name: "说明" });
    expect(view.columns.map((column) => column.name)).not.toContain("说明");
    await expect(service.updateDatabaseSchema({ op: "delete", databaseId: DATABASE, name: "名称" })).rejects.toThrow("标题列");
    const row = await service.page(ROW_PAGE_A);
    expect(row?.database?.id).toBe(DATABASE);
    expect(row?.database?.columns.find((column) => column.name === "优先级")?.type).toBe("number");
  });

  test("新建内嵌数据库:页面末尾多一个数据库块,带默认列,可以直接加行", async () => {
    const service = await prepare();
    const { page, databaseId } = await service.createDatabase({ pageId: ROOT_PAGE, title: "任务", inline: true });
    expect(page.blocks.at(-1)).toMatchObject({ kind: "child_database", databaseId, title: "任务" });
    const view = service.databaseView(databaseId);
    expect(view?.columns.map((column) => column.type).sort()).toEqual(["date", "multi_select", "select", "title"]);
    expect(view?.columns.find((column) => column.type === "select")?.options).toEqual(["未开始", "进行中", "完成"]);
  });

  test("子页面等接口建不了的块拒绝移动", async () => {
    const service = await prepare();
    const { NotionIndex } = await import("../../src/notion/store.js");
    const index = new NotionIndex(join(dataDir, "notion-index.sqlite"));
    const blocks = index.pageBlocks(ROOT_PAGE);
    index.replaceBlocks(ROOT_PAGE, [
      ...blocks.map((model, idx) => ({ blockId: model.id, pageId: ROOT_PAGE, parentBlockId: null, idx, model })),
      { blockId: "cp", pageId: ROOT_PAGE, parentBlockId: null, idx: blocks.length, model: { id: "cp", children: [], kind: "child_page", title: "x", pageId: "cp" } },
    ]);
    index.close();
    await expect(service.relocateBlocks({ blockIds: ["cp"], mode: "move", afterBlockId: "p1" })).rejects.toThrow("子页面");
  });

  test("表格编辑:改一行、插入/删除行、切换表头,行 id 跟着走,不回拉 Notion", async () => {
    const service = await prepare();
    const cell = (value: string) => [
      { text: value, href: null, bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
    ];
    const before = fake.calls.length;
    await service.tableEdit({ op: "update-row", tableId: "tbl", rowIndex: 1, cells: [cell("改A"), cell("改B")] });
    await service.tableEdit({ op: "insert-row", tableId: "tbl", afterIndex: 0, cells: [cell("新1")] });
    await service.tableEdit({ op: "insert-row", tableId: "tbl", afterIndex: -1, cells: [cell("最前"), cell("x")] });
    await service.tableEdit({ op: "delete-row", tableId: "tbl", rowIndex: 3 });
    const view = await service.tableEdit({ op: "set-header", tableId: "tbl", hasRowHeader: true });
    expect(fake.calls.slice(before).filter((call) => call.startsWith("GET "))).toEqual([]);
    const table = findModel(view.blocks, "tbl");
    if (!table || table.kind !== "table") throw new Error("表格不见了");
    const text = (row: (typeof table.rows)[number]) => row.map((c) => c.map((s) => s.text).join(""));
    // 行宽对齐到表格列数(少的补空)
    expect(table.rows.map(text)).toEqual([["最前", "x"], ["列一", "列二"], ["新1", ""]]);
    expect(table.rowIds?.length).toBe(3);
    expect(table.rowIds?.[1]).toBe("row-0");
    expect(table.hasRowHeader).toBe(true);
    expect(table.hasHeader).toBe(true);
    await expect(service.tableEdit({ op: "delete-row", tableId: "tbl", rowIndex: 9 })).rejects.toThrow("不存在");
  });

  test("表格编辑:旧索引没有行 id 时补拉一次;增删列整表重建换成新表", async () => {
    const service = await prepare();
    const { NotionIndex } = await import("../../src/notion/store.js");
    const index = new NotionIndex(join(dataDir, "notion-index.sqlite"));
    const strip = (models: NotionBlockModel[]): NotionBlockModel[] =>
      models.map((model) => {
        if (model.kind !== "table") return model;
        const { rowIds: _dropped, ...rest } = model;
        return rest;
      });
    const rows: Array<{ blockId: string; pageId: string; parentBlockId: string | null; idx: number; model: NotionBlockModel }> = [];
    strip(index.pageBlocks(ROOT_PAGE)).forEach((model, idx) => rows.push({ blockId: model.id, pageId: ROOT_PAGE, parentBlockId: null, idx, model }));
    index.replaceBlocks(ROOT_PAGE, rows);
    index.close();
    const cell = (value: string) => [
      { text: value, href: null, bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
    ];
    const before = fake.calls.length;
    await service.tableEdit({ op: "update-row", tableId: "tbl", rowIndex: 0, cells: [cell("表头改"), cell("二")] });
    expect(fake.calls.slice(before).filter((call) => call === "GET /blocks/tbl/children")).toHaveLength(1);

    const view = await service.tableEdit({
      op: "rebuild",
      tableId: "tbl",
      hasHeader: true,
      hasRowHeader: false,
      rows: [[cell("a"), cell("b"), cell("c")], [cell("1"), cell("2"), cell("3")]],
    });
    expect(findModel(view.blocks, "tbl")).toBeNull();
    const rebuilt = view.blocks.find((block) => block.kind === "table");
    if (!rebuilt || rebuilt.kind !== "table") throw new Error("新表格不见了");
    expect(rebuilt.rows.map((row) => row.map((c) => c.map((s) => s.text).join("")))).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(rebuilt.rowIds?.length).toBe(2);
    // 新表在原位置(todo1 之后)
    expect(view.blocks.map((block) => block.kind)).toEqual(["paragraph", "heading", "todo", "table"]);
  });

  test("atStart:新块插到页面最前面,用新版本头", async () => {
    const service = await prepare();
    const appended = await service.appendBlock({ pageId: ROOT_PAGE, markdown: "标题下的新行", kind: "paragraph", atStart: true });
    const first = appended.blocks[0];
    expect(first && first.kind === "paragraph" ? first.segments[0]?.text : "").toBe("标题下的新行");
    expect(appended.blocks[1]?.id).toBe("p1");
    expect(fake.state.appendVersions.at(-1)).toBe(MOVE_PAGE_NOTION_VERSION);
    await expect(
      service.appendBlock({ afterBlockId: "p1", markdown: "x", atStart: true }),
    ).rejects.toThrow("atStart");
  });

  test("粘贴表格:建 table 块带表头与行,超过 100 行的部分续写到表格下", async () => {
    const bodies: Array<{ key: string; body: { children: Array<Record<string, unknown>> } }> = [];
    const original = fake.fetchImpl;
    fake = {
      ...fake,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const path = new URL(String(input)).pathname.replace(/^\/v1/u, "");
        if (init?.method === "PATCH" && path.endsWith("/children")) {
          bodies.push({ key: path, body: JSON.parse(String(init.body)) });
        }
        return original(input, init);
      }) as typeof fetch,
    };
    const service = await prepare();
    const cell = (value: string) => [
      { text: value, href: null, bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
    ];
    // 第二行只给一格:补齐到表头的列数
    const rows = [[cell("问题"), cell("文件数")], [cell("甲")], ...Array.from({ length: 148 }, (_, i) => [cell(`r${i}`), cell(String(i))])];
    await service.appendBlock({ afterBlockId: "p1", markdown: "", children: [{ kind: "table", markdown: "", table: { hasHeader: true, rows } }] });

    expect(bodies).toHaveLength(2);
    const table = bodies[0]?.body.children[0] as { type: string; table: Record<string, unknown> };
    expect(table.type).toBe("table");
    expect(table.table).toMatchObject({ table_width: 2, has_column_header: true, has_row_header: false });
    const firstRows = table.table.children as Array<{ table_row: { cells: unknown[][] } }>;
    expect(firstRows).toHaveLength(100);
    expect(firstRows[1]?.table_row.cells).toHaveLength(2);
    expect(firstRows[1]?.table_row.cells[1]).toEqual([]);
    // 续写:追加到新建表格的 id 下,剩下 50 行
    expect(bodies[1]?.key).toMatch(/^\/blocks\/new-[^/]+\/children$/u);
    expect(bodies[1]?.body.children).toHaveLength(50);
    expect(bodies[1]?.body.children[0]?.type).toBe("table_row");
  });

  test("移动:上移后顺序交换;带子块的块拒绝移动", async () => {
    const service = await prepare();
    const moved = await service.moveBlock("h1", "up");
    expect(moved.blocks.map((block) => block.id)[0]).toBe("h1");
    // 复制+删除的移动语义:副本拿到新 id(真实 Notion 同样如此),内容仍是原 p1 的。
    const movedCopy = moved.blocks[1];
    expect(movedCopy && movedCopy.kind === "paragraph" ? movedCopy.segments[0]?.text : "").toBe("你好,");

    // todo1 往下移,邻居是表格(行在 rows 不在 children,但同样不可编辑重建)→ 拒绝。
    await expect(service.moveBlock("todo1", "down")).rejects.toThrow("暂不支持");
  });

  test("删除与标题", async () => {
    const service = await prepare();
    const removed = await service.deleteBlock("todo1");
    expect(findModel(removed.blocks, "todo1")).toBeNull();

    const renamed = await service.patchTitle(ROW_PAGE_A, "改过的标题");
    expect(renamed.title).toBe("改过的标题");
  });

  test("移动页面:调用新版接口、侧栏结构立刻变化,非法目标被拒", async () => {
    const service = await prepare();
    const a = await service.createPage({ title: "甲" });
    const b = await service.createPage({ title: "乙" });
    const inner = await service.createPage({ parentId: a.pageId, title: "甲的子页" });

    const moved = await service.movePage(b.pageId, a.pageId);
    const find = (nodes: NotionTreeNode[], id: string): NotionTreeNode | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const nested = find(node.children, id);
        if (nested) return nested;
      }
      return null;
    };
    expect(find(moved.roots, a.pageId)?.children.map((node) => node.id)).toContain(b.pageId);
    expect(fake.state.moves).toEqual([{ pageId: b.pageId, parentId: a.pageId, version: "2026-03-11" }]);
    // 其余请求仍用原来的版本
    expect(fake.calls.some((call) => call === "POST /pages")).toBe(true);

    // 移到原本就在的父页面下:不再发请求
    await service.movePage(b.pageId, a.pageId);
    expect(fake.state.moves).toHaveLength(1);

    // 不能移到自己、自己的子孙下面,也不能移数据库
    await expect(service.movePage(a.pageId, a.pageId)).rejects.toThrow("自己下面");
    await expect(service.movePage(a.pageId, b.pageId)).rejects.toThrow("子页面");
    await expect(service.movePage(a.pageId, inner.pageId)).rejects.toThrow("子页面");
    await expect(service.movePage(ROW_PAGE_A, a.pageId)).rejects.toThrow();
    expect(fake.state.moves).toHaveLength(1);
  });

  test("新建页面与删除页面", async () => {
    const service = await prepare();
    const created = await service.createPage({ title: "新笔记" });
    expect(created.pageId).toBeTruthy();
    // 索引立刻可见(不等下一轮全量同步)
    const roots = await service.tree();
    const root = roots[0];
    expect(root?.children.some((node) => node.title === "新笔记")).toBe(true);
    // 视图可打开(空内容)
    expect(created.view?.title).toBe("新笔记");

    // 归档:索引里消失
    const child = await service.createPage({ parentId: created.pageId, title: "子页" });
    expect(child.pageId).toBeTruthy();
    await service.archivePage(created.pageId);
    const after = await service.tree();
    // 级联:父页面删掉后,子页面不能变成孤儿浮到顶层
    const titles: string[] = [];
    const visit = (nodes: NotionTreeNode[]): void => {
      for (const node of nodes) {
        titles.push(node.title);
        visit(node.children);
      }
    };
    visit(after);
    expect(titles).not.toContain("新笔记");
    expect(titles).not.toContain("子页");

    // 重复归档(页面在 Notion 侧已删):不报错,幂等成功
    await expect(service.archivePage(created.pageId)).resolves.toBeTruthy();
    delete PAGES[created.pageId];
    delete PAGES[child.pageId];
  });

  test("to_do 勾选切换", async () => {
    const service = await prepare();
    const view = await service.updateBlock("todo1", "写周报", undefined, true);
    const model = findModel(view.blocks, "todo1");
    expect(model && model.kind === "todo" ? model.checked : false).toBe(true);
  });
});

describe("notion service", () => {
  let dataDir: string;

  beforeEach(async () => {
    resetFixture();
    dataDir = await mkdtemp(join(tmpdir(), "notion-svc-"));
  });

  test("没有令牌时 status 正常、sync 报错", async () => {
    const service = new NotionService({
      dataDir,
      platform: "darwin",
      memory: new MemoryKeychain(),
    });
    const status = await service.status();
    expect(status.hasToken).toBe(false);
    await expect(service.sync()).rejects.toThrow();
  });

  test("保存令牌后可同步并读页面;数据库行的属性进页面视图", async () => {
    const fetches = fakeFetch();
    const service = new NotionService({
      dataDir,
      platform: "darwin",
      memory: new MemoryKeychain(),
      fetch: fetches.fetchImpl,
    });
    await service.setToken("secret_test");
    const status = await service.status();
    expect(status.hasToken).toBe(true);

    // 用同一套 fake 直接经由内部索引同步(service 的私有 client 与这里同构)。
    const { NotionIndex } = await import("../../src/notion/store.js");
    const { NotionSync } = await import("../../src/notion/sync.js");
    const index = new NotionIndex(join(dataDir, "notion-index.sqlite"));
    await new NotionSync(client(fetches.fetchImpl), index).syncAll();
    index.close();

    const test = await service.testConnection();
    expect(test.ok).toBe(true);
    if (test.ok) expect(test.workspaceName).toBe("John 的工作区");

    const roots = await service.tree();
    expect(roots).toHaveLength(1);
    const databaseNode = roots[0]?.children.find((node) => node.object === "database");
    expect(databaseNode).toBeTruthy();

    // 数据库行页面带属性
    const row = await service.page(ROW_PAGE_A);
    expect(row?.properties?.["状态"]).toContain("进行中");
    const markdown = await service.pageMarkdown(ROW_PAGE_A);
    expect(markdown).toContain("# 第一行");
    expect(markdown).toContain("优先级: 2");

    const database = service.databaseView(DATABASE);
    expect(database?.columns.map((column) => column.name)).toEqual(["名称", "状态", "优先级"]);
    expect(database?.rows).toHaveLength(2);
  });
});

