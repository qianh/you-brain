import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { createStoreReaders } from "../../src/http/queries.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import type { DerivedSnapshot } from "../../src/store/types.js";
import { makeDaemonDirs, type DaemonDirs } from "./helpers.js";

const roots: string[] = [];
const daemons: YouBrainDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon readers", () => {
  it("lists sessions newest first and counts the outbox", () => {
    const store = new SqliteStore(":memory:");
    store.upsertSession(session("a".repeat(64), "2026-10-18T02:00:00.000Z"));
    store.upsertSession(session("b".repeat(64), "2026-10-18T03:00:00.000Z"));
    store.upsertSession(session("c".repeat(64), "2026-10-18T01:00:00.000Z", "topic-old"));
    const listed = store.listSessions();
    expect(listed.map((row) => row.sessionKey.slice(0, 1))).toEqual(["b", "a", "c"]);
    expect(store.listSessions({ limit: 1 })).toHaveLength(1);
    expect(store.listSessions({ topicId: "topic-old" }).map((row) => row.sessionKey)).toEqual([
      "c".repeat(64),
    ]);
    expect(store.countOutbox()).toBe(0);
    store.enqueueOutbox({ id: "out-1", kind: "event", payload: { ok: true } });
    expect(store.countOutbox()).toBe(1);
    expect(store.ackOutbox(["out-1"])).toBe(1);
    expect(store.countOutbox()).toBe(0);
    store.close();
  });

  it("shows a session that exists only in the sessions table on its topic", async () => {
    const store = new SqliteStore(":memory:");
    const topicId = "topic-table-only";
    const snapshot: DerivedSnapshot = {
      events: [],
      topics: [
        {
          topicId,
          name: "只有表",
          aliases: [],
          status: "active",
          statusBy: "auto",
          summary: "",
          nextStep: "",
          lastActive: "2026-10-18T02:00:00.000Z",
          mergedInto: null,
          createdTs: "2026-10-18T02:00:00.000Z",
          lastUserOpAt: null,
          userLocked: false,
        },
      ],
      sessions: [],
      conclusions: [],
      todos: [],
    };
    store.replaceDerived(snapshot);
    const sessionKey = "d".repeat(64);
    store.upsertSession({
      ...session(sessionKey, "2026-10-18T02:05:00.000Z", topicId),
      title: "表内会话",
    });
    const readers = createStoreReaders(store, {
      timeZone: "Asia/Shanghai",
      activeLimit: 12,
      historyDays: 14,
      now: () => new Date("2026-10-18T02:10:00.000Z"),
    });
    const detail = await readers.topic(topicId);
    expect(detail?.sessions.map((item) => item.sessionKey)).toEqual([sessionKey]);
    expect(detail?.sessions[0]?.title).toBe("表内会话");
    store.close();
  });

  it("injects the loopback token into index routes", async () => {
    const dirs = await trackDirs();
    const staticDir = join(dirs.root, "ui");
    await mkdir(staticDir, { recursive: true });
    await writeFile(
      join(staticDir, "index.html"),
      "<html><head><title>you-brain</title></head><body>app</body></html>",
    );
    const daemon = await startDaemon({
      homeDir: dirs.homeDir,
      platform: "darwin",
      env: dirs.env,
      hostname: "device-a",
      drive: null,
      llm: null,
      sourceRoots: {},
      staticDir,
      watch: false,
      signals: false,
    });
    daemons.push(daemon);
    const script = `<script>window.__YOU_BRAIN__=${JSON.stringify({ token: daemon.token })}</script>`;
    for (const path of ["/", "/panel"]) {
      const response = await fetch(`${daemon.baseUrl}${path}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(script);
      expect(html).toContain("app");
      expect(html.indexOf(script)).toBeLessThan(html.indexOf("</head>"));
    }
  });
});

function session(sessionKey: string, updatedAt: string, topicId?: string) {
  return {
    sessionKey,
    source: "claude-code",
    device: "device-a",
    startedAt: "2026-10-18T01:00:00.000Z",
    updatedAt,
    msgCount: 1,
    ...(topicId ? { topicId } : {}),
  };
}

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-readers-");
  roots.push(dirs.root);
  return dirs;
}
