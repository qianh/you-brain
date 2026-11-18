import { describe, expect, it } from "bun:test";

import {
  ActivityMonitor,
  ActivityTracker,
  extractWaitingPrompt,
  type ActivityProc,
  type Tty7ProcsView,
} from "../../src/deck/activity.js";
import type { Tty7Session, Tty7SessionsView } from "../../src/deck/tty7.js";

const MS = 1_000_000;
const shell: ActivityProc = { pid: 1, depth: 0, foreground: false, cpuNs: 0 };
const script = (cpuMs = 0): ActivityProc => ({ pid: 10, depth: 1, foreground: true, cpuNs: cpuMs * MS });
const agentProc = (cpuMs: number): ActivityProc => ({ pid: 20, depth: 1, foreground: true, cpuNs: cpuMs * MS });

describe("ActivityTracker · 普通脚本", () => {
  it("前台有脚本且没回到提示符：连续 3 秒后才显示 working", () => {
    const tracker = new ActivityTracker();
    const input = { agent: false, atPrompt: false, procs: [shell, script()] };
    tracker.observe(1, input, 0);
    expect(tracker.status(1, 0)).toBeNull();
    tracker.observe(1, input, 3_000);
    expect(tracker.status(1, 3_000)).toBe("working");
  });

  it("跑了 10 秒以上回到提示符：给 done，保留 2 分钟", () => {
    const tracker = new ActivityTracker();
    tracker.observe(1, { agent: false, atPrompt: false, procs: [shell, script()] }, 0);
    tracker.observe(1, { agent: false, atPrompt: false, procs: [shell, script()] }, 9_000);
    tracker.observe(1, { agent: false, atPrompt: true, procs: [shell] }, 12_000);
    expect(tracker.status(1, 12_000)).toBe("done");
    expect(tracker.status(1, 12_000 + 119_000)).toBe("done");
    expect(tracker.status(1, 12_000 + 121_000)).toBeNull();
  });

  it("短命令（不到 10 秒）结束后不给 done", () => {
    const tracker = new ActivityTracker();
    tracker.observe(1, { agent: false, atPrompt: false, procs: [shell, script()] }, 0);
    tracker.observe(1, { agent: false, atPrompt: false, procs: [shell, script()] }, 3_000);
    tracker.observe(1, { agent: false, atPrompt: true, procs: [shell] }, 6_000);
    expect(tracker.status(1, 6_000)).toBeNull();
  });

  it("脚本在等待（CPU 不涨）也仍然算执行中", () => {
    const tracker = new ActivityTracker();
    for (let at = 0; at <= 60_000; at += 3_000) {
      tracker.observe(1, { agent: false, atPrompt: false, procs: [shell, script(5)] }, at);
    }
    expect(tracker.status(1, 60_000)).toBe("working");
  });
});

describe("ActivityTracker · AI CLI", () => {
  it("停在输入框（CPU 几乎不涨）不算执行", () => {
    const tracker = new ActivityTracker();
    for (let i = 0; i < 10; i += 1) {
      tracker.observe(1, { agent: true, atPrompt: false, procs: [shell, agentProc(27_000 + i * 6)] }, i * 3_000);
    }
    expect(tracker.status(1, 27_000)).toBeNull();
  });

  it("CPU 持续上涨算 working；停涨超过 8 秒才结束并给 done", () => {
    const tracker = new ActivityTracker();
    let cpu = 1_000;
    tracker.observe(1, { agent: true, atPrompt: false, procs: [shell, agentProc(cpu)] }, 0);
    for (let at = 3_000; at <= 15_000; at += 3_000) {
      cpu += 300;
      tracker.observe(1, { agent: true, atPrompt: false, procs: [shell, agentProc(cpu)] }, at);
    }
    expect(tracker.status(1, 15_000)).toBe("working");
    // 停涨 6 秒：还在容忍范围内（模型思考、等网络）
    tracker.observe(1, { agent: true, atPrompt: false, procs: [shell, agentProc(cpu)] }, 18_000);
    tracker.observe(1, { agent: true, atPrompt: false, procs: [shell, agentProc(cpu)] }, 21_000);
    expect(tracker.status(1, 21_000)).toBe("working");
    // 停涨满 8 秒
    tracker.observe(1, { agent: true, atPrompt: false, procs: [shell, agentProc(cpu)] }, 24_000);
    expect(tracker.status(1, 24_000)).toBe("done");
  });

  it("第一次采样只建基线，不算动静", () => {
    const tracker = new ActivityTracker();
    tracker.observe(1, { agent: true, atPrompt: false, procs: [shell, agentProc(50_000)] }, 0);
    tracker.observe(1, { agent: true, atPrompt: false, procs: [shell, agentProc(50_005)] }, 3_000);
    expect(tracker.status(1, 3_000)).toBeNull();
  });

  it("retain 丢掉已经不存在的会话", () => {
    const tracker = new ActivityTracker();
    tracker.observe(1, { agent: false, atPrompt: false, procs: [shell, script()] }, 0);
    tracker.observe(1, { agent: false, atPrompt: false, procs: [shell, script()] }, 4_000);
    expect(tracker.status(1, 4_000)).toBe("working");
    tracker.retain(new Set([2]));
    expect(tracker.status(1, 4_000)).toBeNull();
  });
});

function session(pane: number, extra: Partial<Tty7Session> = {}): Tty7Session {
  return {
    pane, workspaceId: "w", workspaceName: "w", tabId: `t${pane}`, tabLabel: null, agent: null,
    cwd: "/x", hibernated: false, status: null, statusMessage: null, model: null, ...extra,
  };
}
const view = (sessions: Tty7Session[]): Tty7SessionsView =>
  ({ available: true, detail: "", workspaces: [], sessions, harnesses: [], appearance: null });

