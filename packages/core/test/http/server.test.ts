import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDefaultRoles,
  createDefaultSharedConfig,
  type DeviceRecord,
  type Roles,
  type SharedConfig,
} from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { createDaemonClient } from "../../src/http/client.js";
import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";
import type {
  DaemonEvent,
  SearchRequest,
  StatusResponse,
  TodayResponse,
  TodoView,
  TopicDetail,
  TopicListItem,
  UploadActionInput,
} from "../../src/http/types.js";

const SESSION = "ab".repeat(32);
const FIXED_ID = "01J00000000000000000000000";

function directory(): string {
  return mkdtempSync(join(tmpdir(), "you-brain-http-"));
}

function topic(id: string, extra: Partial<TopicDetail> = {}): TopicDetail {
  return {
    topicId: id,
    name: id === "topic-1" ? "设计" : "另一个",
    aliases: ["design"],
    status: "active",
    statusBy: "auto",
    summary: "概要",
    nextStep: "下一步",
    lastActive: "2026-07-20T00:00:00.000Z",
    zone: "active",
    mergedInto: null,
    createdTs: "2026-07-01T00:00:00.000Z",
    lastUserOpAt: null,
    userLocked: false,
    conclusions: [],
    todos: [],
    sessions:
      id === "topic-1"
        ? [
            {
              sessionKey: SESSION,
              source: "codex",
              device: "laptop",
              fileId: "file-1",
              title: "会话",
              summary: "摘要",
              updatedAt: "2026-07-20T00:00:00.000Z",
            },
          ]
        : [],
    ...extra,
  };
}

interface Harness {
  server: DaemonHttpServer;
  events: Array<{ type: string; data: unknown }>;
  roles: { current: Roles };
  config: { current: SharedConfig };
  calls: {
    topics: Array<unknown>;
    search: SearchRequest[];
    upload: UploadActionInput[];
    sync: number;
  };
}

