import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { DRIVE_PATHS } from "@you-brain/protocol";
import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { createDaemonClient } from "../../src/http/client.js";
import type { ConsolidateActionResult } from "../../src/http/types.js";
import {
  CLOCK_START,
  claudeLine,
  fakeBackend,
  makeDaemonDirs,
  readStatus,
  refineJson,
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

describe("consolidation daemon", () => {
  it("returns 409 reason codes and accepts force on the manual action", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const daemon = await startTracked(dirs, clock, drive, fakeBackend(async () => refineJson("概要")));
    const consolidate = daemonClient(daemon).consolidate;
    if (!consolidate) throw new Error("DaemonClient.consolidate 缺失");
    await expect(consolidate()).rejects.toMatchObject({
      status: 409,
      code: "NOT_MAIN_DEVICE",
      message: "只有主设备可以执行沉淀",
    });

    const id = (await readStatus(daemon)).deviceId;
    expect((await putRoles(daemon, { mainDevice: id })).status).toBe(200);
    await expect(consolidate({})).rejects.toMatchObject({
      status: 409,
      code: "DISABLED",
      message: "全局沉淀未启用",
    });

    expect((await putRoles(daemon, { consolidation: { enabled: true, time: "23:00" } })).status).toBe(
      200,
    );
    const kinds: string[] = [];
    const unsubscribe = daemon.changes.subscribe((event) => {
      kinds.push(event.kind);
    });
    const first = await consolidate();
    expect(first.ok).toBe(true);
    expect(first.day).toBe("2026-10-18");
    expect(first.steps.map((step) => step.id)).toEqual([
      "topic_summaries",
      "merge_suggestions",
      "portrait",
    ]);
    expect(kinds).toEqual(["topics", "status"]);
    const finished = await leaseFinishedAt(drive);
    expect((await readStatus(daemon)).consolidation.lastFinishedAt).toBe(finished);

    kinds.length = 0;
    const again = await consolidate({});
    expect(again).toEqual({ day: "2026-10-18", ok: true, steps: [] });
    expect(kinds).toEqual([]);
    expect(await leaseFinishedAt(drive)).toBe(finished);

    await clock.advance(1_000);
    await daemon.settled();
    kinds.length = 0;
    const forced = await consolidate({ force: true });
    expect(forced.ok).toBe(true);
    expect(forced.steps.map((step) => step.ok)).toEqual([true, true, true]);
    expect(await leaseFinishedAt(drive)).not.toBe(finished);
    expect(kinds).toEqual(["topics", "status"]);
    unsubscribe();
  });

  it("rejects a manual run when the model or the drive is missing", async () => {
    const noModelDirs = await trackDirs();
    const noModelClock = testClock();
    const noModel = await startTracked(
      noModelDirs,
      noModelClock,
      new MemoryDrive({ now: () => noModelClock.now() }),
      null,
    );
    const noModelId = (await readStatus(noModel)).deviceId;
    expect(
      (await putRoles(noModel, { mainDevice: noModelId, consolidation: { enabled: true } })).status,
    ).toBe(200);
    const noModelBody = await postConsolidate(noModel, {});
    expect(noModelBody.status).toBe(409);
    expect(await noModelBody.json()).toEqual({
      error: { code: "NO_LLM", message: "模型不可用" },
    });

    const noDriveDirs = await trackDirs();
    const noDrive = await startTracked(
      noDriveDirs,
      testClock(),
      null,
      fakeBackend(async () => refineJson("概要")),
    );
    const noDriveId = (await readStatus(noDrive)).deviceId;
    expect(
      (await putRoles(noDrive, { mainDevice: noDriveId, consolidation: { enabled: true } })).status,
    ).toBe(200);
    const noDriveBody = await postConsolidate(noDrive, {});
    expect(noDriveBody.status).toBe(409);
    expect(await noDriveBody.json()).toEqual({
      error: { code: "NO_DRIVE", message: "Drive 未打开" },
    });
  });

  it("waits until the local time, then does not run again the same day", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    let calls = 0;
    const daemon = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async () => {
        calls += 1;
        return refineJson("概要");
      }),
    );
    const id = (await readStatus(daemon)).deviceId;
    expect(
      (
        await putRoles(daemon, {
          mainDevice: id,
          consolidation: { enabled: true, time: "23:00" },
        })
      ).status,
    ).toBe(200);

    await clock.advance(2_000);
    await daemon.settled();
    expect(await leaseFinishedAt(drive)).toBeNull();

    expect((await putRoles(daemon, { consolidation: { time: "03:00" } })).status).toBe(200);
    await clock.advance(2_000);
    await daemon.settled();
    expect(await leaseFinishedAt(drive)).toBeNull();

    await clock.advance(INTERVALS.consolidationMs);
    await daemon.settled();
    const finished = await leaseFinishedAt(drive);
    expect(finished).toBeTruthy();
    const status = await readStatus(daemon);
    expect(status.consolidation.lastFinishedAt).toBe(finished);
    expect(status.consolidation.lastRun).toMatchObject({ day: "2026-10-18", ok: true });
    expect(calls).toBe(0);

    await clock.advance(INTERVALS.consolidationMs);
    await daemon.settled();
    expect(await leaseFinishedAt(drive)).toBe(finished);
    expect(calls).toBe(0);
  });

  it("repairs a corrupt lease without stopping the loop", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await drive.put({
      path: DRIVE_PATHS.consolidateLease,
      bytes: Buffer.from("{"),
      mimeType: "application/json",
    });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const daemon = await startTracked(dirs, clock, drive, fakeBackend(async () => refineJson("概要")));
      const id = (await readStatus(daemon)).deviceId;
      expect(
        (await putRoles(daemon, { mainDevice: id, consolidation: { enabled: true } })).status,
      ).toBe(200);
      await clock.advance(2_000);
      await daemon.settled();
      const status = await readStatus(daemon);
      expect(status.consolidation.lastFinishedAt).toBeTruthy();
      expect(status.consolidation.status).toBe("ok");
      const object = await drive.readPath(DRIVE_PATHS.consolidateLease);
      expect(JSON.parse(object?.bytes.toString("utf8") ?? "")).toMatchObject({
        date: "2026-10-18",
        deviceId: id,
      });
      expect(warnings.some((warning) => warning.includes("沉淀租约无法解析"))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  it("records a failed run without writing the lease", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("fail-1", "user", "Plan the launch checklist", CLOCK_START.toISOString()),
      claudeLine("fail-1", "assistant", "先列一个清单。", CLOCK_START.toISOString()),
    ]);
    const daemon = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async (request) => {
        if (request.system.includes("话题概要")) return "not-json";
        if (request.system.includes("合并建议")) return JSON.stringify({ pairs: [] });
        return refineJson("讨论了分阶段发布");
      }),
    );
    const id = (await readStatus(daemon)).deviceId;
    expect(
      (
        await putRoles(daemon, {
          mainDevice: id,
          consolidation: { enabled: true, time: "23:00" },
        })
      ).status,
    ).toBe(200);
    const uploaded = await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", {
      backfill: true,
    });
    expect(uploaded.uploaded).toBeGreaterThan(0);

    const kinds: string[] = [];
    const unsubscribe = daemon.changes.subscribe((event) => kinds.push(event.kind));
    const response = await postConsolidate(daemon, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConsolidateActionResult;
    expect(body.ok).toBe(false);
    expect(body.steps.find((step) => step.id === "topic_summaries")?.error).toBe(
      "部分话题概要没有写完",
    );
    expect(kinds).toEqual(expect.arrayContaining(["topics", "status"]));
    unsubscribe();

    const status = await readStatus(daemon);
    expect(status.consolidation.lastFinishedAt).toBeNull();
    expect(status.consolidation.lastRun).toMatchObject({
      day: "2026-10-18",
      ok: false,
      error: "部分话题概要没有写完",
    });
    expect(status.warnings).toContainEqual({
      code: "CONSOLIDATION_FAILED",
      message: "每日沉淀没有完成",
    });
    expect(await drive.readPath(DRIVE_PATHS.consolidateLease)).toBeNull();
    const topics = await getJson<{ topics: Array<{ name: string; summary: string }> }>(
      daemon,
      "/api/topics",
    );
    expect(topics.topics.some((topic) => topic.name === "发布流程")).toBe(true);
    expect(topics.topics.every((topic) => topic.summary === "")).toBe(true);
  });

  it("regenerates the full portrait during a manual run", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const original = "# 数字分身\n\n## 工作\n保持原结构。\n";
    const next = `${original}\n## 今天\n补上发布清单。\n`;
    await drive.put({
      path: "digital-twin/JOHN-DIGITAL-TWIN-latest.md",
      bytes: Buffer.from(original, "utf8"),
      mimeType: "text/markdown",
    });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("portrait-1", "user", "Plan the launch checklist", CLOCK_START.toISOString()),
      claudeLine("portrait-1", "assistant", "先列一个清单。", CLOCK_START.toISOString()),
    ]);
    const daemon = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async (request) => {
        if (request.system.includes("数字分身")) return JSON.stringify({ changed: true, portrait: next });
        if (request.system.includes("话题概要")) {
          return JSON.stringify({ summary: "发布清单已整理", nextStep: "" });
        }
        if (request.system.includes("合并建议")) return JSON.stringify({ pairs: [] });
        return refineJson("讨论了分阶段发布");
      }),
    );
    const id = (await readStatus(daemon)).deviceId;
    expect(
      (
        await putRoles(daemon, {
          mainDevice: id,
          consolidation: { enabled: true, time: "23:00" },
        })
      ).status,
    ).toBe(200);
    const uploaded = await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", {
      backfill: true,
    });
    expect(uploaded.uploaded).toBeGreaterThan(0);

    const response = await postConsolidate(daemon, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConsolidateActionResult;
    expect(body.day).toBe("2026-10-18");
    expect(body.steps).toEqual([
      { id: "topic_summaries", ok: true },
      { id: "merge_suggestions", ok: true },
      { id: "portrait", ok: true },
    ]);
    expect((await drive.readPath("digital-twin/JOHN-DIGITAL-TWIN-latest.md"))?.bytes.toString("utf8")).toBe(
      next,
    );
    expect(
      (
        await drive.readPath("digital-twin/consolidate-backup/JOHN-DIGITAL-TWIN-latest-2026-10-18.md")
      )?.bytes.toString("utf8"),
    ).toBe(original);
    expect(
      (
        await drive.readPath("digital-twin/JOHN-DIGITAL-TWIN-v1.0.0-2026-10-18.md")
      )?.bytes.toString("utf8"),
    ).toBe(next);
    expect(await readFile(join(dirs.homeDir, "portrait", "full.md"), "utf8")).toBe(next);
  });
});