describe("ActivityMonitor", () => {
  it("只给没有 hooks 状态、没休眠的会话采样；状态变化时通知", async () => {
    let now = 0;
    const sampled: number[] = [];
    let changes = 0;
    let busy = true;
    const monitor = new ActivityMonitor({
      sessions: async () => view([session(1), session(2, { status: "working" }), session(3, { hibernated: true })]),
      procs: async (pane): Promise<Tty7ProcsView> => {
        sampled.push(pane);
        return busy ? { atPrompt: false, procs: [shell, script()] } : { atPrompt: true, procs: [shell] };
      },
      onChange: () => { changes += 1; },
      now: () => now,
    });
    await monitor.tick();
    expect(sampled).toEqual([1]);
    expect(monitor.status(1)).toBeNull();
    now = 3_000;
    await monitor.tick();
    expect(monitor.status(1)).toBe("working");
    expect(changes).toBe(1);
    now = 12_000;
    busy = false;
    await monitor.tick();
    expect(monitor.status(1)).toBe("done");
    expect(changes).toBe(2);
  });

  it("采样失败时保留上一次判断，不抛错", async () => {
    let now = 0;
    let fail = false;
    const monitor = new ActivityMonitor({
      sessions: async () => view([session(1)]),
      procs: async () => {
        if (fail) throw new Error("boom");
        return { atPrompt: false, procs: [shell, script()] };
      },
      onChange: () => undefined,
      now: () => now,
    });
    await monitor.tick();
    now = 4_000;
    await monitor.tick();
    expect(monitor.status(1)).toBe("working");
    fail = true;
    now = 7_000;
    await monitor.tick();
    expect(monitor.status(1)).toBe("working");
  });

  it("普通脚本静默满 6 秒且屏幕出现交互提示时判为 waiting，继续跑或回到提示符后自动恢复", async () => {
    let now = 0;
    let cpuMs = 5;
    let atPrompt = false;
    let screenText = "Building step 1...\n确认发布到生产环境吗？ [y/N]";
    let screenReads = 0;
    const monitor = new ActivityMonitor({
      sessions: async () => view([session(1)]),
      procs: async () => (atPrompt ? { atPrompt: true, procs: [shell] } : { atPrompt: false, procs: [shell, script(cpuMs)] }),
      screen: async () => {
        screenReads += 1;
        return screenText;
      },
      onChange: () => undefined,
      now: () => now,
    });
    await monitor.tick(); // t=0 基线
    now = 3_000;
    await monitor.tick(); // t=3s 先进入 working
    expect(monitor.detail(1)).toEqual({ status: "working", message: null });
    expect(screenReads).toBe(0);

    now = 6_000;
    await monitor.tick(); // t=6s 静默满 6s，读一次屏幕识别出提问
    expect(screenReads).toBe(1);
    expect(monitor.detail(1)).toEqual({ status: "waiting", message: "确认发布到生产环境吗？ [y/N]" });

    // 用户回复后脚本恢复消耗 CPU：立即回到 working
    now = 9_000;
    cpuMs += 100;
    await monitor.tick();
    expect(monitor.detail(1)).toEqual({ status: "working", message: null });

    // 脚本跑满 10s 后回到提示符：变成 done
    now = 12_000;
    atPrompt = true;
    await monitor.tick();
    expect(monitor.detail(1)).toEqual({ status: "done", message: null });
  });

  it("未装 hooks 的 AI CLI 停涨后，若屏幕末尾是确认提示则给 waiting 而不是 done", async () => {
    let now = 0;
    let cpuMs = 100;
    const screenText = "? Allow running rm -rf dist?\n❯ Yes\n  No";
    const monitor = new ActivityMonitor({
      sessions: async () => view([session(1, { agent: "Gemini" })]),
      procs: async () => ({ atPrompt: false, procs: [shell, agentProc(cpuMs)] }),
      screen: async () => screenText,
      onChange: () => undefined,
      now: () => now,
    });
    await monitor.tick();
    now = 3_000;
    cpuMs += 300;
    await monitor.tick();
    now = 6_000;
    cpuMs += 300;
    await monitor.tick();
    expect(monitor.status(1)).toBe("working");

    // 停涨满 8 秒后触发屏幕检测，判为 waiting
    now = 14_000;
    await monitor.tick();
    expect(monitor.detail(1)).toEqual({ status: "waiting", message: "Allow running rm -rf dist?" });
  });
});

describe("extractWaitingPrompt", () => {
  it("识别常见确认、密码、按键及菜单提问，忽略普通输出和省略号进度", () => {
    expect(extractWaitingPrompt("Downloading...\nContinue? [y/N] ")).toBe("Continue? [y/N]");
    expect(extractWaitingPrompt("[sudo] password for hong:")).toBe("[sudo] password for hong:");
    expect(extractWaitingPrompt("请输入环境口令：")).toBe("请输入环境口令：");
    expect(extractWaitingPrompt("完成检查，按回车继续")).toBe("完成检查，按回车继续");
    expect(extractWaitingPrompt("Overwrite existing config.json?")).toBe("Overwrite existing config.json?");
    expect(extractWaitingPrompt("◆ 选择部署环境:\n● Production\n○ Staging")).toBe("选择部署环境:");
    expect(extractWaitingPrompt("Compiling 12/48 modules...")).toBeNull();
    expect(extractWaitingPrompt("https://example.com/api?foo=bar")).toBeNull();
    expect(extractWaitingPrompt("All 42 tests passed in 1.2s")).toBeNull();
  });
});
