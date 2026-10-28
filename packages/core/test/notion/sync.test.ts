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
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname.replace(/^\/v1/u, "");
    void init;
    const key = `${(init?.method as string) ?? "GET"} ${path}`;
    calls.push(key);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (key === "POST /search") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { start_cursor?: string };
      const all = Object.values(PAGES).map((def) => apiPage(def));
      all.push(databaseObject());
      const start = body.start_cursor === "next" ? 3 : 0;
      const slice = all.slice(start, start + 3);
      return json({
        results: slice,
        has_more: start + 3 < all.length,
        next_cursor: start + 3 < all.length ? "next" : null,
      });
    }
    const blockMatch = /^GET \/blocks\/([^/]+)\/children/u.exec(key);
    if (blockMatch) {
      const id = decodeURIComponent(blockMatch[1] ?? "");
      if (id === ROOT_PAGE) {
        return json({ results: PAGES[ROOT_PAGE]?.blocks ?? [], has_more: false, next_cursor: null });
      }
      if (id === CHILD_PAGE) {
        return json({ results: PAGES[CHILD_PAGE]?.blocks ?? [], has_more: false, next_cursor: null });
      }
      if (id === TABLE_BLOCK_ID) {
        return json({
          results: TABLE_ROWS.map((cells, index) => ({
            object: "block",
            id: `row-${index}`,
            type: "table_row",
            has_children: false,
            table_row: {
              cells: cells.map((value) => [text(value)]),
            },
          })),
          has_more: false,
          next_cursor: null,
        });
      }
      return json({ results: [], has_more: false, next_cursor: null });
    }
    if (key === `GET /databases/${DATABASE}`) return json(databaseObject());
    if (key === `POST /databases/${DATABASE}/query`) {
      return json({
        results: [PAGES[ROW_PAGE_A], PAGES[ROW_PAGE_B]].map((def) => ({
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
    if (key === "GET /users/me") {
      return json({ name: "you-brain", bot: { workspace_name: "John 的工作区" } });
    }
    return json({ code: "object_not_found", message: "not found" }, 404);
  };
  return { fetchImpl: impl, calls };
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

describe("notion service", () => {
  let dataDir: string;

  beforeEach(async () => {
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

