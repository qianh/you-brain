import { describe, expect, it } from "bun:test";

import { initialDeckView, resolveOpenRequest, sessionTitle, waitingCount, type Session } from "../../src/pages/deck-tty7-sessions.js";

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

  it("initialDeckView 首次使用默认 T3，记住 dsh 或 muse", () => {
    expect(initialDeckView(null)).toBe("t3");
    expect(initialDeckView("dsh")).toBe("dsh");
    expect(initialDeckView("muse")).toBe("muse");
    expect(initialDeckView("t3")).toBe("t3");
  });

  describe("resolveOpenRequest", () => {
    const request = { pane: 9, workspaceId: "w", tabId: "t" } as never;
    const target = make({ pane: 9, workspaceId: "w", tabId: "t" } as Partial<Session>);
    const view = (sessions: Session[]) => ({ available: true, sessions }) as never;

    it("只用请求到达之后重新加载的列表定位，不用旧列表", async () => {
      // 旧列表（已在内存里）不含目标；新加载的列表含目标。
      let loaded = false;
      const reload = async () => { loaded = true; return view([target]); };
      const result = await resolveOpenRequest(request, reload);
      expect(loaded).toBe(true);
      expect(result).toEqual({ pane: 9, missing: false });
    });

    it("新列表里确实没有目标才算缺失", async () => {
      expect(await resolveOpenRequest(request, async () => view([make({ pane: 1 })]))).toEqual({ pane: null, missing: true });
    });

    it("加载失败时不报缺失（错误由列表自己的错误提示显示）", async () => {
      expect(await resolveOpenRequest(request, async () => null)).toEqual({ pane: null, missing: false });
    });
  });
});
