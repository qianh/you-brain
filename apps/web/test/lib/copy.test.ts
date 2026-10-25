import { describe, expect, test } from "bun:test";

import { translate } from "../../src/i18n/messages.js";
import {
  attentionLevel,
  syncDot,
  linesToList,
  listToLines,
  consolidationView,
  panelProblems,
  readCaptures,
  readLogs,
  searchNotices,
  searchTitle,
  uncollectedNotes,
  validateSettings,
} from "../../src/lib/copy.js";

const validDraft = {
  idleMinutes: 5,
  activeLimit: 10,
  historyDays: 30,
  morningDigestTime: "08:00",
  weeklyReviewTime: "09:00",
  consolidateTime: "03:00",
  timezone: "Asia/Shanghai",
  driveRoot: "brain-hub",
  baseUrl: "",
  variants: [{ id: "full", path: "digital-twin/full.md" }],
};

describe("translate", () => {
  test("uses Chinese by default and English when asked", () => {
    expect(translate("zh", "emptyReminders")).toBe("还没有需要跟进的提醒。");
    expect(translate("en", "emptyReminders")).toBe("Nothing needs a follow-up.");
  });

  test("fills placeholders and leaves unknown names alone", () => {
    expect(translate("zh", "results", { count: 3 })).toBe("3 条结果");
    expect(translate("en", "mergeAction", { name: "旅行" })).toBe("Merge into “旅行”");
    expect(translate("zh", "results", {})).toBe("{count} 条结果");
  });
});

describe("uncollectedNotes", () => {
  test("describes what capture leaves out", () => {
    const notes = uncollectedNotes(
      { keepToolCalls: false, includeSubagents: false, redact: true },
      "zh",
    );
    expect(notes).toContain("系统提示词和隐藏推理不会进入原文。");
    expect(notes).toContain("工具调用和 shell 输出不会进入原文。");
    expect(notes).toContain("子代理会话不会采集。");
    expect(notes).toContain("凭证会在上传前脱敏。");
    const english = uncollectedNotes(
      { keepToolCalls: true, includeSubagents: true, redact: false },
      "en",
    );
    expect(english).toContain("Tool calls are kept, but truncated.");
    expect(english).toContain("Redaction is off, so credentials may remain in the original.");
  });
});

describe("validateSettings", () => {
  test("accepts the product defaults", () => {
    expect(validateSettings(validDraft)).toEqual([]);
  });

  test("reports each broken field", () => {
    expect(
      validateSettings({
        ...validDraft,
        idleMinutes: 0,
        activeLimit: 1.5,
        historyDays: -1,
        morningDigestTime: "8am",
        weeklyReviewTime: "25:00",
        consolidateTime: "3:00",
        timezone: "Mars/Base",
        driveRoot: "  ",
        baseUrl: "ftp://files.example",
        variants: [{ id: "", path: "x" }],
      }),
    ).toEqual([
      "invalidIdle",
      "invalidLimit",
      "invalidHistory",
      "invalidTime",
      "invalidTime",
      "invalidTime",
      "invalidZone",
      "invalidRoot",
      "invalidBase",
      "invalidVariant",
    ]);
  });
});

describe("lines", () => {
  test("trims blank lines and joins them back", () => {
    expect(linesToList(" a \n\nb\r\n")).toEqual(["a", "b"]);
    expect(listToLines(["a", "b"])).toBe("a\nb");
  });
});

describe("panel status", () => {
  const calm = {
    drive: { reachable: true as boolean | null },
    refine: { lastError: null as string | null },
    consolidation: { enabled: true, stale: false, status: "ok" as const },
    warnings: [],
  };

  test("lists drive, consolidation, refine, and warning text", () => {
    const status = {
      drive: { reachable: false as boolean | null, accountEmail: "john@example.com" },
      refine: { lastError: "模型没有返回 JSON" },
      consolidation: { enabled: true, stale: true, status: "stale" as const },
      warnings: [{ message: "搜索索引过期" }],
    };
    const problems = panelProblems(status, "zh");
    expect(problems).toEqual([
      "Drive 暂时不可访问",
      "超过一天没有沉淀",
      "模型没有返回 JSON",
      "搜索索引过期",
    ]);
    expect(attentionLevel(status, problems)).toBe("bad");
    expect(attentionLevel(calm, [])).toBe("ok");
    expect(
      attentionLevel(
        { ...calm, consolidation: { enabled: true, stale: true, status: "stale" }, warnings: [{ message: "慢" }] },
        ["慢"],
      ),
    ).toBe("warn");
  });

  test("a signed-out drive is a warning with its own problem line, not a bad state", () => {
    const signedOut = {
      drive: { reachable: false as boolean | null, accountEmail: null as string | null },
      refine: { lastError: null as string | null },
      consolidation: { enabled: true, stale: false, status: "ok" as const },
      warnings: [],
    };
    const problems = panelProblems(signedOut, "zh");
    expect(problems).toEqual(["尚未登录 Google"]);
    expect(attentionLevel(signedOut, problems)).toBe("warn");
    expect(attentionLevel({ ...signedOut, drive: { reachable: false, accountEmail: "john@example.com" } }, [])).toBe("bad");
  });

  test("treats a disabled consolidation role as off, even if stale is set", () => {
    const disabled = {
      drive: { reachable: true as boolean | null },
      refine: { lastError: null as string | null },
      consolidation: {
        enabled: false,
        stale: true,
        status: "disabled" as const,
        lastFinishedAt: null,
      },
      warnings: [],
    };
    expect(consolidationView(disabled.consolidation)).toBe("disabled");
    expect(panelProblems(disabled, "zh")).toEqual([]);
    expect(attentionLevel(disabled, [])).toBe("ok");
    expect(consolidationView({ enabled: true, status: "ok", lastFinishedAt: null })).toBe("idle");
    expect(
      consolidationView({ enabled: true, status: "ok", lastFinishedAt: "2026-10-18T00:00:00.000Z" }),
    ).toBe("ready");
  });
});

