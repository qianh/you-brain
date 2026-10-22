import { describe, expect, test } from "bun:test";

import {
  attentionItems,
  captureTone,
  captureViews,
  driveTone,
  heroFault,
  heroKind,
  isUnreachableError,
  readCaptureCounts,
  refineTone,
  logsBesideWarnings,
  searchTone,
  statusScreen,
  syncLine,
  warningAction,
  withConsolidationWarning,
  type HeroInput,
} from "../../src/pages/status/logic.js";

function hero(patch: Partial<HeroInput>): HeroInput {
  return {
    loading: false,
    hasStatus: true,
    driveReachable: true,
    refineError: null,
    warningCount: 0,
    ...patch,
  };
}

describe("heroKind", () => {
  test("loads until a snapshot exists, then prefers refine, sync, and warnings", () => {
    expect(heroKind(hero({ loading: true, hasStatus: false, refineError: "x", warningCount: 2 }))).toBe("loading");
    expect(heroKind(hero({ hasStatus: false }))).toBe("loading");
    expect(heroKind(hero({ loading: true, refineError: "bad", driveReachable: false, warningCount: 3 }))).toBe("danger");
    expect(heroFault(hero({ refineError: "  解析失败  ", driveReachable: false }))).toBe("refine");
    expect(heroKind(hero({ driveReachable: false, warningCount: 2 }))).toBe("danger");
    expect(heroFault(hero({ driveReachable: false }))).toBe("sync");
    expect(heroKind(hero({ driveReachable: null, warningCount: 1 }))).toBe("warn");
    expect(heroKind(hero({ refineError: "   " }))).toBe("ok");
    expect(heroKind(hero({ syncError: "  同步失败：请求超时  " }))).toBe("danger");
    expect(heroFault(hero({ syncError: "同步失败：请求超时" }))).toBe("sync");
    expect(heroFault(hero({ refineError: "解析失败", syncError: "同步失败" }))).toBe("refine");
    expect(heroKind(hero({ syncError: "   " }))).toBe("ok");
    expect(heroKind(hero({}))).toBe("ok");
    expect(heroFault(hero({}))).toBeNull();
  });
});

describe("sync line", () => {
  test("shows a failure and its time, and treats never-synced and a backlog as not failed", () => {
    expect(syncLine(null)).toEqual({ tone: "muted", message: null, at: null });
    expect(syncLine({ lastSyncAt: null, pendingOutbox: 3 })).toEqual({ tone: "muted", message: null, at: null });
    expect(syncLine({ lastSyncAt: "   ", pendingOutbox: 3 })).toEqual({ tone: "muted", message: null, at: null });
    expect(syncLine({ lastSyncAt: "2026-10-18T16:08:00+08:00", pendingOutbox: 9 })).toEqual({
      tone: "ok",
      message: null,
      at: "2026-10-18T16:08:00+08:00",
    });
    expect(
      syncLine({
        lastSyncAt: "2026-10-18T16:08:00+08:00",
        pendingOutbox: 2,
        lastError: "  同步失败：变更游标无效  ",
        lastErrorAt: "2026-10-18T16:10:00+08:00",
      }),
    ).toEqual({
      tone: "bad",
      message: "同步失败：变更游标无效",
      at: "2026-10-18T16:10:00+08:00",
    });
    expect(syncLine({ lastSyncAt: null, lastError: "同步失败", lastErrorAt: "  " })).toEqual({
      tone: "bad",
      message: "同步失败",
      at: null,
    });
  });
});

describe("warningAction", () => {
  test("maps model, drive, and sync codes, and leaves the rest without a button", () => {
    expect(warningAction("LLM_NOT_CONFIGURED")).toBe("model");
    expect(warningAction("llm-cli-missing")).toBe("model");
    expect(warningAction("LLM_UNAVAILABLE")).toBe("model");
    expect(warningAction("AUTH_REQUIRED")).toBe("login");
    expect(warningAction("DRIVE_UNREACHABLE")).toBe("login");
    expect(warningAction("SEARCH_STALE")).toBe("sync");
    expect(warningAction("INDEX_EXPIRED")).toBe("sync");
    expect(warningAction("SYNC_FAILED")).toBe("sync");
    expect(warningAction("CAPTURE_CURSOR")).toBe("none");
    expect(warningAction("CONSOLIDATION_STALE")).toBe("none");
    expect(warningAction("EMBED_UNAVAILABLE")).toBe("none");
    expect(warningAction("  ")).toBe("none");
  });
});

