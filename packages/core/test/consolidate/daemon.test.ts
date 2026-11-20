import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { DRIVE_PATHS } from "@you-brain/protocol";
import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type DaemonOptions, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import { LlmAbortError } from "../../src/llm/errors.js";
import {
  TWIN_CLAIMS_SYSTEM_PROMPT,
  TWIN_CODING_PROPOSALS_SYSTEM_PROMPT,
  TWIN_MERGE_SYSTEM_PROMPT,
} from "../../src/consolidate/index.js";
import { TWIN_PROBES_SYSTEM_PROMPT } from "../../src/consolidate/prompt.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { createDaemonClient } from "../../src/http/client.js";
import type { ConsolidateActionResult } from "../../src/http/types.js";
import {
  CLOCK_START,
  claudeLine,
  fakeBackend,
  makeDaemonDirs,
  refineNow,
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
    await daemon.settleConfigPush();
    const kinds: string[] = [];
    const unsubscribe = daemon.changes.subscribe((event) => {
      kinds.push(event.kind);
    });
    const first = await consolidate();
    expect(first.ok).toBe(true);
    expect(first.day).toBe("2026-10-18");
    expect(first.steps.map((step) => step.id)).toEqual([
      "todo_review",
      "topic_summaries",
      "merge_suggestions",
      "portrait",
      "portrait_eval",
      "portrait_monthly",
      "topic_files",
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
    expect(forced.steps.map((step) => step.ok)).toEqual([true, true, true, true, true, true, true]);
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
          consolidation: { enabled: false, time: "23:00" },
        })
      ).status,
    ).toBe(200);
    const uploaded = await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", {
      backfill: true,
    });
    expect(uploaded.uploaded).toBeGreaterThan(0);
    // Refine is a separate pass now, so the topic has to exist before consolidating.
    await refineNow(clock, daemon);
    await nextMorning(clock, daemon);
    expect(
      (await putRoles(daemon, { mainDevice: id, consolidation: { enabled: true, time: "23:00" } })).status,
    ).toBe(200);

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
      day: "2026-10-19",
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

  it("feeds yesterday's sessions into a run after midnight", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const versionLine = "版本 v2.0.0 · 2026-10-01 · 变更见 changelog";
    const full = `# 数字分身 · 人格\n${versionLine}\n\n## 1. 一句话\n保持原结构。\n`;
    const coding = `# 数字分身 · 编码\n${versionLine}\n\n## 4. 运维与命令\n给可粘贴的命令。\n`;
    for (const [path, text] of [
      ["digital-twin/JOHN-DIGITAL-TWIN-latest.md", full],
      ["digital-twin/JOHN-TWIN-coding.md", coding],
    ] as const) {
      await drive.put({ path, bytes: Buffer.from(text, "utf8"), mimeType: "text/markdown" });
    }
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("portrait-1", "user", "Plan the launch checklist", CLOCK_START.toISOString()),
      claudeLine("portrait-1", "assistant", "先列一个清单。", CLOCK_START.toISOString()),
    ]);
    const claimInputs: string[] = [];
    const daemon = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async (request) => {
        if (request.system === TWIN_CLAIMS_SYSTEM_PROMPT) {
          claimInputs.push(request.user);
          return JSON.stringify({
            claims: [
              { layer: "persona", project: "", confidence: "high", text: "发布前先列清单。" },
              { layer: "coding", project: "", confidence: "high", text: "交付前先跑回归测试。" },
            ],
          });
        }
        if (request.system === TWIN_CODING_PROPOSALS_SYSTEM_PROMPT) {
          return JSON.stringify({
            proposals: [
              {
                section: "## 验证与交付",
                action: "add",
                proposedLine: "- **回归验证**：行为修复后先跑回归测试再交付。",
                reason: "会话明确要求交付前跑回归测试",
              },
            ],
          });
        }
        if (request.system === TWIN_MERGE_SYSTEM_PROMPT) {
          return JSON.stringify({
            bump: "minor",
            changelog: ["full · 1 一句话：发布前先列清单"],
            edits: [
              {
                layer: "full",
                heading: "## 1. 一句话",
                text: "## 1. 一句话\n保持原结构。\n发布前先列清单。",
              },
            ],
          });
        }
        if (request.system === TWIN_PROBES_SYSTEM_PROMPT) return JSON.stringify({ probes: [] });
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
          consolidation: { enabled: false, time: "03:00" },
        })
      ).status,
    ).toBe(200);
    const uploaded = await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", {
      backfill: true,
    });
    expect(uploaded.uploaded).toBeGreaterThan(0);
    // Uploading is a sync step now; the topic the consolidation rewrites comes from the
    // refine pass that follows.
    await refineNow(clock, daemon);
    // The session happened on 10-18; the run lands on 10-19 at 01:00, before its 03:00 slot.
    await clock.advance(15 * 60 * 60 * 1000);
    await daemon.settled();
    expect(
      (await putRoles(daemon, { mainDevice: id, consolidation: { enabled: true, time: "03:00" } })).status,
    ).toBe(200);

    const response = await postConsolidate(daemon, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConsolidateActionResult;
    expect(body.day).toBe("2026-10-19");
    expect(body.steps).toEqual([
      { id: "todo_review", ok: true },
      { id: "topic_summaries", ok: true },
      { id: "merge_suggestions", ok: true },
      { id: "portrait", ok: true },
      { id: "portrait_eval", ok: true },
      { id: "portrait_monthly", ok: true },
      { id: "topic_files", ok: true },
    ]);
    expect(claimInputs.join("\n")).toContain("Plan the launch checklist");
    expect(claimInputs.join("\n")).not.toContain("先列一个清单。");
    const written = (await drive.readPath("digital-twin/JOHN-DIGITAL-TWIN-latest.md"))?.bytes.toString("utf8");
    expect(written?.split("\n")[1]).toBe("版本 v2.1.0 · 2026-10-19 · 变更见 changelog");
    expect(written).toContain("发布前先列清单。");
    expect((await drive.readPath("digital-twin/JOHN-TWIN-coding.md"))?.bytes.toString("utf8")).toBe(coding);
    const proposals = (await drive.readPath("digital-twin/proposals/coding-pending.jsonl"))?.bytes.toString("utf8");
    expect(proposals).toContain("回归验证");
    expect(
      (await drive.readPath("digital-twin/consolidate-backup/JOHN-DIGITAL-TWIN-latest-2026-10-19.md"))?.bytes.toString(
        "utf8",
      ),
    ).toBe(full);
    expect(await readFile(join(dirs.homeDir, "portrait", "full.md"), "utf8")).toBe(written ?? "");
  });

  it("resets consolidation backoff and triggers on the next tick after consolidateLlm config changes", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("backoff-reset-1", "user", "First topic work", CLOCK_START.toISOString()),
      claudeLine("backoff-reset-1", "assistant", "好的。", CLOCK_START.toISOString()),
    ]);
    let failSummaries = true;
    const daemon = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async (request) => {
        if (request.system.includes("话题概要")) {
          if (failSummaries) throw new Error("model 404");
          return JSON.stringify({ summary: "新概要", nextStep: "" });
        }
        if (request.system.includes("合并建议")) return JSON.stringify({ pairs: [] });
        return refineJson("讨论了分阶段发布");
      }),
    );
    const id = (await readStatus(daemon)).deviceId;
    await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", { backfill: true });
    await refineNow(clock, daemon);
    await nextMorning(clock, daemon);
    expect(
      (await putRoles(daemon, { mainDevice: id, consolidation: { enabled: true, time: "00:00" } })).status,
    ).toBe(200);

    // First scheduled run fails and enters 30m backoff.
    await clock.advance(INTERVALS.tickMs);
    await daemon.settled();
    expect(await leaseFinishedAt(drive)).toBeNull();
    expect((await readStatus(daemon)).consolidation.lastRun?.ok).toBe(false);

    // Fix model and update consolidateLlm config; backoff and consolidation interval should reset immediately.
    failSummaries = false;
    expect(
      (
        await send(daemon, "/api/config", {
          method: "PUT",
          body: JSON.stringify({
            consolidateLlm: { enabled: true, provider: "magpie", model: "stable/model", baseUrl: "" },
          }),
        })
      ).status,
    ).toBe(200);

    await clock.advance(INTERVALS.tickMs);
    await daemon.settled();
    expect(await leaseFinishedAt(drive)).not.toBeNull();
    expect((await readStatus(daemon)).consolidation.lastRun?.ok).toBe(true);
  });

  it("runs consolidation detached without blocking scan, sync, or status, and rejects concurrent manual runs with 409", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("detached-1", "user", "Detached test work", CLOCK_START.toISOString()),
      claudeLine("detached-1", "assistant", "好的。", CLOCK_START.toISOString()),
    ]);
    let releaseLlm!: () => void;
    let llmEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      llmEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });

    const daemon = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async (request) => {
        if (request.system.includes("话题概要")) {
          llmEntered();
          await gate;
          return JSON.stringify({ summary: "异步完成", nextStep: "" });
        }
        if (request.system.includes("合并建议")) return JSON.stringify({ pairs: [] });
        return refineJson("讨论了异步化");
      }),
    );
    const id = (await readStatus(daemon)).deviceId;
    await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", { backfill: true });
    await refineNow(clock, daemon);
    await nextMorning(clock, daemon);
    expect(
      (await putRoles(daemon, { mainDevice: id, consolidation: { enabled: true, time: "23:00" } })).status,
    ).toBe(200);

    const firstRun = postConsolidate(daemon, {});
    await entered;

    // While consolidation is waiting on the model, status / scan / sync must remain responsive.
    const duringStatus = await readStatus(daemon);
    expect(duringStatus.consolidation.running).toBe(true);
    await daemon.scan();
    const syncRes = await postJson<{ started: boolean }>(daemon, "/api/actions/sync", {});
    expect(syncRes.started).toBe(true);

    // Concurrent manual run gets 409 CONSOLIDATION_RUNNING immediately.
    const duplicate = await postConsolidate(daemon, {});
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: { code: "CONSOLIDATION_RUNNING", message: "沉淀正在进行中" },
    });

    releaseLlm();
    const finished = await firstRun;
    expect(finished.status).toBe(200);
    expect(((await finished.json()) as ConsolidateActionResult).ok).toBe(true);
    expect((await readStatus(daemon)).consolidation.running).toBeUndefined();
  });

  it("aborts in-flight consolidation cleanly on daemon.stop() without store errors", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("stop-1", "user", "Stop abort test", CLOCK_START.toISOString()),
      claudeLine("stop-1", "assistant", "好的。", CLOCK_START.toISOString()),
    ]);
    let llmEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      llmEntered = resolve;
    });
    let sawAbort = false;
    const daemon = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async (request) => {
        if (request.system.includes("话题概要")) {
          llmEntered();
          return new Promise<string>((_, reject) => {
            if (request.signal?.aborted) {
              sawAbort = true;
              reject(new LlmAbortError());
              return;
            }
            request.signal?.addEventListener(
              "abort",
              () => {
                sawAbort = true;
                reject(new LlmAbortError());
              },
              { once: true },
            );
          });
        }
        return refineJson("讨论了停机中止");
      }),
    );
    const id = (await readStatus(daemon)).deviceId;
    await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", { backfill: true });
    await refineNow(clock, daemon);
    await nextMorning(clock, daemon);
    expect(
      (await putRoles(daemon, { mainDevice: id, consolidation: { enabled: true, time: "23:00" } })).status,
    ).toBe(200);

    const runPromise = postConsolidate(daemon, {}).catch(() => null);
    await entered;

    const startedStop = Date.now();
    await daemon.stop();
    expect(Date.now() - startedStop).toBeLessThan(2_500);
    expect(sawAbort).toBe(true);
    expect(await leaseFinishedAt(drive)).toBeNull();
    await runPromise;
  });

  it("aborts in-flight consolidation without writing lease or backoff when mainDevice changes", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("switch-1", "user", "Role switch test", CLOCK_START.toISOString()),
      claudeLine("switch-1", "assistant", "好的。", CLOCK_START.toISOString()),
    ]);
    let llmEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      llmEntered = resolve;
    });
    const daemon = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async (request) => {
        if (request.system.includes("话题概要")) {
          llmEntered();
          return new Promise<string>((_, reject) => {
            request.signal?.addEventListener("abort", () => reject(new LlmAbortError()), { once: true });
          });
        }
        return refineJson("讨论了切主设备");
      }),
    );
    const id = (await readStatus(daemon)).deviceId;
    await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", { backfill: true });
    await refineNow(clock, daemon);
    await nextMorning(clock, daemon);
    expect(
      (await putRoles(daemon, { mainDevice: id, consolidation: { enabled: true, time: "23:00" } })).status,
    ).toBe(200);

    const runPromise = postConsolidate(daemon, {});
    await entered;
    // Sign out / clear Drive while consolidation is running; job must abort without writing lease or backoff.
    expect((await send(daemon, "/api/actions/google-logout", { method: "POST", body: "{}" })).status).toBe(200);
    const response = await runPromise;
    expect(response.status).toBe(200);
    expect(await leaseFinishedAt(drive)).toBeNull();
    // Aborted run must not record a failure or enter backoff.
    expect((await readStatus(daemon)).consolidation.lastRun).toBeUndefined();
  });

  it("fails a consolidation step that exceeds consolidationStepBudgetMs", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("budget-1", "user", "Step budget test", CLOCK_START.toISOString()),
      claudeLine("budget-1", "assistant", "好的。", CLOCK_START.toISOString()),
    ]);
    const daemon = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async (request) => {
        if (request.system.includes("话题概要")) {
          return new Promise<string>((_, reject) => {
            request.signal?.addEventListener("abort", () => reject(new LlmAbortError()), { once: true });
          });
        }
        if (request.system.includes("合并建议")) return JSON.stringify({ pairs: [] });
        return refineJson("讨论了步骤超时");
      }),
      { consolidationStepBudgetMs: 80 },
    );
    const id = (await readStatus(daemon)).deviceId;
    await postJson<{ uploaded: number }>(daemon, "/api/actions/upload", { backfill: true });
    await refineNow(clock, daemon);
    await nextMorning(clock, daemon);
    expect(
      (await putRoles(daemon, { mainDevice: id, consolidation: { enabled: true, time: "23:00" } })).status,
    ).toBe(200);

    const response = await postConsolidate(daemon, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConsolidateActionResult;
    expect(body.ok).toBe(false);
    expect(body.steps.find((step) => step.id === "topic_summaries")).toMatchObject({
      ok: false,
      error: "步骤执行超时",
    });
    expect(await leaseFinishedAt(drive)).toBeNull();
  });

  it("uses SWR with single-flight Drive reads for /api/status lease and refreshes in background", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const oldFinished = "2026-10-18T01:00:00.000Z";
    const newFinished = "2026-10-18T02:00:00.000Z";
    await drive.upsert({
      path: DRIVE_PATHS.consolidateLease,
      bytes: Buffer.from(JSON.stringify({ date: "2026-10-18", deviceId: "device-a", finishedAt: oldFinished }), "utf8"),
      mimeType: "application/json",
    });

    const origReadPath = drive.readPath.bind(drive);
    let leaseReads = 0;
    let slowLease = false;
    let releaseLease!: () => void;
    let leaseEntered!: () => void;
    let enteredPromise = new Promise<void>((r) => {
      leaseEntered = r;
    });
    let gatePromise = new Promise<void>((r) => {
      releaseLease = r;
    });

    drive.readPath = async (path: string) => {
      if (path === DRIVE_PATHS.consolidateLease) {
        leaseReads += 1;
        if (slowLease) {
          leaseEntered();
          await gatePromise;
        }
      }
      return origReadPath(path);
    };

    const daemon = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async () => refineJson("概要")),
      { statusDriveWaitMs: 30 },
    );
    const id = (await readStatus(daemon)).deviceId;
    expect(
      (await putRoles(daemon, { mainDevice: id, consolidation: { enabled: true, time: "23:00" } })).status,
    ).toBe(200);

    // Warm cache with oldFinished.
    expect((await readStatus(daemon)).consolidation.lastFinishedAt).toBe(oldFinished);

    // Update remote lease, advance past 30s cache TTL, and make Drive read slow.
    await drive.upsert({
      path: DRIVE_PATHS.consolidateLease,
      bytes: Buffer.from(JSON.stringify({ date: "2026-10-18", deviceId: "device-a", finishedAt: newFinished }), "utf8"),
      mimeType: "application/json",
    });
    clock.advance(35_000);
    leaseReads = 0;
    slowLease = true;
    enteredPromise = new Promise<void>((r) => {
      leaseEntered = r;
    });
    gatePromise = new Promise<void>((r) => {
      releaseLease = r;
    });

    // Two concurrent status calls should share a single Drive lease read and return stale oldFinished after 30ms.
    const [s1, s2] = await Promise.all([readStatus(daemon), readStatus(daemon)]);
    await enteredPromise;
    expect(leaseReads).toBe(1);
    expect(s1.consolidation.lastFinishedAt).toBe(oldFinished);
    expect(s2.consolidation.lastFinishedAt).toBe(oldFinished);

    // Release slow Drive read; background flight updates cache & cursor, next status (past 3s statusCache) sees newFinished.
    releaseLease();
    await new Promise((r) => setTimeout(r, 20));
    clock.advance(5_000);
    expect((await readStatus(daemon)).consolidation.lastFinishedAt).toBe(newFinished);
  });

  it("returns cursor-stored lastFinishedAt after restart when Drive is not open, and reflects new lastRun immediately", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("swr-restart-1", "user", "Check cursor fallback", CLOCK_START.toISOString()),
      claudeLine("swr-restart-1", "assistant", "好的。", CLOCK_START.toISOString()),
    ]);
    let failSummaries = false;
    const daemon1 = await startTracked(
      dirs,
      clock,
      drive,
      fakeBackend(async (request) => {
        if (request.system.includes("话题概要")) {
          if (failSummaries) throw new Error("summary down");
          return JSON.stringify({ summary: "ok", nextStep: "" });
        }
        if (request.system.includes("合并建议")) return JSON.stringify({ pairs: [] });
        return refineJson("讨论了状态缓存");
      }),
    );
    const id = (await readStatus(daemon1)).deviceId;
    await postJson<{ uploaded: number }>(daemon1, "/api/actions/upload", { backfill: true });
    await refineNow(clock, daemon1);
    await nextMorning(clock, daemon1);
    expect(
      (await putRoles(daemon1, { mainDevice: id, consolidation: { enabled: true, time: "23:00" } })).status,
    ).toBe(200);
    await daemon1.settleConfigPush();

    // Run 1 succeeds and populates lease cache + cursor.
    const okRes = await postConsolidate(daemon1, {});
    expect(okRes.status).toBe(200);
    const savedFinished = await leaseFinishedAt(drive);
    expect(savedFinished).not.toBeNull();
    expect((await readStatus(daemon1)).consolidation.lastRun?.ok).toBe(true);

    // Within the 30s lease cache TTL, a forced run fails; /api/status must immediately show lastRun.ok = false
    // while still preserving lastFinishedAt.
    failSummaries = true;
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("swr-restart-1", "user", "Check cursor fallback", CLOCK_START.toISOString()),
      claudeLine("swr-restart-1", "assistant", "好的。", CLOCK_START.toISOString()),
      claudeLine("swr-restart-1", "user", "Add a second turn so summary rewrites", CLOCK_START.toISOString()),
      claudeLine("swr-restart-1", "assistant", "收到。", CLOCK_START.toISOString()),
    ]);
    await postJson<{ uploaded: number }>(daemon1, "/api/actions/upload", { backfill: true });
    await refineNow(clock, daemon1);
    // The new turn is reviewed by the next night's run.
    await clock.advance(24 * 60 * 60 * 1000);
    await daemon1.settled();
    const failRes = await postConsolidate(daemon1, { force: true });
    expect(failRes.status).toBe(200);
    const afterFail = await readStatus(daemon1);
    expect(afterFail.consolidation.lastFinishedAt).toBe(savedFinished);
    expect(afterFail.consolidation.lastRun?.ok).toBe(false);

    // Restart with Drive unavailable: /api/status should fall back to the cursor-stored lastFinishedAt.
    await daemon1.stop();
    const daemon2 = await startTracked(dirs, clock, null, fakeBackend(async () => refineJson("概要")));
    const restartedStatus = await readStatus(daemon2);
    expect(restartedStatus.consolidation.enabled).toBe(true);
    expect(restartedStatus.consolidation.lastFinishedAt).toBe(savedFinished);
  });
});

/** The nightly run works on the finished day before; move to 01:00 the next day. */
async function nextMorning(clock: ReturnType<typeof testClock>, daemon: YouBrainDaemon): Promise<void> {
  await clock.advance(15 * 60 * 60 * 1000);
  await daemon.settled();
}

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
  extra: Partial<DaemonOptions> = {},
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
    ...extra,
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