describe("sync dot", () => {
  test("follows the sync record, not the rest of the panel", () => {
    expect(syncDot(null)).toBe("muted");
    expect(syncDot({ lastSyncAt: null, pendingOutbox: 3 })).toBe("muted");
    expect(syncDot({ lastSyncAt: "   " })).toBe("muted");
    expect(syncDot({ lastSyncAt: "2026-10-18T16:08:00+08:00", pendingOutbox: 1 })).toBe("ok");
    expect(syncDot({ lastSyncAt: "2026-10-18T16:08:00+08:00", stale: true })).toBe("warn");
    expect(syncDot({ lastSyncAt: "2026-10-18T16:08:00+08:00", expired: true })).toBe("warn");
    expect(syncDot({ lastSyncAt: "2026-10-18T16:08:00+08:00", status: "expired" })).toBe("warn");
    expect(syncDot({ lastSyncAt: "2026-10-18T16:08:00+08:00", lastError: "超时" })).toBe("bad");
    expect(syncDot({ lastSyncAt: "2026-10-18T16:08:00+08:00", error: "失败" })).toBe("bad");
    expect(syncDot({ lastSyncAt: null, failed: true })).toBe("bad");
    expect(syncDot({ lastSyncAt: "2026-10-18T16:08:00+08:00", status: "failed", stale: true })).toBe("bad");
  });
});

describe("status extras", () => {
  test("reads capture rows and logs, skipping junk", () => {
    const payload = {
      captures: [
        { source: "codex", lastCaptureAt: "2026-10-18T01:00:00.000Z", error: null },
        { source: "", lastCaptureAt: "x" },
        { lastCaptureAt: "x" },
        "nope",
      ],
      logs: [{ at: "2026-10-18T01:00:00.000Z", message: "游标过期" }, { message: "  " }, null],
    };
    expect(readCaptures(payload)).toEqual([
      { source: "codex", lastCaptureAt: "2026-10-18T01:00:00.000Z", error: null },
    ]);
    expect(readLogs(payload)).toEqual([
      { at: "2026-10-18T01:00:00.000Z", message: "游标过期" },
    ]);
    expect(readCaptures(null)).toEqual([]);
    expect(readLogs({})).toEqual([]);
  });
});

describe("search view", () => {
  test("surfaces stale and keyword fallback ahead of server warnings", () => {
    const notices = searchNotices(
      {
        indexStatus: "stale",
        searchMode: "keyword",
        warnings: [
          { code: "MODEL_UNAVAILABLE_KEYWORD_FALLBACK", message: "Embedding model is unavailable" },
          { code: "PARTIAL", message: "有一份原文没编进索引" },
        ],
      },
      "zh",
    );
    expect(notices.map((notice) => notice.text)).toEqual([
      "搜索索引已过期，结果可能不全。",
      "语义搜索不可用，已降级为关键词搜索。",
      "Embedding model is unavailable",
      "有一份原文没编进索引",
    ]);
    expect(searchNotices({ indexStatus: "fresh", searchMode: "semantic", warnings: [] }, "en")).toEqual(
      [],
    );
    expect(searchNotices({ indexStatus: "fresh", searchMode: "keyword", warnings: [] }, "zh")).toEqual([]);
  });

  test("uses the first line as a title only when the excerpt continues", () => {
    expect(
      searchTitle({
        excerpt: "事件日志按设备分片。\n合并时按时间排序。",
        source: "claude-code",
        conversationId: "conv-12345678",
      }),
    ).toBe("事件日志按设备分片。");
    expect(
      searchTitle({
        excerpt: "只有一行的长片段，没有单独的标题。",
        source: "codex",
        conversationId: "abcdef123456",
      }),
    ).toBe("codex · abcdef12");
  });
});