async function withServer(
  run: (harness: Harness) => Promise<void>,
  options?: { staticDir?: string },
): Promise<void> {
  const dataDir = directory();
  const events: Harness["events"] = [];
  const roles = { current: createDefaultRoles() };
  const config = { current: createDefaultSharedConfig() };
  const calls: Harness["calls"] = { topics: [], search: [], upload: [], sync: 0 };
  const listItem: TopicListItem = {
    topicId: "topic-1",
    name: "设计",
    aliases: ["design"],
    status: "active",
    statusBy: "auto",
    summary: "概要",
    nextStep: "",
    lastActive: "2026-07-20T00:00:00.000Z",
    zone: "active",
    createdTs: null,
    lastUserOpAt: null,
    userLocked: false,
    openTodoCount: 1,
  };
  const todo: TodoView = {
    todoId: "todo-1",
    topicId: "topic-1",
    sessionKey: SESSION,
    text: "补测试",
    status: "open",
    statusBy: "auto",
    confidence: 0.8,
    ts: "2026-07-20T00:00:00.000Z",
    userLocked: false,
  };
  const today: TodayResponse = {
    date: "2026-07-20",
    timeZone: "UTC",
    sessions: [],
  };
  const status: StatusResponse = {
    deviceId: "11111111-1111-4111-8111-111111111111",
    drive: { reachable: true, accountEmail: "a@example.com" },
    sync: { lastSyncAt: null, pendingOutbox: 0 },
    search: { ready: true, documents: 2 },
    refine: { pending: 0, lastError: null },
    consolidation: {
      enabled: false,
      lastFinishedAt: null,
      stale: false,
      status: "disabled",
    },
    web: { processor: null, isLocalProcessor: false, pending: 0 },
    warnings: [],
  };
  const device: DeviceRecord = {
    deviceId: "11111111-1111-4111-8111-111111111111",
    displayName: "Mac",
    kind: "desktop",
    platform: "darwin",
    appVersion: "0.1.0",
    protocolVersion: 1,
    capabilities: ["capture"],
    lastSeenAt: "2026-07-20T00:00:00.000Z",
    lastActiveAt: "2026-07-20T00:00:00.000Z",
  };
  const deps: HttpDeps = {
    today: async () => today,
    topics: async (query) => {
      calls.topics.push(query);
      return { topics: [listItem] };
    },
    topic: async (id) => {
      if (id === "topic-1" || id === "topic-2") return topic(id);
      if (id === "merged") return topic(id, { mergedInto: "topic-1" });
      return null;
    },
    todo: async (id) => (id === "todo-1" ? todo : null),
    portrait: async (variant) =>
      variant === "missing"
        ? null
        : {
            variant,
            content: `# ${variant}`,
            path: `/portrait/${variant}.md`,
            updatedAt: "2026-07-20T00:00:00.000Z",
          },
    portraitSnapshots: async () => [
      { name: "twin-v1.md", path: "/portrait/twin-v1.md", updatedAt: null },
    ],
    portraitCorrections: async () => [],
    search: async (query) => {
      calls.search.push(query);
      return {
        query: query.query,
        indexStatus: "fresh",
        searchMode: "keyword",
        results: [],
        warnings: [],
      };
    },
    devices: async () => [device],
    readRoles: async () => roles.current,
    writeRoles: async (next) => {
      roles.current = next;
    },
    readConfig: async () => config.current,
    writeConfig: async (next) => {
      config.current = next;
    },
    status: async () => status,
    reminders: async () => ({ reminders: [] }),
    reminder: async () => null,
    reportActivity: async (at) => ({ at }),
    now: () => new Date("2026-07-20T00:00:00.000Z"),
    sync: async () => {
      calls.sync += 1;
      return { started: true, at: "2026-07-20T00:00:00.000Z" };
    },
    upload: async (input) => {
      calls.upload.push(input);
      return { dryRun: input.dryRun ?? false, scanned: 2, uploaded: 1, warnings: [] };
    },
    events: {
      emit(type, data) {
        events.push({ type, data });
      },
    },
  };
  const server = await startDaemonHttp({
    dataDir,
    deps,
    createId: () => FIXED_ID,
    ...(options?.staticDir ? { staticDir: options.staticDir } : {}),
  });
  try {
    await run({ server, events, roles, config, calls });
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function api(server: DaemonHttpServer, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization") && !headers.has("x-no-auth")) {
    headers.set("authorization", `Bearer ${server.token}`);
  }
  headers.delete("x-no-auth");
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function sse(response: Response): {
  until(predicate: (text: string) => boolean): Promise<string>;
  cancel(): Promise<void>;
} {
  const body = response.body;
  if (!body) throw new Error("missing body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async until(predicate) {
      const started = Date.now();
      while (Date.now() - started < 2000) {
        if (predicate(buffer)) return buffer;
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value);
      }
      if (predicate(buffer)) return buffer;
      throw new Error(`SSE timeout: ${buffer}`);
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

describe("local HTTP API", () => {
  it("binds loopback, writes daemon.json mode 600, and rejects missing tokens", async () => {
    await withServer(async ({ server }) => {
      expect(server.hostname).toBe("127.0.0.1");
      expect(server.port).toBeGreaterThan(0);
      expect(server.pid).toBe(process.pid);
      expect(statSync(server.file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(server.file, "utf8"))).toEqual({
        port: server.port,
        token: server.token,
        pid: process.pid,
      });
      const missing = await fetch(`${server.baseUrl}/api/today`);
      expect(missing.status).toBe(401);
      expect(await readJson(missing)).toEqual({
        error: { code: "UNAUTHORIZED", message: "缺少或无效的访问令牌" },
      });
      const wrong = await api(server, "/api/today", {
        headers: { authorization: "Bearer nope-nope-nope" },
      });
      expect(wrong.status).toBe(401);
      const queryToken = await fetch(`${server.baseUrl}/api/today?token=${server.token}`);
      expect(queryToken.status).toBe(401);
      const sseMissing = await fetch(`${server.baseUrl}/api/events`);
      expect(sseMissing.status).toBe(401);
    });
  });

  it("serves each read endpoint and rejects bad input", async () => {
    await withServer(async ({ server, calls }) => {
      expect((await readJson(await api(server, "/api/today"))).date).toBe("2026-07-20");
      const topics = await readJson(
        await api(server, "/api/topics?zone=active&status=follow_up"),
      );
      expect(calls.topics).toEqual([{ zone: "active", status: "follow_up" }]);
      expect(Array.isArray(topics.topics)).toBe(true);
      expect((await api(server, "/api/topics?zone=nope")).status).toBe(400);
      expect((await api(server, "/api/topics?status=nope")).status).toBe(400);
      expect((await api(server, "/api/topics", { method: "POST" })).status).toBe(405);

      const detail = await readJson(await api(server, "/api/topics/topic-1"));
      expect(detail.topicId).toBe("topic-1");
      expect((await api(server, "/api/topics/missing")).status).toBe(404);

      const portrait = await readJson(await api(server, "/api/portrait"));
      expect(portrait).toMatchObject({ variant: "full", content: "# full" });
      expect((await readJson(await api(server, "/api/portrait?variant=coding"))).variant).toBe(
        "coding",
      );
      expect((await api(server, "/api/portrait?variant=missing")).status).toBe(404);
      expect((await api(server, "/api/portrait?variant=../full")).status).toBe(400);
      const snapshots = await readJson(await api(server, "/api/portrait/snapshots"));
      expect(snapshots.snapshots).toEqual([
        { name: "twin-v1.md", path: "/portrait/twin-v1.md", updatedAt: null },
      ]);

      const search = await readJson(
        await api(server, "/api/search?q=release&limit=5&sources=codex&sources=cursor&from=2026-01-01"),
      );
      expect(search.query).toBe("release");
      expect(calls.search[0]).toEqual({
        query: "release",
        limit: 5,
        from: "2026-01-01",
        sources: ["codex", "cursor"],
      });
      expect((await api(server, "/api/search")).status).toBe(400);
      expect((await api(server, "/api/search?q=")).status).toBe(400);
      expect((await api(server, "/api/search?q=a&limit=0")).status).toBe(400);
      expect((await api(server, "/api/search?q=a&limit=51")).status).toBe(400);

      expect((await readJson(await api(server, "/api/devices"))).devices).toHaveLength(1);
      expect((await readJson(await api(server, "/api/status"))).deviceId).toEqual(
        expect.any(String),
      );
      expect(await readJson(await api(server, "/api/reminders"))).toEqual({ reminders: [] });
      expect((await api(server, "/api/missing")).status).toBe(404);

      const roles = await readJson(await api(server, "/api/roles"));
      expect(roles.timezone).toBe("Asia/Shanghai");
      const config = await readJson(await api(server, "/api/config"));
      expect((config.topics as { activeLimit: number }).activeLimit).toBeGreaterThan(0);
    });
  });

  it("maps user actions to protocol events and pushes SSE", async () => {
    await withServer(async ({ server, events, calls }) => {
      const stream = await fetch(`${server.baseUrl}/api/events?token=${encodeURIComponent(server.token)}`);
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const live = sse(stream);
      try {
        await live.until((text) => text.includes("event: ready"));

        const renamed = await readJson(
          await api(server, "/api/topics/topic-1", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: "rename", name: "新名字" }),
          }),
        );
        expect(renamed.ok).toBe(true);
        expect(events.at(-1)).toEqual({
          type: "topic.renamed",
          data: { topicId: "topic-1", name: "新名字", aliases: ["design"] },
        });

        const status = await api(server, "/api/topics/topic-1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "status", status: "parked" }),
        });
        expect(status.status).toBe(200);
        expect(events.at(-1)).toMatchObject({
          type: "topic.status_changed",
          data: { topicId: "topic-1", status: "parked", by: "user" },
        });

        const merged = await api(server, "/api/topics/topic-1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "merge", intoTopicId: "topic-2" }),
        });
        expect(merged.status).toBe(200);
        expect(events.at(-1)).toEqual({
          type: "topic.merged",
          data: { fromTopicId: "topic-1", intoTopicId: "topic-2" },
        });

        const split = await readJson(
          await api(server, "/api/topics/topic-1", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              op: "split",
              sessionKey: SESSION,
              target: { action: "assign", topicId: "topic-2" },
            }),
          }),
        );
        expect(split.events).toEqual([
          { type: "topic.unassigned", data: { topicId: "topic-1", sessionKey: SESSION } },
          { type: "topic.assigned", data: { topicId: "topic-2", sessionKey: SESSION } },
        ]);

        const created = await readJson(
          await api(server, "/api/topics/topic-1", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              op: "split",
              sessionKey: SESSION,
              target: { action: "create", name: "拆出来", aliases: ["part"] },
            }),
          }),
        );
        expect(created.events).toEqual([
          { type: "topic.unassigned", data: { topicId: "topic-1", sessionKey: SESSION } },
          {
            type: "topic.created",
            data: { topicId: FIXED_ID, name: "拆出来", aliases: ["part"] },
          },
          {
            type: "topic.assigned",
            data: { topicId: FIXED_ID, sessionKey: SESSION },
          },
        ]);

        const done = await api(server, "/api/actions/todo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ todoId: "todo-1", status: "done" }),
        });
        expect(done.status).toBe(200);
        const dropped = await api(server, "/api/actions/todo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ todoId: "todo-1", status: "dropped" }),
        });
        expect(dropped.status).toBe(200);
        expect(events.filter((event) => event.type === "todo.status_changed")).toEqual([
          { type: "todo.status_changed", data: { todoId: "todo-1", status: "done", by: "user" } },
          {
            type: "todo.status_changed",
            data: { todoId: "todo-1", status: "dropped", by: "user" },
          },
        ]);

        const conclusion = await readJson(
          await api(server, "/api/actions/conclusion", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              topicId: "topic-1",
              text: "决定用本地 API",
              sessionKey: SESSION,
            }),
          }),
        );
        expect(conclusion.events).toEqual([
          {
            type: "conclusion.added",
            data: {
              conclusionId: FIXED_ID,
              topicId: "topic-1",
              text: "决定用本地 API",
              sessionKey: SESSION,
            },
          },
        ]);

        const before = events.length;
        expect((await api(server, "/api/topics/missing", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "rename", name: "x" }),
        })).status).toBe(404);
        expect((await api(server, "/api/topics/topic-1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "rename", name: "" }),
        })).status).toBe(400);
        expect((await api(server, "/api/topics/topic-1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "merge", intoTopicId: "topic-1" }),
        })).status).toBe(400);
        expect((await api(server, "/api/topics/topic-1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "nope" }),
        })).status).toBe(400);
        expect((await api(server, "/api/topics/topic-1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })).status).toBe(400);
        expect((await api(server, "/api/topics/merged", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "status", status: "done" }),
        })).status).toBe(409);
        expect((await api(server, "/api/topics/topic-1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            op: "split",
            sessionKey: "ff".repeat(32),
            target: { action: "assign", topicId: "topic-2" },
          }),
        })).status).toBe(409);
        expect((await api(server, "/api/actions/todo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ todoId: "missing", status: "done" }),
        })).status).toBe(404);
        expect((await api(server, "/api/actions/todo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ todoId: "todo-1", status: "later" }),
        })).status).toBe(400);
        expect((await api(server, "/api/actions/conclusion", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topicId: "missing", text: "x", sessionKey: SESSION }),
        })).status).toBe(404);
        expect(events.length).toBe(before);

        expect((await readJson(await api(server, "/api/actions/sync", { method: "POST" }))).started).toBe(
          true,
        );
        expect(calls.sync).toBe(1);
        const uploaded = await readJson(
          await api(server, "/api/actions/upload", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sources: ["cursor"], dryRun: true }),
          }),
        );
        expect(uploaded).toMatchObject({ dryRun: true, scanned: 2, uploaded: 1 });
        expect(calls.upload[0]).toEqual({ sources: ["cursor"], dryRun: true });
        expect((await api(server, "/api/actions/upload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sources: ["not-a-source"] }),
        })).status).toBe(400);

        const putRoles = await readJson(
          await api(server, "/api/roles", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ timezone: "UTC" }),
          }),
        );
        expect(putRoles.timezone).toBe("UTC");
        expect(putRoles.mainDevice).toBeNull();
        expect((await api(server, "/api/roles", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mainDevice: "nope" }),
        })).status).toBe(400);
        const putConfig = await readJson(
          await api(server, "/api/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ topics: { activeLimit: 3 } }),
          }),
        );
        expect((putConfig.topics as { activeLimit: number }).activeLimit).toBe(3);
        expect((putConfig.topics as { historyDays: number }).historyDays).toBeGreaterThan(3);
        expect((await api(server, "/api/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ llm: { baseUrl: "not a url" } }),
        })).status).toBe(400);

        const text = await live.until(
          (value) =>
            value.includes("event: topics") &&
            value.includes("event: today") &&
            value.includes("event: status"),
        );
        expect(text).toContain('"kind":"topics"');
        expect(text).toContain('"kind":"today"');
        expect(text).toContain('"kind":"status"');
      } finally {
        await live.cancel();
      }
    });
  });

  it("explains how to find the web UI when no build directory is configured", async () => {
    await withServer(async ({ server }) => {
      const page = await fetch(`${server.baseUrl}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain("没有找到 Web 界面");
      expect(html).toContain("YOU_BRAIN_WEB_DIR");
      expect(html).toContain("../Resources/web");
      expect(html).toContain("apps/web/dist");
      const missing = await fetch(`${server.baseUrl}/missing.js`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    });
  });

  it("falls back to index.html for the web UI", async () => {
    const staticDir = directory();
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><p>app</p>");
    writeFileSync(join(staticDir, "app.js"), "console.log(1)");
    symlinkSync("/etc/passwd", join(staticDir, "secret"));
    try {
      await withServer(async ({ server }) => {
        expect(await (await fetch(`${server.baseUrl}/`)).text()).toContain("app");
        expect(await (await fetch(`${server.baseUrl}/topics/1`)).text()).toContain("app");
        expect(await (await fetch(`${server.baseUrl}/app.js`)).text()).toBe("console.log(1)");
        expect((await fetch(`${server.baseUrl}/missing.js`)).status).toBe(404);
        expect((await fetch(`${server.baseUrl}/secret`)).status).toBe(404);
      }, { staticDir });
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  it("client calls the daemon and listens for changes", async () => {
    await withServer(async ({ server }) => {
      const client = createDaemonClient({ port: server.port, token: server.token });
      expect((await client.today()).date).toBe("2026-07-20");
      await expect(
        createDaemonClient({ port: server.port, token: "wrong-token-value" }).today(),
      ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });

      const controller = new AbortController();
      const seen: DaemonEvent[] = [];
      let markReady: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const pending = client.events(
        (event) => {
          seen.push(event);
          if (event.kind === "ready") markReady();
          if (event.kind === "topics") controller.abort();
        },
        { signal: controller.signal },
      );
      await ready;
      const updated = await client.updateTopic("topic-1", {
        op: "status",
        status: "done",
      });
      expect(updated.events[0]).toMatchObject({
        type: "topic.status_changed",
        data: { by: "user", status: "done" },
      });
      await pending;
      expect(seen.some((event) => event.kind === "topics")).toBe(true);
    });
  });
});
