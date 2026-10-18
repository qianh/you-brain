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
      const reminders = await call(services, "get_reminders");
      expect(reminders.structuredContent).toEqual({ reminders: [] });
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
});
