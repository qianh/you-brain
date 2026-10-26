import { rm } from "node:fs/promises";

import { DRIVE_PATHS } from "@you-brain/protocol";
import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { ConsolidateActionResult } from "../../src/http/types.js";
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

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("topic files daemon", () => {
  it("writes nothing until this device is main, consolidation is on, and Drive is open", async () => {
    expect(INTERVALS.topicFilesDebounceMs).toBe(5 * 60_000);
    const dirs = await trackDirs();
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("topic-files", "user", "Plan the launch checklist", CLOCK_START.toISOString()),
      claudeLine("topic-files", "assistant", "先列一个清单。", CLOCK_START.toISOString()),
    ]);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const daemon = await startTracked(dirs, clock, drive);
    const uploaded = await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", {
      backfill: true,
    });
    expect(uploaded.uploaded).toBeGreaterThan(0);

    await clock.advance(INTERVALS.topicFilesDebounceMs + 1_000);
    await daemon.settled();
    expect(await drive.list({ prefix: "topics/" })).toEqual([]);

    const id = (await readStatus(daemon)).deviceId;
    expect((await putRoles(daemon, { mainDevice: id })).status).toBe(200);
    const topicId = await onlyTopicId(daemon);
    expect((await rename(daemon, topicId, "还没开沉淀")).status).toBe(200);
    await clock.advance(INTERVALS.topicFilesDebounceMs + 1_000);
    await daemon.settled();
    expect(await drive.list({ prefix: "topics/" })).toEqual([]);

    expect(
      (await putRoles(daemon, { consolidation: { enabled: true, time: "23:00" } })).status,
    ).toBe(200);
    await clock.advance(60_000);
    await daemon.settled();
    expect(await drive.findByPath(DRIVE_PATHS.topicsLatest)).toBeNull();
  }, 30_000);

  it("writes five minutes after the topic book stops changing", async () => {
    const dirs = await trackDirs();
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("topic-files-quiet", "user", "Plan the launch checklist", CLOCK_START.toISOString()),
      claudeLine("topic-files-quiet", "assistant", "先列一个清单。", CLOCK_START.toISOString()),
    ]);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const daemon = await startTracked(dirs, clock, drive);
    const deviceId = (await readStatus(daemon)).deviceId;
    expect(
      (
        await putRoles(daemon, {
          mainDevice: deviceId,
          consolidation: { enabled: true, time: "23:00" },
        })
      ).status,
    ).toBe(200);
    const uploaded = await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", {
      backfill: true,
    });
    expect(uploaded.uploaded).toBeGreaterThan(0);
    await refineNow(clock, daemon);
    const topicId = await onlyTopicId(daemon);
    expect((await rename(daemon, topicId, "防抖之后")).status).toBe(200);
    expect(await drive.findByPath(DRIVE_PATHS.topicsLatest)).toBeNull();

    await clock.advance(INTERVALS.topicFilesDebounceMs - 60_000);
    await daemon.settled();
    expect(await drive.findByPath(DRIVE_PATHS.topicsLatest)).toBeNull();

    await clock.advance(60_000);
    await daemon.settled();
    const overview = await drive.readPath(DRIVE_PATHS.topicsLatest);
    expect(overview).not.toBeNull();
    const text = overview?.bytes.toString("utf8") ?? "";
    expect(text.includes("防抖之后")).toBe(true);
    expect(text.includes(clock.now().toISOString())).toBe(false);
    const details = (await drive.list({ prefix: "topics/" })).filter(
      (file) => file.path !== DRIVE_PATHS.topicsLatest,
    );
    expect(details.map((file) => file.path)).toEqual([`topics/${topicId}.md`]);
    expect(text.includes(`https://drive.google.com/file/d/${details[0]?.id}/view`)).toBe(true);
  }, 30_000);

  it("writes during consolidation and lists topic_files on the action", async () => {
    const dirs = await trackDirs();
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("topic-files-step", "user", "Plan the launch checklist", CLOCK_START.toISOString()),
      claudeLine("topic-files-step", "assistant", "先列一个清单。", CLOCK_START.toISOString()),
    ]);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const daemon = await startTracked(dirs, clock, drive);
    const deviceId = (await readStatus(daemon)).deviceId;
    expect(
      (
        await putRoles(daemon, {
          mainDevice: deviceId,
          consolidation: { enabled: true, time: "23:00" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", { backfill: true }))
        .uploaded,
    ).toBeGreaterThan(0);
    // The upload no longer refines, so give the refine pass a turn before consolidating.
    await refineNow(clock, daemon);
    expect(await drive.findByPath(DRIVE_PATHS.topicsLatest)).toBeNull();

    const response = await send(daemon, "/api/actions/consolidate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConsolidateActionResult;
    expect(body.ok).toBe(true);
    expect(body.steps.map((step) => step.id)).toContain("topic_files");
    expect(body.steps.find((step) => step.id === "topic_files")).toEqual({
      id: "topic_files",
      ok: true,
    });
    const overview = await drive.readPath(DRIVE_PATHS.topicsLatest);
    expect(overview).not.toBeNull();
    const text = overview?.bytes.toString("utf8") ?? "";
    expect(text.includes("发布流程")).toBe(true);
    expect(text.includes("发布清单已整理")).toBe(true);
    expect(text.includes(clock.now().toISOString())).toBe(false);
  }, 30_000);

  it("keeps running when Drive is closed", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const daemon = await startTracked(dirs, clock, null);
    const deviceId = (await readStatus(daemon)).deviceId;
    expect(
      (
        await putRoles(daemon, {
          mainDevice: deviceId,
          consolidation: { enabled: true, time: "23:00" },
        })
      ).status,
    ).toBe(200);
    await clock.advance(INTERVALS.topicFilesDebounceMs + 60_000);
    await daemon.settled();
    const status = await readStatus(daemon);
    expect(status.deviceId).toBe(deviceId);
  }, 30_000);
});

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-topic-files-");
  roots.push(dirs.root);
  return dirs;
}

