import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  conversationKey,
  createEvent,
  inboxAppProperties,
} from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { writeDaemonEndpoint } from "../../src/http/daemon-file.js";
import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp } from "../../src/http/server.js";
import { createLocalMcpServices } from "../../src/mcp/local.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { NotionIndex } from "../../src/notion/store.js";
import { SqliteStore, type TopicRecord } from "../../src/store/index.js";

const NOW = "2026-07-20T12:00:00.000Z";
const KEY = "ab".repeat(32);

function directory(): string {
  return mkdtempSync(join(tmpdir(), "you-brain-mcp-"));
}

function deadPid(): number {
  for (let pid = 1_000_000; pid < 1_002_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code === "ESRCH") return pid;
    }
  }
  throw new Error("no unused pid");
}

function textOf(result: { [key: string]: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const block = content[0] as { text?: unknown } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

async function call(
  services: ReturnType<typeof createLocalMcpServices>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const server = createMcpServer(services);
  const client = new Client({ name: "you-brain-local-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("local MCP services", () => {
  it("reads sqlite, portrait files and Drive, and forwards writes to the daemon", async () => {
    const dataDir = directory();
    const portraitDir = join(dataDir, "portrait");
    mkdirSync(portraitDir, { recursive: true });
    writeFileSync(join(portraitDir, "coding.md"), "coding-profile");
    writeFileSync(
      join(portraitDir, "projects.md"),
      "# 数字分身 · 项目决定\n版本 v4.5.0 · 2026-11-18 · 变更见 changelog\n\n## 法务审批\n> repos: legal-ai\n法务走新审批流。\n\n## 运价通\n运价缓存五分钟。\n",
    );
    const store = new SqliteStore(join(dataDir, "state.sqlite"));
    const drive = new MemoryDrive();
    const events: Array<{ type: string; data: unknown }> = [];
    const topic: TopicRecord = {
      topicId: "topic-1",
      name: "设计",
      aliases: [],
      status: "active",
      statusBy: "auto",
      summary: "概要",
      nextStep: "",
      lastActive: NOW,
      mergedInto: null,
      createdTs: NOW,
      lastUserOpAt: null,
      lastContentAt: null,
      userLocked: false,
    };
    store.upsertSession({
      sessionKey: KEY,
      source: "codex",
      device: "laptop",
      startedAt: NOW,
      updatedAt: NOW,
      title: "标题",
      summary: "概要",
      topicId: "topic-1",
    });
    store.replaceDerived({
      topics: [topic],
      sessions: [
        {
          sessionKey: KEY,
          source: "codex",
          fileId: "file-1",
          title: "标题",
          summary: "概要",
          refinedUpTo: 1,
          topicId: "topic-1",
        },
      ],
      conclusions: [],
      todos: [
        {
          todoId: "todo-1",
          topicId: "topic-1",
          sessionKey: KEY,
          text: "补测试",
          status: "open",
          statusBy: "auto",
          confidence: 0.9,
          ts: NOW,
          userLocked: false,
        },
      ],
      events: [
        createEvent({
          type: "topic.assigned",
          data: { topicId: "topic-1", sessionKey: KEY },
          device: "laptop",
          ts: NOW,
          seq: 1,
        }),
      ],
    });
    const markdown = `# Session\n${"body ".repeat(100)}`;
    await drive.create({
      path: "inbox/laptop/session.md",
      bytes: Buffer.from(markdown, "utf8"),
      mimeType: "text/markdown",
      appProperties: inboxAppProperties({
        brainhubKey: conversationKey("codex", "conv-1"),
        source: "codex",
        conversationId: "conv-1",
        deviceId: "11111111-1111-4111-8111-111111111111",
        updatedAt: NOW,
        contentSha256: "abc",
      }),
    });
    let fetches = 0;
    const countingFetch = (async (input, init) => {
      fetches += 1;
      return fetch(input, init);
    }) as typeof fetch;
    const deps: HttpDeps = {
      uiPrefs: { read: async () => ({}), patch: async () => ({}) },
      today: async () => ({ date: "2026-07-20", timeZone: "UTC", sessions: [] }),
      topics: async () => ({ topics: [] }),
      topic: async (id) =>
        id === "topic-1"
          ? {
              topicId: id,
              name: "设计",
              aliases: [],
              status: "active",
              statusBy: "auto",
              summary: "",
              nextStep: "",
              lastActive: NOW,
              zone: "active",
              mergedInto: null,
              createdTs: NOW,
              lastUserOpAt: null,
              lastContentAt: null,
              userLocked: false,
              conclusions: [],
              todos: [],
              sessions: [],
            }
          : null,
      todo: async (id) =>
        id === "todo-1"
          ? {
              todoId: id,
              topicId: "topic-1",
              sessionKey: KEY,
              text: "补测试",
              status: "open",
              statusBy: "auto",
              confidence: 0.9,
              ts: NOW,
              userLocked: false,
            }
          : null,
      portrait: async () => null,
      portraitSnapshots: async () => [],
      portraitCorrections: async () => [],
      search: async (query) => ({
        query: query.query,
        indexStatus: "fresh",
        searchMode: "keyword",
        results: [],
        warnings: [],
      }),
      devices: async () => [],
      readRoles: async () => {
        throw new Error("unused");
      },
      writeRoles: async () => undefined,
      readConfig: async () => {
        throw new Error("unused");
      },
      writeConfig: async () => undefined,
      status: async () => {
        throw new Error("unused");
      },
      reminders: async () => ({ reminders: [] }),
      reminder: async () => null,
      reportActivity: async (at) => ({ at }),
      now: () => new Date(NOW),
      sync: async () => ({ started: true, at: NOW }),
      upload: async (input) => ({
        dryRun: input.dryRun ?? false,
        scanned: 3,
        uploaded: input.dryRun ? 0 : 2,
        warnings: [],
      }),
      events: {
        emit(type, data) {
          events.push({ type, data });
        },
      },
    };
    const http = await startDaemonHttp({ dataDir, deps });
    const services = createLocalMcpServices({
      store,
      search: {
        async search(input) {
          return {
            query: input.query,
            indexStatus: "fresh",
            searchMode: "keyword",
            results: [
              {
                score: 1,
                source: "codex",
                conversationId: "conv-1",
                startedAt: NOW,
                updatedAt: NOW,
                excerpt: input.query,
              },
            ],
            warnings: [],
          };
        },
        status: () => ({ ready: true, documents: 4 }),
      },
      drive,
      portraitDir,
      dataDir,
      zone: {
        timeZone: "UTC",
        activeLimit: 10,
        historyDays: 30,
        now: () => new Date(NOW),
      },
      fetch: countingFetch,
    });
    try {
      const today = await call(services, "get_today");
      expect(today.isError).not.toBe(true);
      expect(textOf(today)).toContain("标题");
      expect(fetches).toBe(0);
      const topics = await call(services, "get_topics", { zone: "active" });
      expect(textOf(topics)).toContain("设计");
      const detail = await call(services, "get_topic", { topic_id: "topic-1" });
      expect(textOf(detail)).toContain(KEY);
      const portrait = await call(services, "get_portrait", { variant: "coding" });
      expect(textOf(portrait)).toBe("coding-profile");
      const projectsIndex = await call(services, "get_portrait", { variant: "projects" });
      expect(textOf(projectsIndex)).toContain("# 数字分身 · 项目索引");
      expect(textOf(projectsIndex)).toContain("legal-ai");
      expect(textOf(projectsIndex)).not.toContain("运价缓存五分钟");
      const singleProject = await call(services, "get_portrait", {
        variant: "projects",
        project: "legal-ai",
      });
      expect(textOf(singleProject)).toContain("法务走新审批流。");
      expect(textOf(singleProject)).not.toContain("运价缓存五分钟");
      const defaultTopics = await call(services, "get_topics", {});
      expect(textOf(defaultTopics)).toContain("设计");
      const missingPortrait = await call(services, "get_portrait", { variant: "brief" });
      expect(missingPortrait.isError).toBe(true);
      expect(textOf(missingPortrait)).toContain("SOURCE_UNAVAILABLE");
      const session = await call(services, "get_session", {
        source: "codex",
        conversation_id: "conv-1",
      });
      expect(textOf(session)).toBe(markdown);
      expect(fetches).toBe(0);
      const missingSession = await call(services, "get_session", {
        source: "codex",
        conversation_id: "missing",
      });
      expect(missingSession.isError).toBe(true);
      expect(textOf(missingSession)).toContain("SESSION_NOT_FOUND");
      const found = await call(services, "search_sessions", { query: "同步" });
      expect(found.structuredContent).toMatchObject({ query: "同步" });
      const status = await call(services, "hub_status");
      expect(status.structuredContent).toMatchObject({
        search: { ready: true, documents: 4 },
        topics: 1,
      });
      const updated = await call(services, "update_topic", {
        action: "status",
        topic_id: "topic-1",
        status: "follow_up",
      });
      expect(updated.isError).not.toBe(true);
      expect(events.at(-1)).toEqual({
        type: "topic.status_changed",
        data: { topicId: "topic-1", status: "follow_up", by: "user" },
      });
      const todo = await call(services, "update_topic", {
        action: "todo",
        topic_id: "topic-1",
        todo_id: "todo-1",
        status: "done",
      });
      expect(todo.isError).not.toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: "todo.status_changed",
        data: { status: "done", by: "user" },
      });
      const upload = await call(services, "upload_sessions", {
        dry_run: true,
        sources: ["codex"],
      });
      expect(upload.isError).not.toBe(true);
      expect(textOf(upload)).toContain("扫描 3 个会话，上传 0 个。");
      expect(fetches).toBe(3);
      store.upsertReminder({
        reminderId: "rem-open",
        kind: "stale",
        topicId: "topic-1",
        sessionKey: null,
        text: "该跟进了",
        status: "open",
        until: null,
        issuedAt: NOW,
        updatedAt: NOW,
      });
      store.upsertReminder({
        reminderId: "rem-later",
        kind: "stale",
        topicId: "topic-1",
        sessionKey: null,
        text: "稍后再看",
        status: "snoozed",
        until: "2099-01-01T00:00:00.000Z",
        issuedAt: "2026-07-19T00:00:00.000Z",
        updatedAt: NOW,
      });
      store.upsertReminder({
        reminderId: "rem-closed",
        kind: "morning_digest",
        topicId: null,
        sessionKey: null,
        text: "已读早报",
        status: "dismissed",
        until: null,
        issuedAt: "2026-07-18T00:00:00.000Z",
        updatedAt: NOW,
      });
      const reminders = await call(services, "get_reminders");
      expect(reminders.structuredContent).toEqual({
        reminders: [
          {
            reminderId: "rem-open",
            kind: "stale",
            topicId: "topic-1",
            topicName: "设计",
            sessionKey: null,
            text: "该跟进了",
            status: "open",
            until: null,
            issuedAt: NOW,
          },
        ],
      });
    } finally {
      await http.stop();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns a clear error when the daemon is not running", async () => {
    const dataDir = directory();
    const store = new SqliteStore(join(dataDir, "state.sqlite"));
    const services = createLocalMcpServices({
      store,
      search: {
        search: async (input) => ({
          query: input.query,
          indexStatus: "fresh",
          searchMode: "keyword",
          results: [],
          warnings: [],
        }),
      },
      drive: new MemoryDrive(),
      portraitDir: dataDir,
      dataDir,
      zone: { timeZone: "UTC", activeLimit: 10, historyDays: 30 },
    });
    try {
      const missing = await call(services, "update_topic", {
        action: "status",
        topic_id: "topic-1",
        status: "done",
      });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("DAEMON_NOT_RUNNING");
      expect(textOf(missing)).toContain("daemon.json");

      await writeDaemonEndpoint(dataDir, {
        port: 9,
        token: "token-token-token",
        pid: deadPid(),
      });
      const dead = await call(services, "upload_sessions", { dry_run: true });
      expect(dead.isError).toBe(true);
      expect(textOf(dead)).toContain("进程已退出");

      await writeDaemonEndpoint(dataDir, {
        port: 1,
        token: "token-token-token",
        pid: process.pid,
      });
      const refused = await call(services, "upload_sessions", {});
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("无法连接");
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("search_references and get_reference proxy daemon when running and fall back to offline SQLite + NotionIndex", async () => {
    const dataDir = directory();
    const store = new SqliteStore(join(dataDir, "state.sqlite"));
    const notionIndex = new NotionIndex(join(dataDir, "notion-index.sqlite"));
    notionIndex.upsertPage({
      pageId: "kb-offline-1",
      object: "page",
      parentKind: "workspace",
      parentId: null,
      title: "离线知识库页面",
      icon: null,
      coverUrl: null,
      lastEditedTime: NOW,
      createdAt: NOW,
    });
    notionIndex.replaceBlocks("kb-offline-1", [
      {
        blockId: "b1",
        pageId: "kb-offline-1",
        parentBlockId: null,
        idx: 0,
        model: {
          id: "b1",
          kind: "paragraph",
          segments: [{ text: "这是离线也能读取的知识库正文", href: null, bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }],
          children: [],
        },
      },
    ]);
    notionIndex.close();

    store.replaceDerived({
      topics: [
        {
          topicId: "topic-off",
          name: "离线话题",
          aliases: [],
          status: "active",
          statusBy: "auto",
          summary: "本地话题摘要",
          nextStep: "",
          lastActive: NOW,
          mergedInto: null,
          createdTs: NOW,
          lastUserOpAt: null,
          lastContentAt: null,
          userLocked: false,
        },
      ],
      sessions: [],
      conclusions: [],
      todos: [],
      events: [],
    });

    const services = createLocalMcpServices({
      store,
      search: {
        search: async (input) => ({
          query: input.query,
          indexStatus: "fresh",
          searchMode: "keyword",
          results: [],
          warnings: [],
        }),
      },
      drive: new MemoryDrive(),
      portraitDir: dataDir,
      dataDir,
      zone: { timeZone: "UTC", activeLimit: 10, historyDays: 30 },
    });

    try {
      // Daemon offline -> falls back to local NotionIndex + SQLite topics
      const offlineList = await call(services, "search_references", { query: "" });
      expect(offlineList.isError).not.toBe(true);
      expect(textOf(offlineList)).toContain("离线知识库页面");
      expect(textOf(offlineList)).toContain("离线话题");

      const offlineRead = await call(services, "get_reference", { query: "@知识库:离线知识库页面" });
      expect(offlineRead.isError).not.toBe(true);
      expect(textOf(offlineRead)).toContain("这是离线也能读取的知识库正文");

      // Daemon online -> proxies to daemon HTTP endpoints (including tty7)
      const daemon = await startDaemonHttp({
        dataDir,
        deps: {
          today: async () => ({ date: "2026-07-20", timeZone: "UTC", sessions: [] }),
          search: async (q: { query: string }) => ({ query: q.query, indexStatus: "fresh", searchMode: "keyword", results: [], warnings: [] }),
          topics: async () => ({ topics: [] }),
          topic: async () => null,
          deck: {
            tty7Sessions: async () => ({
              available: true,
              detail: "",
              workspaces: [{ id: "ws", name: "dev", attached: true }],
              sessions: [
                {
                  pane: 88,
                  workspaceId: "ws",
                  workspaceName: "dev",
                  tabId: "tab",
                  tabLabel: "在线终端",
                  agent: "Claude Code",
                  cwd: "/repo",
                  hibernated: false,
                  status: "waiting",
                  statusMessage: null,
                  model: null,
                },
              ],
              harnesses: [],
              appearance: null,
            }),
            tty7Screen: async (pane: number) => ({ pane, text: "live terminal text" }),
          },
        } as unknown as HttpDeps,
      });
      try {
        const onlineList = await call(services, "search_references", { query: "%88", kinds: ["tty7"] });
        expect(onlineList.isError).not.toBe(true);
        expect(textOf(onlineList)).toContain("在线终端 · Claude Code · %88");

        const onlineRead = await call(services, "get_reference", { uri: "%88" });
        expect(onlineRead.isError).not.toBe(true);
        expect(textOf(onlineRead)).toContain("live terminal text");
      } finally {
        await daemon.stop();
      }
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
