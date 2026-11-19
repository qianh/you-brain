import { EventEmitter } from "node:events";
import { describe, expect, it } from "bun:test";

import { SessionNoticeWatcher, diffNotices, sessionTitle } from "../../src/deck/session-notices.js";
import { Tty7, type Tty7AgentStatus, type Tty7Session, type Tty7SessionsView } from "../../src/deck/tty7.js";

function session(pane: number, status: Tty7AgentStatus | null, extra: Partial<Tty7Session> = {}): Tty7Session {
  return {
    pane,
    workspaceId: "ws",
    workspaceName: "ws",
    tabId: `t${pane}`,
    tabLabel: null,
    agent: "Claude",
    cwd: `/Users/x/dir${pane}`,
    hibernated: false,
    status,
    statusMessage: null,
    model: null,
    ...extra,
  };
}

function view(sessions: Tty7Session[], available = true): Tty7SessionsView {
  return { available, detail: "", workspaces: [], sessions, harnesses: [], appearance: null };
}

const snap = (...entries: Array<[number, string | null]>) => new Map(entries);

describe("sessionTitle", () => {
  it("prefers the tab label, then the directory name, then %pane", () => {
    expect(sessionTitle(session(1, null, { tabLabel: "账本回测" }))).toBe("账本回测");
    expect(sessionTitle(session(1, null, { cwd: "/Users/x/Downloads/" }))).toBe("Downloads");
    expect(sessionTitle(session(46, null, { cwd: "" }))).toBe("%46");
  });
});

describe("diffNotices", () => {
  it("makes no notice on the first snapshot", () => {
    expect(diffNotices(null, [session(1, "waiting")], null)).toEqual([]);
  });

  it("notices working -> waiting and working -> done with title and body", () => {
    const result = diffNotices(
      snap([1, "working"], [2, "working"]),
      [
        session(1, "waiting", { tabLabel: "账本回测", statusMessage: "要删除 3 个重复文件吗？" }),
        session(2, "done", { cwd: "/Users/x/Downloads" }),
      ],
      null,
    );
    expect(result).toEqual([
      {
        pane: 1,
        kind: "waiting",
        sessionName: "账本回测",
        agent: "Claude",
        cwd: "/Users/x/dir1",
        title: "账本回测 在等你回复",
        body: "要删除 3 个重复文件吗？",
      },
      {
        pane: 2,
        kind: "done",
        sessionName: "Downloads",
        agent: "Claude",
        cwd: "/Users/x/Downloads",
        title: "Downloads 已完成",
        body: "",
      },
    ]);
  });

  it("does not repeat when the status is unchanged", () => {
    expect(diffNotices(snap([1, "waiting"]), [session(1, "waiting")], null)).toEqual([]);
    expect(diffNotices(snap([1, "working"]), [session(1, "working")], null)).toEqual([]);
  });

  it("ignores idle -> done, waiting -> done, and sessions that just appeared", () => {
    expect(diffNotices(snap([1, "idle"]), [session(1, "done")], null)).toEqual([]);
    expect(diffNotices(snap([1, "waiting"]), [session(1, "done")], null)).toEqual([]);
    expect(diffNotices(snap(), [session(1, "done")], null)).toEqual([]);
  });

  it("skips the session being viewed", () => {
    expect(diffNotices(snap([1, "working"], [2, "working"]), [session(1, "done"), session(2, "done")], 1).map((n) => n.pane)).toEqual([2]);
  });

  it("skips sessions with no status", () => {
    expect(diffNotices(snap([1, null]), [session(1, null)], null)).toEqual([]);
    expect(diffNotices(snap([1, "working"]), [session(1, null)], null)).toEqual([]);
  });
});

