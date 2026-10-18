import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";

import { createLocalMcpServices } from "../../src/mcp/local.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import type { Embedder } from "../../src/search/embedder.js";
import { SearchService } from "../../src/search/search-service.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import type { TodayResponse } from "../../src/http/types.js";
import {
  claudeLine,
  fakeBackend,
  makeDaemonDirs,
  testClock,
  writeClaudeSession,
  type DaemonDirs,
} from "../daemon/helpers.js";

const daemons: YouBrainDaemon[] = [];
const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const embedder: Embedder = {
  model: "fake",
  revision: "0",
  dimensions: 8,
  embedQuery() {
    return Promise.reject(new Error("no embedder"));
  },
  embedPassages() {
    return Promise.reject(new Error("no embedder"));
  },
};

describe("two devices", () => {
  it("uploads, refines, syncs, and stays in place when the session grows", async () => {
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const llm = fakeBackend(async (request) =>
      JSON.stringify({
        title: "发布清单",
        summary: request.user.includes("rollback") ? "补充了回滚步骤" : "讨论了分阶段发布",
        topic: { action: "create", topicId: "", name: "发布流程", aliases: [] },
        conclusions_added: [],
        todos_added: [],
        todos_completed: [],
      }),
    );
    const deviceA = await makeDaemonDirs("you-brain-e2e-a-");
    const deviceB = await makeDaemonDirs("you-brain-e2e-b-");
    roots.push(deviceA.root, deviceB.root);
    await writeClaudeSession(deviceA.sourceDir, [
      claudeLine("launch-1", "user", "Plan the launch checklist", "2026-10-18T02:00:00.000Z"),
      claudeLine(
        "launch-1",
        "assistant",
        "Ship behind a flag.",
        "2026-10-18T02:00:00.000Z",
      ),
    ]);

    const daemonA = await startOne(deviceA, "device-a", clock, drive, llm);
    const daemonB = await startOne(deviceB, "device-b", clock, drive, llm);
    await daemonA.settled();
    await daemonB.settled();
    await daemonA.scan();
    await clock.advance(5 * 60_000 + INTERVALS.outputDebounceMs);
    await daemonA.settled();
    await daemonB.settled();

    const inbox = (await drive.list({ prefix: "inbox/" })).filter((file) => file.path.endsWith(".md"));
    expect(inbox).toHaveLength(1);
    const fileId = inbox[0]?.id ?? "";
    expect(fileId).not.toBe("");
    const storeA = openStore(deviceA.dataDir);
    const refined = storeA.listEvents().filter((event) => event.type === "session.refined");
    expect(refined.length).toBeGreaterThan(0);
    const session = storeA.listSessions()[0];
    expect(session?.fileId).toBe(fileId);
    expect(session?.topicId).toBeTruthy();
    expect(session?.summary).toContain("讨论了分阶段发布");
    storeA.close();
    const today = await readFile(join(deviceA.homeDir, "TODAY.md"), "utf8");
    expect(today).toContain("讨论了分阶段发布");
    expect(today).toContain("发布流程");

    const remote = await fetch(`${daemonB.baseUrl}/api/today`, {
      headers: { authorization: `Bearer ${daemonB.token}` },
    });
    expect(remote.status).toBe(200);
    const body = (await remote.json()) as TodayResponse;
    expect(body.sessions.some((item) => item.summary.includes("讨论了分阶段发布"))).toBe(true);
    expect(body.sessions.some((item) => item.topicName === "发布流程")).toBe(true);

    const found = await searchSessions(deviceA, drive);
    expect(found.results.some((hit) => hit.excerpt.toLowerCase().includes("launch"))).toBe(true);

    await writeClaudeSession(deviceA.sourceDir, [
      claudeLine("launch-1", "user", "Plan the launch checklist", "2026-10-18T02:00:00.000Z"),
      claudeLine("launch-1", "assistant", "Ship behind a flag.", "2026-10-18T02:00:00.000Z"),
      claudeLine("launch-1", "user", "Add a rollback step", "2026-10-18T02:10:00.000Z"),
    ]);
    await daemonA.scan();
    await clock.advance(5 * 60_000 + INTERVALS.outputDebounceMs);
    await daemonA.settled();
    await daemonB.settled();

    const again = (await drive.list({ prefix: "inbox/" })).filter((file) => file.path.endsWith(".md"));
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(fileId);
    const after = openStore(deviceA.dataDir);
    const updated = after.listSessions()[0];
    expect(updated?.fileId).toBe(fileId);
    expect(updated?.refinedUpTo).toBe(3);
    expect(updated?.summary).toContain("补充了回滚步骤");
    after.close();
    const foundAgain = await searchSessions(deviceA, drive);
    expect(foundAgain.results.some((hit) => hit.conversationId === "launch-1")).toBe(true);
  });
});

async function startOne(
  dirs: DaemonDirs,
  hostname: string,
  clock: ReturnType<typeof testClock>,
  drive: MemoryDrive,
  llm: ReturnType<typeof fakeBackend>,
): Promise<YouBrainDaemon> {
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname,
    clock,
    drive,
    llm,
    embedder,
    sourceRoots: { "claude-code": [dirs.sourceDir] },
    watch: false,
    signals: false,
  });
  daemons.push(daemon);
  return daemon;
}

function openStore(dataDir: string): SqliteStore {
  const store = new SqliteStore(join(dataDir, "state.sqlite"));
  closers.push(() => store.close());
  return store;
}

async function searchSessions(dirs: DaemonDirs, drive: MemoryDrive) {
  const database = new Database(join(dirs.dataDir, "state.sqlite"));
  database.exec("PRAGMA busy_timeout = 5000");
  closers.push(() => database.close());
  const store = openStore(dirs.dataDir);
  const search = new SearchService({
    drive: {
      changes: (query) => drive.changes(query),
      async read(id: string) {
        const object = await drive.read(id);
        return { bytes: object.bytes };
      },
    },
    embedder,
    database,
  });
  const services = createLocalMcpServices({
    store,
    search,
    drive,
    portraitDir: join(dirs.homeDir, "portrait"),
    dataDir: dirs.dataDir,
    zone: { timeZone: "Asia/Shanghai", activeLimit: 12, historyDays: 14 },
  });
  return services.searchSessions({ query: "launch", limit: 5 });
}