function daemonClient(daemon: YouBrainDaemon) {
  return createDaemonClient({ port: daemon.port, token: daemon.token });
}

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-consolidate-");
  roots.push(dirs.root);
  return dirs;
}

async function startTracked(
  dirs: DaemonDirs,
  clock: ReturnType<typeof testClock>,
  drive: MemoryDrive | null,
  llm: ReturnType<typeof fakeBackend> | null,
): Promise<YouBrainDaemon> {
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    clock,
    drive,
    llm,
    embedder: throwingEmbedder,
    sourceRoots: { "claude-code": [dirs.sourceDir] },
    watch: false,
    signals: false,
  });
  started.push(daemon);
  await daemon.settled();
  return daemon;
}

async function leaseFinishedAt(drive: MemoryDrive): Promise<string | null> {
  const object = await drive.readPath(DRIVE_PATHS.consolidateLease);
  if (!object) return null;
  const parsed = JSON.parse(object.bytes.toString("utf8")) as { finishedAt?: string };
  return parsed.finishedAt ?? null;
}

async function putRoles(daemon: YouBrainDaemon, body: unknown): Promise<Response> {
  return send(daemon, "/api/roles", { method: "PUT", body: JSON.stringify(body) });
}

async function postConsolidate(daemon: YouBrainDaemon, body: unknown): Promise<Response> {
  return send(daemon, "/api/actions/consolidate", {
    method: "POST",
    body: JSON.stringify(body),
  });
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
