import { describe, expect, test } from "bun:test";

import {
  countUnrefinedWebSessions,
  isWebInboxPath,
  isWebSessionIdle,
  listWebInbox,
  pendingWebSessions,
  rememberWebInbox,
  type WebInboxCursorStore,
} from "../../src/web-sessions/index.js";

function memoryCursors(initial?: Record<string, string>): WebInboxCursorStore & { writes: number } {
  const values = new Map(Object.entries(initial ?? {}));
  const store = {
    writes: 0,
    getCursor(key: string) {
      return values.get(key) ?? null;
    },
    setCursor(key: string, value: string) {
      store.writes += 1;
      values.set(key, value);
    },
    listCursors(prefix: string) {
      return [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value }));
    },
  };
  return store;
}

describe("web inbox index", () => {
  test("records only inbox/web- paths and skips a repeat of the same file", () => {
    expect(isWebInboxPath("inbox/web-chrome/a.md")).toBe(true);
    expect(isWebInboxPath("inbox/web-")).toBe(true);
    expect(isWebInboxPath("inbox/laptop/a.md")).toBe(false);
    expect(isWebInboxPath("inbox/web/a.md")).toBe(false);

    const cursors = memoryCursors();
    expect(rememberWebInbox(cursors, "aaa", { fileId: "file-1", path: "inbox/web-chrome/a.md" })).toBe(true);
    expect(rememberWebInbox(cursors, "aaa", { fileId: "file-1", path: "inbox/web-chrome/a.md" })).toBe(false);
    expect(cursors.writes).toBe(1);
    expect(listWebInbox(cursors)).toEqual([
      { sessionKey: "aaa", fileId: "file-1", path: "inbox/web-chrome/a.md" },
    ]);
    expect(rememberWebInbox(cursors, "aaa", { fileId: "file-2", path: "inbox/web-chrome/a.md" })).toBe(true);
    expect(cursors.writes).toBe(2);
  });

  test("skips malformed cursor rows", () => {
    const cursors = memoryCursors({
      "webinbox:": JSON.stringify({ fileId: "file-1", path: "inbox/web-chrome/a.md" }),
      "webinbox:good": JSON.stringify({ fileId: "file-2", path: "inbox/web-chrome/b.md" }),
      "webinbox:bad": "{",
      "webinbox:empty": JSON.stringify({ fileId: "", path: "inbox/web-chrome/c.md" }),
      "other:nope": JSON.stringify({ fileId: "file-9", path: "inbox/laptop/a.md" }),
    });
    expect(listWebInbox(cursors)).toEqual([
      { sessionKey: "good", fileId: "file-2", path: "inbox/web-chrome/b.md" },
    ]);
  });

  test("selects idle unrefined sessions oldest first and counts without the idle filter", () => {
    const now = Date.parse("2026-10-18T02:00:00.000Z");
    const idleMs = 5 * 60_000;
    const indexed = [
      { sessionKey: "new", fileId: "f-new", path: "inbox/web-chrome/new.md" },
      { sessionKey: "old", fileId: "f-old", path: "inbox/web-chrome/old.md" },
      { sessionKey: "busy", fileId: "f-busy", path: "inbox/web-chrome/busy.md" },
      { sessionKey: "done", fileId: "f-done", path: "inbox/web-chrome/done.md" },
      { sessionKey: "blocked", fileId: "f-blocked", path: "inbox/web-chrome/blocked.md" },
      { sessionKey: "missing", fileId: "f-missing", path: "inbox/web-chrome/missing.md" },
    ];
    const sessions = [
      { sessionKey: "new", updatedAt: "2026-10-18T01:50:00.000Z", refinedUpTo: 0, msgCount: 2 },
      { sessionKey: "old", updatedAt: "2026-10-18T01:40:00.000Z", refinedUpTo: 1, msgCount: 2 },
      { sessionKey: "busy", updatedAt: "2026-10-18T01:58:00.000Z", refinedUpTo: 0, msgCount: 1 },
      { sessionKey: "done", updatedAt: "2026-10-18T01:00:00.000Z", refinedUpTo: 2, msgCount: 2 },
      { sessionKey: "blocked", updatedAt: "2026-10-18T01:00:00.000Z", refinedUpTo: 0, msgCount: 1 },
    ];
    expect(isWebSessionIdle("2026-10-18T01:55:00.000Z", now, idleMs)).toBe(true);
    expect(isWebSessionIdle("2026-10-18T01:55:00.001Z", now, idleMs)).toBe(false);
    expect(isWebSessionIdle(null, now, idleMs)).toBe(false);
    expect(
      pendingWebSessions({
        indexed,
        sessions,
        nowMs: now,
        idleMs,
        blocked: (key) => key === "blocked",
      }).map((row) => row.sessionKey),
    ).toEqual(["old", "new"]);
    expect(countUnrefinedWebSessions(indexed, sessions)).toBe(4);
  });
});
