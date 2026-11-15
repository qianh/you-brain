import { describe, expect, it } from "bun:test";

import { initialDeckView, sessionTitle, waitingCount, type Session } from "../../src/pages/deck-tty7-sessions.js";

const make = (patch: Partial<Session>): Session => ({ pane: 1, cwd: "", tabLabel: null, status: null, ...patch }) as Session;

describe("deck-tty7-sessions", () => {
  it("waitingCount 只数等待中的会话", () => {
    const list = [make({ status: "waiting" }), make({ status: "done" }), make({ status: null }), make({ status: "waiting" })];
    expect(waitingCount(list)).toBe(2);
    expect(waitingCount([])).toBe(0);
  });

  it("sessionTitle 依次取标签名、目录名、pane 编号", () => {
    expect(sessionTitle(make({ tabLabel: "标签", cwd: "/a/b" }))).toBe("标签");
    expect(sessionTitle(make({ cwd: "/a/proj/" }))).toBe("proj");
    expect(sessionTitle(make({ pane: 7 }))).toBe("%7");
  });

  it("initialDeckView 首次使用默认 T3", () => {
    expect(initialDeckView(null)).toBe("t3");
    expect(initialDeckView("dsh")).toBe("dsh");
    expect(initialDeckView("t3")).toBe("t3");
  });
});
