import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { MemoryKeychain } from "../../src/auth/secret-store.js";
import { NotionApiClient } from "../../src/notion/api-client.js";
import { buildBlockModel, blocksToMarkdown, tableRowCells } from "../../src/notion/model.js";
import { NotionService } from "../../src/notion/service.js";
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

function databaseObject(): Record<string, unknown> {
  return {
    object: "database",
    id: DATABASE,
    parent: { type: "page_id", page_id: ROOT_PAGE },
    archived: false,
    created_time: "2026-01-05T00:00:00.000Z",
    last_edited_time: "2026-10-04T00:00:00.000Z",
    title: [text("任务表")],
    properties: {
      名称: { type: "title" },
      状态: { type: "select" },
      优先级: { type: "number" },
    },
  };
}

function fakeFetch() {
  const calls: string[] = [];
  // 写操作的可变状态:覆盖、删除、插入,让重取 children 反映真实改动。
  const state = {
    overrides: new Map<string, Record<string, unknown>>(),
    deleted: new Set<string>(),
    inserted: new Map<string, Array<{ after: string | null; block: Record<string, unknown> }>>(),
  };
  const serveChildren = (base: Array<Record<string, unknown>>, parentId: string) => {
    let list = [...base];
    for (const ins of state.inserted.get(parentId) ?? []) {
      const idx = ins.after === null ? list.length : list.findIndex((b) => b.id === ins.after);
      list.splice(idx + 1, 0, ins.block);
    }
    list = list
      .filter((b) => !state.deleted.has(String(b.id)))
      .map((b) => {
        const override = state.overrides.get(String(b.id));
        return override ? { ...b, ...override } : b;
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
      const all = Object.values(PAGES).map((def) => apiPage(def));
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
      return json({ results: [], has_more: false, next_cursor: null });
    }
    if (key === `GET /databases/${DATABASE}`) return json(databaseObject());
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
    if (key === "POST /pages") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
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
      state.overrides.set(id, body);
      return json({ object: "block", id, ...body });
    }
    const appendMatch = /^PATCH \/blocks\/([^/]+)\/children$/u.exec(key);
    if (appendMatch) {
      const id = decodeURIComponent(appendMatch[1] ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        children: Array<Record<string, unknown>>;
        after?: string;
      };
      const after = body.after ?? null;
      const list = state.inserted.get(id) ?? [];
      body.children.forEach((child, index) => {
        // 真实 API 会分配块 id;fake 里补上,页面树才挂得起来。
        const withId = child.id ? child : { ...child, id: `new-${state.inserted.size}-${list.length + index}` };
        list.push({ after, block: withId });
      });
      state.inserted.set(id, list);
      return json({ results: body.children });
    }
    const deleteMatch = /^DELETE \/blocks\/([^/]+)$/u.exec(key);
    if (deleteMatch) {
      state.deleted.add(decodeURIComponent(deleteMatch[1] ?? ""));
      return json({ object: "block", id: deleteMatch[1], archived: true });
    }
    const patchPageMatch = /^PATCH \/pages\/([^/]+)$/u.exec(key);
    if (patchPageMatch) {
      const id = decodeURIComponent(patchPageMatch[1] ?? "");
      const def = PAGES[id];
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        properties: Record<string, { title: Array<{ text: { content: string } }> }>;
      };
      if (def) {
        const props = (def.properties ??= {});
        for (const [name, value] of Object.entries(body.properties)) {
          props[name] = { type: "title", title: value.title.map((part) => text(part.text.content)) };
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
    await service.archivePage(created.pageId);
    const after = await service.tree();
    expect(after[0]?.children.some((node) => node.title === "新笔记")).toBe(false);
    delete PAGES[created.pageId];
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