describe("attention items", () => {
  test("drops blank messages, dedupes, and adds a stale consolidation once", () => {
    const warnings = [
      { code: "SEARCH_STALE", message: "  索引过期  " },
      { code: "SEARCH_STALE", message: "索引过期" },
      { code: "CAPTURE_CURSOR", message: "" },
      { code: "LLM_NOT_CONFIGURED", message: "还没配置模型" },
    ];
    expect(attentionItems(warnings).map((item) => [item.action, item.message])).toEqual([
      ["sync", "索引过期"],
      ["model", "还没配置模型"],
    ]);
    const withStale = withConsolidationWarning(warnings, true, "超过一天没有沉淀");
    expect(withStale.some((item) => item.code === "CONSOLIDATION_STALE")).toBe(true);
    expect(withConsolidationWarning(withStale, true, "超过一天没有沉淀")).toHaveLength(withStale.length);
    expect(withConsolidationWarning(warnings, false, "超过一天没有沉淀")).toEqual(warnings);
  });
});

describe("status screen", () => {
  test("treats a transport failure as offline and an HTTP error as an error", () => {
    expect(isUnreachableError("Failed to fetch")).toBe(true);
    expect(isUnreachableError("Load failed")).toBe(true);
    expect(isUnreachableError("daemon 返回的不是 JSON")).toBe(true);
    expect(isUnreachableError("后台暂时不可用")).toBe(false);
    expect(statusScreen({ loading: true, hasStatus: false, error: null })).toBe("loading");
    expect(statusScreen({ loading: false, hasStatus: true, error: "Failed to fetch" })).toBe("ready");
    expect(statusScreen({ loading: false, hasStatus: false, error: "Failed to fetch" })).toBe("offline");
    expect(statusScreen({ loading: false, hasStatus: false, error: "后台暂时不可用" })).toBe("error");
    expect(statusScreen({ loading: false, hasStatus: false, error: null })).toBe("offline");
  });
});

describe("connection tones", () => {
  test("uses color only as a backup for the words", () => {
    expect(driveTone(true)).toBe("ok");
    expect(driveTone(false)).toBe("bad");
    expect(driveTone(null)).toBe("muted");
    expect(refineTone(0, null)).toBe("ok");
    expect(refineTone(2, "  ")).toBe("warn");
    expect(refineTone(0, "解析失败")).toBe("bad");
    expect(searchTone(true)).toBe("ok");
    expect(searchTone(true, 128)).toBe("ok");
    expect(searchTone(false)).toBe("muted");
    expect(searchTone(false, 0)).toBe("muted");
    expect(searchTone(false, 128)).toBe("warn");
  });
});

describe("error log", () => {
  test("hides lines that repeat a warning and keeps the rest", () => {
    const logs = logsBesideWarnings(
      [
        { at: "2026-10-21T01:00:00.000Z", message: "搜索索引已超过一天没有更新" },
        { at: "2026-10-21T02:00:00.000Z", message: " Drive 变更游标过期 " },
        { at: null, message: "   " },
      ],
      [{ message: "搜索索引已超过一天没有更新" }, { message: "  " }],
    );
    expect(logs.map((row) => row.message.trim())).toEqual(["Drive 变更游标过期"]);
  });
});

describe("capture views", () => {
  test("keeps known sources, optional counts, and the tone of each row", () => {
    const payload = {
      captures: [
        { source: "cursor", lastCaptureAt: null, error: "路径不存在", sessionCount: 4 },
        { source: "codex", lastCaptureAt: "2026-10-21T01:00:00.000Z", error: null, sessions: "nope" },
        { source: "extra-bot", lastCaptureAt: "2026-10-21T01:00:00.000Z", error: null, count: 2 },
      ],
    };
    const views = captureViews(payload, { "claude-code": true, cursor: false, codex: true });
    expect(views.map((row) => row.source)).toEqual(["claude-code", "cursor", "codex", "extra-bot"]);
    expect(views.find((row) => row.source === "cursor")).toMatchObject({
      enabled: false,
      count: 4,
      error: "路径不存在",
    });
    expect(views.find((row) => row.source === "codex")?.count).toBeNull();
    expect(views.find((row) => row.source === "claude-code")).toMatchObject({
      enabled: true,
      lastCaptureAt: null,
      count: null,
    });
    expect(captureTone({ error: "x", lastCaptureAt: null, enabled: true })).toBe("bad");
    expect(captureTone({ error: null, lastCaptureAt: null, enabled: true })).toBe("muted");
    expect(captureTone({ error: null, lastCaptureAt: "t", enabled: false })).toBe("muted");
    expect(captureTone({ error: null, lastCaptureAt: "t", enabled: true })).toBe("ok");
    expect(readCaptureCounts({ captures: [{ source: "codex", count: -1 }] }).size).toBe(0);
  });

  test("shows the five sources when nothing has been captured yet", () => {
    expect(captureViews({ captures: [] }, null).map((row) => row.source)).toEqual([
      "claude-code",
      "codex",
      "grok-build",
      "cursor",
      "gemini-cli",
    ]);
  });
});
