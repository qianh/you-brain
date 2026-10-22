import { rm } from "node:fs/promises";
import { join } from "node:path";

import { conversationKey } from "@you-brain/protocol";
import { describe, expect, test } from "bun:test";

import { ManualDaemonClock } from "../../src/daemon/clock.js";
import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { TopicsResponse } from "../../src/http/types.js";
import type { LlmBackend } from "../../src/llm/types.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import {
  CLOCK_START,
  fakeBackend,
  makeDaemonDirs,
  readStatus,
  refineJson,
  throwingEmbedder,
  type DaemonDirs,
} from "../daemon/helpers.js";

const SOURCE = "chatgpt-web";

interface Box {
  daemons: YouBrainDaemon[];
  roots: string[];
}

describe("web session processor", () => {
  test(
    "waits out the idle window, then only the processor refines",
    async () => {
      await using(async (box) => {
        const clock = new ManualDaemonClock(CLOCK_START);
        const drive = new MemoryDrive({ now: () => clock.now() });
        const promptsA: string[] = [];
        const promptsB: string[] = [];
        const deviceA = await startDevice(box, clock, drive, "device-a", recordingBackend(promptsA, "网页里的发布步骤"));
        const deviceB = await startDevice(box, clock, drive, "device-b", recordingBackend(promptsB, "设备 B 不该写这个"));
        await assignMain(deviceA.daemon);
        await putMarkdown(
          drive,
          "inbox/web-chrome/launch.md",
          sessionMarkdown({
            conversationId: "web-launch",
            updatedAt: CLOCK_START.toISOString(),
            turnCount: 2,
            body: "## User\nplan the web launch\n\n## Assistant\nship it\n",
          }),
        );
        await putMarkdown(
          drive,
          "inbox/laptop/cli.md",
          sessionMarkdown({
            conversationId: "cli-local",
            source: "claude-code",
            updatedAt: CLOCK_START.toISOString(),
            turnCount: 2,
            body: "## User\nlocal cli only\n\n## Assistant\nstay local\n",
          }),
        );

        await clock.advance(4 * 60_000);
        const earlyA = await readStatus(deviceA.daemon);
        const earlyB = await readStatus(deviceB.daemon);
        expect(promptsA).toHaveLength(0);
        expect(promptsB).toHaveLength(0);
        expect(refinedCount(deviceA.dirs)).toBe(0);
        expect(earlyA.web.isLocalProcessor).toBe(true);
        expect(earlyA.web.pending).toBe(1);
        expect(earlyA.web.processor).toBe(earlyA.deviceId);
        expect(earlyB.web.isLocalProcessor).toBe(false);
        expect(earlyB.web.pending).toBe(0);
        expect(earlyB.web.processor).toBe(earlyA.deviceId);
        expect(webPaths(deviceA.dirs)).toEqual(["inbox/web-chrome/launch.md"]);
        expect(webPaths(deviceB.dirs)).toEqual(["inbox/web-chrome/launch.md"]);

        await clock.advance(60_000);
        expect(promptsA).toHaveLength(1);
        expect(promptsA.join("\n")).toContain("plan the web launch");
        expect(promptsB).toHaveLength(0);
        expect(refinedCount(deviceA.dirs)).toBe(1);
        expect((await readStatus(deviceA.daemon)).web.pending).toBe(0);
        expect(sessionRow(deviceA.dirs, "web-launch")?.refinedUpTo).toBe(2);
        expect(sessionRow(deviceA.dirs, "cli-local", "claude-code")?.refinedUpTo).toBe(0);

        // The refine event is flushed on the next 30s boundary and pulled on the next minute.
        await clock.advance(60_000);
        expect(promptsB).toHaveLength(0);
        expect(refinedCount(deviceB.dirs)).toBe(1);
        expect(await topicNames(deviceA.daemon)).toContain("发布流程");
        expect(await topicNames(deviceB.daemon)).toContain("发布流程");
        expect(sessionRow(deviceB.dirs, "web-launch")?.summary).toContain("网页里的发布步骤");
      });
    },
    { timeout: 120_000 },
  );

  test(
    "the new processor refines only what the previous one left",
    async () => {
      await using(async (box) => {
        const clock = new ManualDaemonClock(CLOCK_START);
        const drive = new MemoryDrive({ now: () => clock.now() });
        const promptsA: string[] = [];
        const promptsB: string[] = [];
        const deviceA = await startDevice(box, clock, drive, "device-a", recordingBackend(promptsA, "已提炼旧内容"));
        const deviceB = await startDevice(box, clock, drive, "device-b", recordingBackend(promptsB, "只补了新增"));
        await assignMain(deviceA.daemon);
        const grown = await putMarkdown(
          drive,
          "inbox/web-chrome/grown.md",
          sessionMarkdown({
            conversationId: "grown",
            updatedAt: ago(10),
            turnCount: 1,
            body: "## User\nALPHA_OLD\n",
          }),
        );
        await putMarkdown(
          drive,
          "inbox/web-chrome/kept.md",
          sessionMarkdown({
            conversationId: "kept",
            updatedAt: ago(11),
            turnCount: 2,
            body: "## User\nKEPT_TOKEN\n\n## Assistant\ndone already\n",
          }),
        );

        await clock.advance(2 * 60_000);
        expect(promptsA).toHaveLength(2);
        expect(promptsB).toHaveLength(0);
        expect(sessionRow(deviceB.dirs, "grown")?.refinedUpTo).toBe(1);
        expect(sessionRow(deviceB.dirs, "kept")?.refinedUpTo).toBe(2);

        const statusB = await readStatus(deviceB.daemon);
        await putRoles(deviceA.daemon, { webProcessor: statusB.deviceId });
        await syncNow(deviceB.daemon);
        expect((await readStatus(deviceA.daemon)).web.isLocalProcessor).toBe(false);
        expect((await readStatus(deviceB.daemon)).web.isLocalProcessor).toBe(true);

        await drive.update(
          grown.id,
          sessionMarkdown({
            conversationId: "grown",
            updatedAt: ago(10),
            turnCount: 2,
            body: "## User\nALPHA_OLD\n\n## Assistant\nBETA_NEW\n",
          }),
        );
        await putMarkdown(
          drive,
          "inbox/web-chrome/fresh.md",
          sessionMarkdown({
            conversationId: "fresh",
            updatedAt: ago(9),
            turnCount: 1,
            body: "## User\nFRESH_ONLY\n",
          }),
        );
        await clock.advance(2 * 60_000);

        expect(promptsA).toHaveLength(2);
        expect(promptsB).toHaveLength(2);
        const increment = promptsB.find((prompt) => prompt.includes("BETA_NEW"));
        expect(increment).toBeTruthy();
        expect(increment ?? "").not.toContain("ALPHA_OLD");
        expect(promptsB.some((prompt) => prompt.includes("FRESH_ONLY"))).toBe(true);
        expect(promptsB.some((prompt) => prompt.includes("KEPT_TOKEN"))).toBe(false);
        expect(sessionRow(deviceA.dirs, "kept")?.refinedUpTo).toBe(2);
        expect(sessionRow(deviceB.dirs, "kept")?.refinedUpTo).toBe(2);
        expect(sessionRow(deviceA.dirs, "grown")?.refinedUpTo).toBe(2);
        expect(sessionRow(deviceB.dirs, "grown")?.refinedUpTo).toBe(2);
        expect(sessionRow(deviceA.dirs, "fresh")?.refinedUpTo).toBe(1);
        expect(sessionRow(deviceB.dirs, "fresh")?.refinedUpTo).toBe(1);
        expect(await topicNames(deviceA.daemon)).toContain("发布流程");
        expect(await topicNames(deviceB.daemon)).toContain("发布流程");
      });
    },
    { timeout: 120_000 },
  );

  test(
    "a restart before the idle point still refines from the local index",
    async () => {
      await using(async (box) => {
        const clock = new ManualDaemonClock(CLOCK_START);
        const drive = new MemoryDrive({ now: () => clock.now() });
        const prompts: string[] = [];
        const first = await startDevice(box, clock, drive, "device-a", recordingBackend(prompts, "重启后提炼"));
        await assignMain(first.daemon);
        await putMarkdown(
          drive,
          "inbox/web-chrome/later.md",
          sessionMarkdown({
            conversationId: "later",
            updatedAt: CLOCK_START.toISOString(),
            turnCount: 1,
            body: "## User\nstill waiting\n",
          }),
        );
        await clock.advance(2 * 60_000);
        expect(prompts).toHaveLength(0);
        expect((await readStatus(first.daemon)).web.pending).toBe(1);
        expect(webPaths(first.dirs)).toEqual(["inbox/web-chrome/later.md"]);
        await first.daemon.stop();

        const second = await startDevice(box, clock, drive, "device-a", recordingBackend(prompts, "重启后提炼"), first.dirs);
        expect((await readStatus(second.daemon)).web.isLocalProcessor).toBe(true);
        expect((await readStatus(second.daemon)).web.pending).toBe(1);
        await clock.advance(2 * 60_000);
        expect(prompts).toHaveLength(0);
        expect(refinedCount(first.dirs)).toBe(0);
        await clock.advance(60_000);
        expect(prompts).toHaveLength(1);
        expect(prompts.join("\n")).toContain("still waiting");
        expect(sessionRow(first.dirs, "later")?.refinedUpTo).toBe(1);
        expect((await readStatus(second.daemon)).web.pending).toBe(0);
      });
    },
    { timeout: 120_000 },
  );

  test(
    "a model error waits out its backoff and then succeeds",
    async () => {
      await using(async (box) => {
        const clock = new ManualDaemonClock(CLOCK_START);
        const drive = new MemoryDrive({ now: () => clock.now() });
        const prompts: string[] = [];
        let fail = true;
        const device = await startDevice(
          box,
          clock,
          drive,
          "device-a",
          fakeBackend(async (request) => {
            prompts.push(request.user);
            if (fail) throw new Error("model down");
            return refineJson("重试成功");
          }),
        );
        await assignMain(device.daemon);
        await putMarkdown(
          drive,
          "inbox/web-chrome/flaky.md",
          sessionMarkdown({
            conversationId: "flaky",
            updatedAt: ago(10),
            turnCount: 1,
            body: "## User\ntry again\n",
          }),
        );

        await clock.advance(60_000);
        expect(prompts).toHaveLength(1);
        expect(refinedCount(device.dirs)).toBe(0);
        const failed = await readStatus(device.daemon);
        expect(failed.refine.pending).toBe(1);
        expect(failed.refine.lastError).toContain("model down");
        expect(failed.web.pending).toBe(1);
        await clock.advance(500);
        expect(prompts).toHaveLength(1);
        expect(refinedCount(device.dirs)).toBe(0);

        fail = false;
        await clock.advance(60_000);
        expect(prompts).toHaveLength(2);
        expect(refinedCount(device.dirs)).toBe(1);
        const recovered = await readStatus(device.daemon);
        expect(recovered.refine.pending).toBe(0);
        expect(recovered.web.pending).toBe(0);
        expect(sessionRow(device.dirs, "flaky")?.summary).toContain("重试成功");
      });
    },
    { timeout: 120_000 },
  );

  test(
    "a web file without turn_count is counted from its body and refined",
    async () => {
      await using(async (box) => {
        const clock = new ManualDaemonClock(new Date(CLOCK_START.getTime() - 10 * 60_000));
        const drive = new MemoryDrive({ now: () => clock.now() });
        const markdown = sessionMarkdown({
          conversationId: "no-count",
          updatedAt: ago(20),
          turnCount: 0,
          body: "## User\nNO_COUNT_TOKEN\n\n## Assistant\nok\n",
        })
          .split("\n")
          .filter((line) => !line.startsWith("turn_count:"))
          .join("\n");
        await putMarkdown(drive, "inbox/web-chrome/no-count.md", markdown);
        await clock.advance(10 * 60_000);
        const prompts: string[] = [];
        const device = await startDevice(box, clock, drive, "device-a", recordingBackend(prompts, "没有计数也提炼"));
        await assignMain(device.daemon);
        await clock.advance(2 * 60_000);
        expect(sessionRow(device.dirs, "no-count")?.msgCount).toBe(2);
        expect(prompts.join("\n")).toContain("NO_COUNT_TOKEN");
        expect(sessionRow(device.dirs, "no-count")?.refinedUpTo).toBe(2);
      });
    },
    { timeout: 120_000 },
  );

  test(
    "a file that cannot be parsed is not read again on later rounds",
    async () => {
      await using(async (box) => {
        const clock = new ManualDaemonClock(new Date(CLOCK_START.getTime() - 10 * 60_000));
        const drive = new MemoryDrive({ now: () => clock.now() });
        const broken = await putMarkdown(
          drive,
          "inbox/web-chrome/broken.md",
          [
            "---",
            "source: chatgpt-web",
            "conversation_id: broken",
            "device: chrome",
            `started_at: ${ago(20)}`,
            "turn_count: 1",
            "---",
            "## User",
            "missing updated_at",
            "",
          ].join("\n"),
        );
        await clock.advance(10 * 60_000);
        const reads = watchReads(drive);
        const prompts: string[] = [];
        const device = await startDevice(box, clock, drive, "device-a", recordingBackend(prompts, "不该调用"));
        await assignMain(device.daemon);

        await clock.advance(60_000);
        const firstReads = reads.get(broken.id) ?? 0;
        expect(firstReads).toBeGreaterThan(0);
        expect(prompts).toHaveLength(0);
        expect(refinedCount(device.dirs)).toBe(0);
        const status = await readStatus(device.daemon);
        expect(status.refine.lastError).toContain("网页会话无法解析");
        expect(status.web.pending).toBe(1);

        await clock.advance(3 * 60_000);
        expect(reads.get(broken.id)).toBe(firstReads);
        expect(prompts).toHaveLength(0);
        expect(refinedCount(device.dirs)).toBe(0);
      });
    },
    { timeout: 120_000 },
  );

  test("no model, a closed drive, or a missing processor does no work", async () => {
    await using(async (box) => {
      const idle = sessionMarkdown({
        conversationId: "idle-web",
        updatedAt: ago(10),
        turnCount: 1,
        body: "## User\nshould wait\n",
      });

      const noModelClock = new ManualDaemonClock(CLOCK_START);
      const noModelDrive = new MemoryDrive({ now: () => noModelClock.now() });
      const noModel = await startDevice(box, noModelClock, noModelDrive, "device-a", null);
      await assignMain(noModel.daemon);
      await putMarkdown(noModelDrive, "inbox/web-chrome/idle.md", idle);
      await noModelClock.advance(60_000);
      const noModelStatus = await readStatus(noModel.daemon);
      expect(refinedCount(noModel.dirs)).toBe(0);
      expect(noModelStatus.web.isLocalProcessor).toBe(true);
      expect(noModelStatus.web.pending).toBe(1);
      expect(noModelStatus.warnings.some((warning) => warning.code === "WEB_PROCESSOR_MISSING")).toBe(false);

      const closedClock = new ManualDaemonClock(CLOCK_START);
      const closedPrompts: string[] = [];
      const closed = await startDevice(
        box,
        closedClock,
        null,
        "device-b",
        recordingBackend(closedPrompts, "不该调用"),
      );
      await closedClock.advance(60_000);
      const closedStatus = await readStatus(closed.daemon);
      expect(closedPrompts).toHaveLength(0);
      expect(closedStatus.web.processor).toBeNull();
      expect(closedStatus.web.pending).toBe(0);
      expect(closedStatus.warnings.some((warning) => warning.code === "WEB_PROCESSOR_MISSING")).toBe(false);

      const openClock = new ManualDaemonClock(CLOCK_START);
      const openDrive = new MemoryDrive({ now: () => openClock.now() });
      const openPrompts: string[] = [];
      const open = await startDevice(box, openClock, openDrive, "device-c", recordingBackend(openPrompts, "不该调用"));
      await putMarkdown(openDrive, "inbox/web-chrome/idle.md", idle);
      await openClock.advance(60_000);
      const missing = await readStatus(open.daemon);
      expect(openPrompts).toHaveLength(0);
      expect(refinedCount(open.dirs)).toBe(0);
      expect(missing.web.processor).toBeNull();
      expect(missing.web.isLocalProcessor).toBe(false);
      expect(missing.web.pending).toBe(0);
      expect(missing.warnings).toContainEqual({
        code: "WEB_PROCESSOR_MISSING",
        message: "没有指定网页会话处理设备",
      });
    });
  }, { timeout: 120_000 });

  test(
    "pending on the processor drops as a batch finishes, and a short body is aligned",
    async () => {
      await using(async (box) => {
        const clock = new ManualDaemonClock(CLOCK_START);
        const drive = new MemoryDrive({ now: () => clock.now() });
        const prompts: string[] = [];
        const device = await startDevice(box, clock, drive, "device-a", recordingBackend(prompts, "批量摘要"));
        await assignMain(device.daemon);
        const markers = [
          { id: "m1", age: 40, text: "MARKER_ONE" },
          { id: "m2", age: 30, text: "MARKER_TWO" },
          { id: "m3", age: 20, text: "MARKER_THREE" },
          { id: "m4", age: 10, text: "MARKER_FOUR" },
        ];
        for (const marker of markers) {
          await putMarkdown(
            drive,
            `inbox/web-chrome/${marker.id}.md`,
            sessionMarkdown({
              conversationId: marker.id,
              updatedAt: ago(marker.age),
              turnCount: 1,
              body: `## User\n${marker.text}\n`,
            }),
          );
        }
        await putMarkdown(
          drive,
          "inbox/web-chrome/short.md",
          sessionMarkdown({
            conversationId: "short",
            updatedAt: ago(5),
            turnCount: 5,
            body: "## User\nONLY_ONE\n",
          }),
        );

        await clock.advance(60_000);
        expect(prompts).toHaveLength(3);
        expect(prompts.join("\n")).toContain("MARKER_ONE");
        expect(prompts.join("\n")).toContain("MARKER_TWO");
        expect(prompts.join("\n")).toContain("MARKER_THREE");
        expect(prompts.join("\n")).not.toContain("MARKER_FOUR");
        expect(prompts.join("\n")).not.toContain("ONLY_ONE");
        expect((await readStatus(device.daemon)).web.pending).toBe(2);

        await clock.advance(60_000);
        expect(prompts).toHaveLength(5);
        expect(prompts.join("\n")).toContain("MARKER_FOUR");
        expect(prompts.join("\n")).toContain("ONLY_ONE");
        expect(sessionRow(device.dirs, "short")?.refinedUpTo).toBe(1);
        expect(sessionRow(device.dirs, "short")?.msgCount).toBe(5);
        expect((await readStatus(device.daemon)).web.pending).toBe(1);

        await clock.advance(60_000);
        expect(prompts).toHaveLength(5);
        expect(sessionRow(device.dirs, "short")?.msgCount).toBe(1);
        expect(sessionRow(device.dirs, "short")?.refinedUpTo).toBe(1);
        expect((await readStatus(device.daemon)).web.pending).toBe(0);
        for (const marker of markers) {
          expect(sessionRow(device.dirs, marker.id)?.refinedUpTo).toBe(1);
        }
      });
    },
    { timeout: 120_000 },
  );
});