/** 可控的 watcher：手动推进时钟、手动触发事件行。 */
function harness(
  options: {
    enabled?: () => boolean;
    pollMs?: number;
    summarize?: (draft: { pane: number; body: string }) => Promise<{ task: string | null; body: string } | null>;
    summarizeTimeoutMs?: number;
  } = {},
) {
  let nowMs = 1_000_000;
  let current: Tty7SessionsView | Error = view([session(1, "working")]);
  let lineListener: (() => void) | null = null;
  let unsubscribed = 0;
  let reads = 0;
  let notices = 0;
  const watcher = new SessionNoticeWatcher({
    sessions: async () => {
      reads += 1;
      if (current instanceof Error) throw current;
      return current;
    },
    subscribe: (onLine) => {
      lineListener = onLine;
      return () => {
        unsubscribed += 1;
        lineListener = null;
      };
    },
    enabled: async () => (options.enabled ?? (() => true))(),
    onNotice: () => {
      notices += 1;
    },
    now: () => nowMs,
    pollMs: options.pollMs ?? 60_000,
    debounceMs: 10,
    ...(options.summarize === undefined ? {} : { summarize: options.summarize }),
    ...(options.summarizeTimeoutMs === undefined ? {} : { summarizeTimeoutMs: options.summarizeTimeoutMs }),
  });
  return {
    watcher,
    set: (next: Tty7SessionsView | Error) => {
      current = next;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    line: () => lineListener?.(),
    reads: () => reads,
    notices: () => notices,
    unsubscribed: () => unsubscribed,
  };
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SessionNoticeWatcher", () => {
  it("reads once after an event line (debounced) and calls onNotice", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    expect(h.reads()).toBe(1); // 启动时的基线
    h.set(view([session(1, "waiting", { statusMessage: "继续吗？" })]));
    h.line();
    h.line();
    h.line();
    await settle();
    expect(h.reads()).toBe(2);
    expect(h.notices()).toBe(1);
    const list = h.watcher.list();
    expect(list.latest).toBe(1);
    expect(list.notices).toHaveLength(1);
    expect(list.notices[0]).toMatchObject({ seq: 1, pane: 1, kind: "waiting", body: "继续吗？" });
    expect(list.epoch).not.toBe("");
    h.watcher.stop();
  });

  it("waits for the summary and uses it as the body", async () => {
    let release: (value: { task: string | null; body: string } | null) => void = () => undefined;
    const h = harness({
      summarize: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    h.watcher.start();
    await settle();
    h.set(view([session(1, "done", { statusMessage: "raw" })]));
    h.line();
    await settle();
    expect(h.watcher.list().notices).toHaveLength(0);
    release({ task: "打包安装", body: "已完成打包安装，签名校验通过；建议打开 App 确认新版本。" });
    await settle();
    expect(h.watcher.list().notices[0]).toMatchObject({
      pane: 1,
      kind: "done",
      task: "打包安装",
      title: "打包安装 已完成",
      body: "已完成打包安装，签名校验通过；建议打开 App 确认新版本。",
    });
    expect(h.watcher.taskOf(1)).toBe("打包安装");
    expect(h.watcher.taskOf(2)).toBeNull();
    expect(h.notices()).toBe(1);
    h.watcher.stop();
  });

  it("falls back to the session status when the summary fails or times out", async () => {
    const failing = harness({ summarize: async () => Promise.reject(new Error("down")) });
    failing.watcher.start();
    await settle();
    failing.set(view([session(1, "waiting", { statusMessage: "继续吗？" })]));
    failing.line();
    await settle();
    expect(failing.watcher.list().notices[0]).toMatchObject({ body: "继续吗？" });
    failing.watcher.stop();

    const slow = harness({ summarize: () => new Promise(() => undefined), summarizeTimeoutMs: 20 });
    slow.watcher.start();
    await settle();
    slow.set(view([session(1, "waiting", { statusMessage: "继续吗？" })]));
    slow.line();
    await settle(80);
    expect(slow.watcher.list().notices[0]).toMatchObject({ body: "继续吗？" });
    slow.watcher.stop();
  });

  it("drops the notice when the session moves on before the summary is ready", async () => {
    let release: (value: { task: string | null; body: string } | null) => void = () => undefined;
    const h = harness({
      summarize: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    h.watcher.start();
    await settle();
    h.set(view([session(1, "waiting")]));
    h.line();
    await settle();
    h.set(view([session(1, "working")]));
    h.line();
    await settle();
    release({ task: null, body: "它在问是否继续" });
    await settle();
    expect(h.watcher.list().notices).toHaveLength(0);
    h.watcher.stop();
  });

  it("expires the viewed session after 15 seconds", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    h.watcher.setViewing(1);
    h.advance(14_000);
    h.set(view([session(1, "done")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices).toEqual([]); // 还在看

    h.set(view([session(1, "working")]));
    h.line();
    await settle();
    h.advance(16_000); // 上报已过期
    h.set(view([session(1, "done")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices.map((n) => n.kind)).toEqual(["done"]);
    h.watcher.stop();
  });

  it("makes no notice while disabled and does not replay changes after re-enabling", async () => {
    let on = false;
    const h = harness({ enabled: () => on });
    h.watcher.start();
    await settle();
    h.set(view([session(1, "done")])); // 关闭期间的变化
    h.line();
    await settle();
    expect(h.watcher.list().notices).toEqual([]);
    on = true;
    h.set(view([session(1, "done")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices).toEqual([]);
    h.set(view([session(1, "working")]));
    h.line();
    await settle();
    h.set(view([session(1, "waiting")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices.map((n) => n.kind)).toEqual(["waiting"]);
    h.watcher.stop();
  });

  it("survives a failing read and keeps the previous snapshot", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    h.set(new Error("tty7 down"));
    h.line();
    await settle();
    expect(h.watcher.list().notices).toEqual([]);
    h.set(view([session(1, "done")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices.map((n) => n.kind)).toEqual(["done"]);
    h.watcher.stop();
  });

  it("does not use an unavailable (empty) view as the baseline", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    h.set(view([], false));
    h.line();
    await settle();
    h.set(view([session(1, "done")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices.map((n) => n.kind)).toEqual(["done"]);
    h.watcher.stop();
  });

  it("keeps only the latest 50 notices with increasing seq", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    for (let i = 0; i < 55; i += 1) {
      h.set(view([session(1, "working")]));
      h.line();
      await settle(25);
      h.set(view([session(1, "done")]));
      h.line();
      await settle(25);
    }
    const list = h.watcher.list();
    expect(list.latest).toBe(55);
    expect(list.notices).toHaveLength(50);
    expect(list.notices[0]?.seq).toBe(6);
    expect(list.notices[49]?.seq).toBe(55);
    h.watcher.stop();
  });

  it("also polls on its own as a fallback", async () => {
    const h = harness({ pollMs: 20 });
    h.watcher.start();
    await settle(30);
    h.set(view([session(1, "done")]));
    await settle(60);
    expect(h.watcher.list().notices.map((n) => n.kind)).toEqual(["done"]);
    h.watcher.stop();
  });

  it("stop() unsubscribes and ends polling", async () => {
    const h = harness({ pollMs: 20 });
    h.watcher.start();
    await settle(30);
    h.watcher.stop();
    expect(h.unsubscribed()).toBe(1);
    const before = h.reads();
    await settle(80);
    expect(h.reads()).toBe(before);
  });

  it("marks notices open on creation, auto-closes stale waiting/replaced notices, keeps done on idle, and supports dismiss", async () => {
    const h = harness();
    h.watcher.start();
    await settle();

    // working -> waiting：open
    h.set(view([session(1, "waiting", { statusMessage: "继续吗？" })]));
    h.line();
    await settle();
    expect(h.watcher.list().notices).toMatchObject([{ seq: 1, pane: 1, kind: "waiting", status: "open" }]);

    // 用户在 tty7 直接回复，会话变回 working：旧 waiting 自动关成 closed
    h.set(view([session(1, "working")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices).toMatchObject([{ seq: 1, pane: 1, kind: "waiting", status: "closed" }]);

    // 跑完变成 done：新条目 open；即使过一会儿回落到 null（idle），done 仍保持 open 等用户确认
    h.set(view([session(1, "done")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices.map((n) => [n.seq, n.status])).toEqual([
      [1, "closed"],
      [2, "open"],
    ]);
    h.set(view([session(1, null)]));
    h.line();
    await settle();
    expect(h.watcher.list().notices[1]?.status).toBe("open");

    // 弹框确认关闭
    expect(h.watcher.dismiss({ seq: 2 })).toBe(true);
    expect(h.watcher.list().notices[1]?.status).toBe("closed");
    expect(h.watcher.dismiss({ seq: 2 })).toBe(false);
    h.watcher.stop();
  });

  it("closes open notices when setViewing focuses that pane", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    h.set(view([session(1, "done")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices[0]?.status).toBe("open");
    h.watcher.setViewing(1);
    expect(h.watcher.list().notices[0]?.status).toBe("closed");
    h.watcher.stop();
  });

  it("忽略（mute）后这个会话不再提醒，别的会话照常；会话关闭后解除", async () => {
    const h = harness();
    h.set(view([session(1, "working"), session(2, "working")]));
    h.watcher.start();
    await settle();
    h.set(view([session(1, "done"), session(2, "working")]));
    h.line();
    await settle();
    expect(h.watcher.dismiss({ seq: 1, mute: true })).toBe(true);
    expect(h.watcher.list().notices[0]?.status).toBe("closed");

    // 会话 1 又跑了一轮：不再提醒；会话 2 跑完照常提醒。
    h.set(view([session(1, "working"), session(2, "working")]));
    h.line();
    await settle();
    h.set(view([session(1, "done"), session(2, "done")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices.map((n) => [n.pane, n.status])).toEqual([
      [1, "closed"],
      [2, "open"],
    ]);

    // 会话 1 关闭后，同一个编号的新会话照常提醒。
    h.set(view([session(2, "done")]));
    h.line();
    await settle();
    h.set(view([session(1, "working"), session(2, "done")]));
    h.line();
    await settle();
    h.set(view([session(1, "done"), session(2, "done")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices.filter((n) => n.pane === 1 && n.status === "open")).toHaveLength(1);
    h.watcher.stop();
  });

  it("只确认（不 mute）时，同一会话下次跑完仍提醒", async () => {
    const h = harness();
    h.watcher.start();
    await settle();
    h.set(view([session(1, "done")]));
    h.line();
    await settle();
    h.watcher.dismiss({ seq: 1 });
    h.set(view([session(1, "working")]));
    h.line();
    await settle();
    h.set(view([session(1, "done")]));
    h.line();
    await settle();
    expect(h.watcher.list().notices.map((n) => n.status)).toEqual(["closed", "open"]);
    h.watcher.stop();
  });
});

/** 假的事件流进程。 */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding(): void };
    killed: string | null;
    kill(signal?: string): void;
    unref(): void;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.killed = null;
  child.kill = (signal) => {
    child.killed = signal ?? "SIGTERM";
  };
  child.unref = () => {};
  return child;
}

describe("Tty7.events", () => {
  it("does not spawn or retry when tty7 cannot be found", async () => {
    let spawned = 0;
    const tty7 = new Tty7({
      locate: async () => null,
      spawnEvents: () => {
        spawned += 1;
        return fakeChild() as never;
      },
      eventsRestartMs: 5,
    });
    const stop = tty7.events(() => {});
    await settle(40);
    expect(spawned).toBe(0);
    stop();
  });

  it("calls onLine once per non-empty line, even when chunks split lines", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const tty7 = new Tty7({
      locate: async () => "/bin/tty7",
      spawnEvents: (_binary, args) => {
        expect(args).toEqual(["events", "--json"]);
        const child = fakeChild();
        children.push(child);
        return child as never;
      },
    });
    let lines = 0;
    const stop = tty7.events(() => {
      lines += 1;
    });
    await settle();
    children[0]?.stdout.emit("data", '{"a":1}\n{"b"');
    children[0]?.stdout.emit("data", ":2}\n\n");
    expect(lines).toBe(2);
    stop();
  });

  it("restarts after the process exits, and stop() kills it and prevents restarts", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const tty7 = new Tty7({
      locate: async () => "/bin/tty7",
      spawnEvents: () => {
        const child = fakeChild();
        children.push(child);
        return child as never;
      },
      eventsRestartMs: 10,
    });
    const stop = tty7.events(() => {});
    await settle();
    expect(children).toHaveLength(1);
    children[0]?.emit("close", 1);
    await settle(50);
    expect(children).toHaveLength(2);
    stop();
    expect(children[1]?.killed).toBe("SIGTERM");
    children[1]?.emit("close", null);
    await settle(50);
    expect(children).toHaveLength(2);
  });
});