async function startTracked(
  dirs: DaemonDirs,
  clock: ReturnType<typeof testClock>,
  drive: MemoryDrive | null,
): Promise<YouBrainDaemon> {
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    clock,
    drive,
    llm: fakeBackend(async (request) => {
      if (request.system.includes("数字分身")) return JSON.stringify({ changed: false, portrait: "" });
      if (request.system.includes("话题概要")) {
        return JSON.stringify({ summary: "发布清单已整理", nextStep: "发出去" });
      }
      if (request.system.includes("合并建议")) return JSON.stringify({ pairs: [] });
      return refineJson("讨论了分阶段发布");
    }),
    embedder: throwingEmbedder,
    sourceRoots: { "claude-code": [dirs.sourceDir] },
    watch: false,
    signals: false,
  });
  started.push(daemon);
  await daemon.settled();
  return daemon;
}

async function onlyTopicId(daemon: YouBrainDaemon): Promise<string> {
  const body = await getJson<{ topics: Array<{ topicId: string; name: string }> }>(
    daemon,
    "/api/topics",
  );
  const topic = body.topics.find((item) => item.name === "发布流程" || item.name === "还没开沉淀");
  if (!topic) throw new Error(`topic missing: ${JSON.stringify(body.topics)}`);
  return topic.topicId;
}

async function rename(daemon: YouBrainDaemon, topicId: string, name: string): Promise<Response> {
  return send(daemon, `/api/topics/${encodeURIComponent(topicId)}`, {
    method: "POST",
    body: JSON.stringify({ op: "rename", name }),
  });
}

async function putRoles(daemon: YouBrainDaemon, body: unknown): Promise<Response> {
  return send(daemon, "/api/roles", { method: "PUT", body: JSON.stringify(body) });
}

async function postJson<T>(daemon: YouBrainDaemon, path: string, body: unknown): Promise<T> {
  const response = await send(daemon, path, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

async function getJson<T>(daemon: YouBrainDaemon, path: string): Promise<T> {
  const response = await send(daemon, path);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

async function send(daemon: YouBrainDaemon, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${daemon.token}`);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${daemon.baseUrl}${path}`, { ...init, headers });
}