async function using(fn: (box: Box) => Promise<void>): Promise<void> {
  const box: Box = { daemons: [], roots: [] };
  try {
    await fn(box);
  } finally {
    await Promise.all(box.daemons.map((daemon) => daemon.stop()));
    await Promise.all(box.roots.map((root) => rm(root, { recursive: true, force: true })));
  }
}

async function startDevice(
  box: Box,
  clock: ManualDaemonClock,
  drive: MemoryDrive | null,
  hostname: string,
  llm: LlmBackend | null,
  existing?: DaemonDirs,
): Promise<{ daemon: YouBrainDaemon; dirs: DaemonDirs }> {
  const dirs = existing ?? (await makeDaemonDirs(`you-brain-web-${hostname}-`));
  if (!existing) box.roots.push(dirs.root);
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname,
    clock,
    drive,
    llm,
    embedder: throwingEmbedder,
    sourceRoots: {},
    watch: false,
    signals: false,
  });
  box.daemons.push(daemon);
  await daemon.settled();
  return { daemon, dirs };
}

function recordingBackend(prompts: string[], summary: string): LlmBackend {
  return fakeBackend(async (request) => {
    prompts.push(request.user);
    return refineJson(summary);
  });
}

function ago(minutes: number): string {
  return new Date(CLOCK_START.getTime() - minutes * 60_000).toISOString();
}

