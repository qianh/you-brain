import { rm } from "node:fs/promises";
import { join } from "node:path";

import { DRIVE_PATHS } from "@you-brain/protocol";
import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { ConsolidateActionResult } from "../../src/http/types.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import {
  CLOCK_START,
  claudeLine,
  fakeBackend,
  makeDaemonDirs,
  readStatus,
  refineJson,
  refineNow,
  testClock,
  throwingEmbedder,
  writeClaudeSession,
  type DaemonDirs,
} from "../daemon/helpers.js";

const SUMMARY = "沉淀后的新概要";
const NEXT = "继续写测试";

const daemons: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("consolidation across two devices", () => {
  it(
    "lets the main device rewrite today's topic once, and the other device sees it after sync",
    async () => {
      const clock = testClock();
      const drive = new MemoryDrive({ now: () => clock.now() });
      let summaryCalls = 0;
      const llm = fakeBackend(async (request) => {
        if (request.system.includes("话题概要")) {
          summaryCalls += 1;
          return JSON.stringify({ summary: SUMMARY, nextStep: NEXT });
        }
        if (request.system.includes("合并建议")) return JSON.stringify({ pairs: [] });
        return refineJson("讨论了分阶段发布");
      });
      const dirsA = await trackDirs("a");
      const dirsB = await trackDirs("b");
      await writeClaudeSession(dirsA.sourceDir, [
        claudeLine("shared-1", "user", "Plan the launch checklist", CLOCK_START.toISOString()),
        claudeLine("shared-1", "assistant", "先列一个清单。", CLOCK_START.toISOString()),
      ]);

      const daemonA = await startOne(dirsA, "device-a", clock, drive, llm);
      const daemonB = await startOne(dirsB, "device-b", clock, drive, llm);
      const idA = (await readStatus(daemonA)).deviceId;
      const idB = (await readStatus(daemonB)).deviceId;
      expect(idA).not.toBe(idB);

      expect(
        (
          await putJson(daemonA, "/api/roles", {
            mainDevice: idA,
            consolidation: { enabled: true, time: "23:00" },
          })
        ).status,
      ).toBe(200);
      expect((await postJson<{ started: boolean }>(daemonB, "/api/actions/sync", {})).started).toBe(
        true,
      );
      const rolesB = await getJson<{
        mainDevice: string | null;
        consolidation: { enabled: boolean };
      }>(daemonB, "/api/roles");
      expect(rolesB).toMatchObject({ mainDevice: idA, consolidation: { enabled: true } });

      const uploaded = await postJson<{ uploaded: number }>(daemonA, "/api/actions/upload", {
        backfill: true,
      });
      expect(uploaded.uploaded).toBeGreaterThan(0);
      // Uploading is a sync step; the topic appears once the refine pass has run.
      await refineNow(clock, daemonA);
      expect(summaryCalls).toBe(0);
      const before = await topicSummary(daemonA);
      expect(before.name).toBe("发布流程");
      expect(before.summary).toBe("");

      await clock.advance(2_000);
      await daemonA.settled();
      await daemonB.settled();
      expect(summaryCalls).toBe(0);
      expect(await leaseDate(drive)).toBeNull();

      expect((await putJson(daemonA, "/api/roles", { consolidation: { time: "03:00" } })).status).toBe(
        200,
      );
      await clock.advance(INTERVALS.consolidationMs);
      await daemonA.settled();
      await daemonB.settled();

      expect(summaryCalls).toBe(1);
      expect(await leaseDate(drive)).toBe("2026-10-18");
      const finished = (await readStatus(daemonA)).consolidation.lastFinishedAt;
      expect(finished).toBeTruthy();
      expect((await readStatus(daemonB)).consolidation.lastFinishedAt).toBe(finished);
      expect((await topicSummary(daemonA)).summary).toBe(SUMMARY);
      expect((await topicSummary(daemonB)).summary).not.toBe(SUMMARY);

      await clock.advance(INTERVALS.flushMs);
      await daemonA.settled();
      expect((await postJson<{ started: boolean }>(daemonB, "/api/actions/sync", {})).started).toBe(
        true,
      );
      expect(await topicSummary(daemonB)).toMatchObject({ summary: SUMMARY, nextStep: NEXT });
      expect(summaryEvents(dirsA)).toEqual([
        { summary: SUMMARY, nextStep: NEXT },
      ]);

      const callsAfterSync = summaryCalls;
      await clock.advance(INTERVALS.consolidationMs);
      await daemonA.settled();
      await daemonB.settled();
      expect(summaryCalls).toBe(callsAfterSync);

      const forced = await postJson<ConsolidateActionResult>(daemonA, "/api/actions/consolidate", {
        force: true,
      });
      expect(forced.ok).toBe(true);
      expect(forced.steps.map((step) => step.id)).toEqual([
        "topic_summaries",
        "merge_suggestions",
        "portrait",
        "portrait_eval",
        "topic_files",
      ]);
      expect(summaryCalls).toBe(callsAfterSync);
      expect(summaryEvents(dirsA)).toHaveLength(1);
      expect((await readStatus(daemonA)).consolidation.lastFinishedAt).not.toBe(finished);
    },
    180_000,
  );
});

function summaryEvents(dirs: DaemonDirs): Array<{ summary: string; nextStep: string }> {
  const store = new SqliteStore(join(dirs.dataDir, "state.sqlite"));
  try {
    return store
      .listEvents()
      .filter((event) => event.type === "topic.summary_rewritten")
      .map((event) => {
        if (event.type !== "topic.summary_rewritten") return { summary: "", nextStep: "" };
        expect("by" in event.data).toBe(false);
        return { summary: event.data.summary, nextStep: event.data.nextStep };
      });
  } finally {
    store.close();
  }
}

async function topicSummary(
  daemon: YouBrainDaemon,
): Promise<{ name: string; summary: string; nextStep: string }> {
  const body = await getJson<{ topics: Array<{ name: string; summary: string; nextStep: string }> }>(
    daemon,
    "/api/topics",
  );
  const topic = body.topics.find((item) => item.name === "发布流程");
  if (!topic) throw new Error("发布流程不在话题册里");
  return topic;
}

async function leaseDate(drive: MemoryDrive): Promise<string | null> {
  const object = await drive.readPath(DRIVE_PATHS.consolidateLease);
  if (!object) return null;
  const parsed = JSON.parse(object.bytes.toString("utf8")) as { date?: string };
  return parsed.date ?? null;
}

async function trackDirs(name: string): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs(`you-brain-consolidate-${name}-`);
  roots.push(dirs.root);
  return dirs;
}

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
    embedder: throwingEmbedder,
    sourceRoots: { "claude-code": [dirs.sourceDir] },
    watch: false,
    signals: false,
  });
  daemons.push(daemon);
  await daemon.settled();
  return daemon;
}

async function getJson<T>(daemon: YouBrainDaemon, path: string): Promise<T> {
  const response = await send(daemon, path);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function postJson<T>(daemon: YouBrainDaemon, path: string, body: unknown): Promise<T> {
  const response = await send(daemon, path, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function putJson(daemon: YouBrainDaemon, path: string, body: unknown): Promise<Response> {
  return send(daemon, path, { method: "PUT", body: JSON.stringify(body) });
}

async function send(daemon: YouBrainDaemon, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${daemon.token}`);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${daemon.baseUrl}${path}`, { ...init, headers });
}