function sessionMarkdown(input: {
  conversationId: string;
  body: string;
  updatedAt: string;
  turnCount: number;
  source?: string;
}): string {
  return [
    "---",
    "content_sha256: abc",
    `source: ${input.source ?? SOURCE}`,
    `conversation_id: ${input.conversationId}`,
    "device: chrome",
    `started_at: ${input.updatedAt}`,
    `updated_at: ${input.updatedAt}`,
    `turn_count: ${input.turnCount}`,
    "---",
    input.body.trimEnd(),
    "",
  ].join("\n");
}

function putMarkdown(drive: MemoryDrive, path: string, markdown: string) {
  return drive.put({ path, bytes: Buffer.from(markdown), mimeType: "text/markdown" });
}

async function putRoles(
  daemon: YouBrainDaemon,
  patch: { mainDevice?: string | null; webProcessor?: string | null },
): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/api/roles`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await response.text());
}

async function assignMain(daemon: YouBrainDaemon): Promise<void> {
  const status = await readStatus(daemon);
  await putRoles(daemon, { mainDevice: status.deviceId });
}

async function syncNow(daemon: YouBrainDaemon): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/api/actions/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (!response.ok) throw new Error(await response.text());
}

async function topicNames(daemon: YouBrainDaemon): Promise<string[]> {
  const response = await fetch(`${daemon.baseUrl}/api/topics`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (!response.ok) throw new Error(await response.text());
  const body = (await response.json()) as TopicsResponse;
  return body.topics.map((topic) => topic.name);
}

function withStore<T>(dirs: DaemonDirs, read: (store: SqliteStore) => T): T {
  const store = new SqliteStore(join(dirs.dataDir, "state.sqlite"));
  try {
    return read(store);
  } finally {
    store.close();
  }
}

function refinedCount(dirs: DaemonDirs): number {
  return withStore(dirs, (store) => store.listEvents().filter((event) => event.type === "session.refined").length);
}

function sessionRow(dirs: DaemonDirs, conversationId: string, source = SOURCE) {
  return withStore(dirs, (store) => store.getSession(conversationKey(source, conversationId)));
}

function webPaths(dirs: DaemonDirs): string[] {
  return withStore(dirs, (store) =>
    store.listCursors("webinbox:").flatMap((row) => {
      const parsed = JSON.parse(row.value) as { path?: unknown };
      return typeof parsed.path === "string" ? [parsed.path] : [];
    }),
  );
}

function watchReads(drive: MemoryDrive): Map<string, number> {
  const reads = new Map<string, number>();
  const original = drive.read.bind(drive);
  drive.read = (id: string) => {
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return original(id);
  };
  return reads;
}
