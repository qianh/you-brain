import { describe, expect, it } from "bun:test";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Tty7, type Tty7RunOptions } from "../../src/deck/tty7.js";

interface Call {
  args: string[];
  stdin?: string;
}

/** 假的 tty7：按命令前缀返回预置的 JSON，并记下每次调用。 */
function fake(replies: Record<string, unknown | (() => unknown)>, configDir?: string) {
  const calls: Call[] = [];
  const runner = async (args: string[], options?: Tty7RunOptions): Promise<string> => {
    calls.push({ args, ...(options?.stdin === undefined ? {} : { stdin: options.stdin }) });
    const key = Object.keys(replies)
      .filter((prefix) => args.join(" ").startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`unexpected: ${args.join(" ")}`);
    const reply = replies[key];
    return JSON.stringify(typeof reply === "function" ? (reply as () => unknown)() : reply);
  };
  const tty7 = new Tty7({ runner, configDir: configDir ?? "/nonexistent-tty7-config", sleep: async () => undefined, dirExists: async (path) => path !== "/missing" });
  return { tty7, calls };
}

const WORKSPACES = {
  workspaces: [
    { id: "ws-a", name: "John", attached: "mac.local" },
    { id: "ws-b", name: null, attached: null },
  ],
};

describe("Tty7.sessions", () => {
  it("joins panes with their tab label and agent, and skips dead panes", async () => {
    const { tty7 } = fake({
      "ws ls": WORKSPACES,
      "pane ls": {
        panes: [
          { pane: 7, workspace: "ws-a", tab: "t1", cwd: "/repo/a", live: true, hibernated: false },
          { pane: 8, workspace: "ws-a", tab: "t1", cwd: "/repo/a", live: false, hibernated: false },
          { pane: 9, workspace: "ws-b", tab: "t2", cwd: null, live: true, hibernated: true },
        ],
      },
      agents: {
        agents: [
          { pane_id: 7, agent: "Claude", state: { status: "waiting", message: "要不要执行 rm？", readout: { model: "opus" } } },
          { pane_id: 9, agent: "Codex", state: { status: "bogus" } },
        ],
      },
      "tab ls ws-a": { tabs: [{ id: "t1", name: null, label: "修登录", agent: "Codex", panes: [7, 8] }] },
      "tab ls ws-b": { tabs: [{ id: "t2", name: "手动命名", label: "tmp", agent: null, panes: [9] }] },
    });
    const view = await tty7.sessions();
    expect(view.available).toBe(true);
    expect(view.workspaces).toEqual([
      { id: "ws-a", name: "John", attached: true },
      { id: "ws-b", name: "ws-b", attached: false },
    ]);
    expect(view.sessions).toEqual([
      { pane: 7, workspaceId: "ws-a", workspaceName: "John", tabId: "t1", tabLabel: "修登录", agent: "Claude", cwd: "/repo/a", hibernated: false, status: "waiting", statusMessage: "要不要执行 rm？", model: "opus" },
      { pane: 9, workspaceId: "ws-b", workspaceName: "ws-b", tabId: "t2", tabLabel: "手动命名", agent: "Codex", cwd: "", hibernated: true, status: null, statusMessage: null, model: null },
    ]);
    expect(view.harnesses.map((item) => item.id)).toContain("claude");
  });

  it("still lists sessions when agent status cannot be read", async () => {
    const { tty7 } = fake({
      "ws ls": { workspaces: [{ id: "ws-a", name: "John", attached: null }] },
      "pane ls": { panes: [{ pane: 7, workspace: "ws-a", tab: "t1", cwd: "/repo/a", live: true, hibernated: false }] },
      "tab ls ws-a": { tabs: [{ id: "t1", name: null, label: "a", agent: "Codex", panes: [7] }] },
    });
    const view = await tty7.sessions();
    expect(view.available).toBe(true);
    expect(view.sessions[0]).toMatchObject({ pane: 7, agent: "Codex", status: null });
  });

  it("reports unavailable instead of throwing when the server is down", async () => {
    const tty7 = new Tty7({
      runner: async () => {
        throw new Error("could not reach the tty7 server");
      },
    });
    const view = await tty7.sessions();
    expect(view.available).toBe(false);
    expect(view.detail).toContain("could not reach");
    expect(view.sessions).toEqual([]);
  });
});

describe("Tty7.send", () => {
  it("pastes text through stdin, then presses enter, then sends keys", async () => {
    const { tty7, calls } = fake({ send: {} });
    await tty7.send({ pane: 12, text: "line 1\nline 2", enter: true, keys: ["escape", "C-c"] });
    expect(calls).toEqual([
      { args: ["send", "%12", "--paste", "--stdin", "--json"], stdin: "line 1\nline 2" },
      { args: ["send", "%12", "--enter", "--json"] },
      { args: ["send", "%12", "--key", "escape", "--key", "C-c", "--json"] },
    ]);
  });

  it("never puts the text on the command line", async () => {
    const { tty7, calls } = fake({ send: {} });
    await tty7.send({ pane: 3, text: "--key C-c" });
    expect(calls.flatMap((call) => call.args)).not.toContain("--key C-c");
  });

  it("rejects unknown keys and empty input before running anything", async () => {
    const { tty7, calls } = fake({ send: {} });
    await expect(tty7.send({ pane: 3, keys: ["--stdin"] })).rejects.toThrow("不支持的按键");
    await expect(tty7.send({ pane: 3 })).rejects.toThrow("没有要发送的内容");
    await expect(tty7.send({ pane: -1, enter: true })).rejects.toThrow("会话编号");
    expect(calls).toEqual([]);
  });
});

describe("Tty7.delete", () => {
  it("closes exactly the requested pane without closing its tab or workspace", async () => {
    const { tty7, calls } = fake({ "pane close": {} });
    await tty7.delete(12);
    expect(calls).toEqual([{ args: ["pane", "close", "%12", "--json"] }]);
  });

  it("rejects invalid pane addresses without invoking tty7", async () => {
    const { tty7, calls } = fake({});
    for (const pane of [-1, 1.5, NaN, Infinity]) {
      await expect(tty7.delete(pane)).rejects.toThrow("会话编号");
    }
    expect(calls).toEqual([]);
  });

  it("propagates a tty7 failure instead of reporting success", async () => {
    const tty7 = new Tty7({ runner: async () => { throw new Error("pane is not available"); } });
    await expect(tty7.delete(12)).rejects.toThrow("pane is not available");
  });
});

describe("Tty7.start", () => {
  it("opens a tab in the attached workspace, waits for the prompt, then types the CLI command", async () => {
    let probes = 0;
    const { tty7, calls } = fake({
      "ws ls": WORKSPACES,
      "tab new": { tab: "t9", pane: 40 },
      procs: () => ({ context: { at_prompt: ++probes >= 2 } }),
      send: {},
    });
    const created = await tty7.start({ cwd: "/repo/a", harness: "codex" });
    expect(created).toEqual({ pane: 40, workspaceId: "ws-a", tabId: "t9" });
    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "ws ls --json",
      "tab new ws-a --cwd /repo/a --json",
      "procs %40 --json",
      "procs %40 --json",
      "send %40 --stdin --json",
      "send %40 --enter --json",
    ]);
    expect(calls[4]?.stdin).toBe("codex");
  });

  it("opens a bare shell without typing anything, in the workspace asked for", async () => {
    const { tty7, calls } = fake({ "tab new": { tab: "t9", pane: 41 } });
    await tty7.start({ cwd: "/repo/a", harness: "shell", workspace: "ws-b" });
    expect(calls.map((call) => call.args.join(" "))).toEqual(["tab new ws-b --cwd /repo/a --json"]);
  });

  it("creates a workspace when there is none", async () => {
    const { tty7, calls } = fake({
      "ws ls": { workspaces: [] },
      "ws new": { id: "ws-new", name: "amber" },
      "tab new": { tab: "t1", pane: 1 },
    });
    const created = await tty7.start({ cwd: "/repo/a", harness: "shell" });
    expect(created.workspaceId).toBe("ws-new");
    expect(calls.map((call) => call.args[0] + " " + call.args[1])).toEqual(["ws ls", "ws new", "tab new"]);
  });

  it("rejects unknown CLIs, relative paths and missing directories", async () => {
    const { tty7, calls } = fake({});
    await expect(tty7.start({ cwd: "/repo/a", harness: "rm -rf" })).rejects.toThrow("未知的 AI CLI");
    await expect(tty7.start({ cwd: "repo/a", harness: "claude" })).rejects.toThrow("绝对路径");
    await expect(tty7.start({ cwd: "/missing", harness: "claude" })).rejects.toThrow("目录不存在");
    expect(calls).toEqual([]);
  });
});

describe("Tty7.screen", () => {
  it("captures plain text with a bounded tail", async () => {
    const { tty7, calls } = fake({ capture: { pane: 5, text: "❯ ", bytes: 3 } });
    expect(await tty7.screen(5, 9_999)).toEqual({ pane: 5, text: "❯ " });
    expect(calls[0]?.args).toEqual(["capture", "%5", "--plain", "--tail", "400", "--json"]);
  });
});

describe("Tty7.saveImagePaste", () => {
  it("writes pasted bytes into a png file and returns the absolute path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tty7-test-"));
    const tty7 = new Tty7({ runner: async () => "", tmpDir: dir });
    const file = await tty7.saveImagePaste(new Uint8Array([137, 80, 78, 71]), "image/png");
    expect(file.startsWith(dir)).toBe(true);
    expect(file.endsWith(".png")).toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from([137, 80, 78, 71]));
    await rm(dir, { recursive: true, force: true });
  });

  it("maps jpeg content type to .jpg and rejects unknown types", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tty7-test-"));
    const tty7 = new Tty7({ runner: async () => "", tmpDir: dir });
    const file = await tty7.saveImagePaste(new Uint8Array([1]), "image/jpeg; charset=binary");
    expect(file.endsWith(".jpg")).toBe(true);
    await expect(tty7.saveImagePaste(new Uint8Array([1]), "application/pdf")).rejects.toThrow("不支持的图片类型");
    await rm(dir, { recursive: true, force: true });
  });
});

const RENAME_REPLIES = {
  "ws ls": { workspaces: [{ id: "ws-a", name: "John", attached: null }] },
  "pane ls": { panes: [{ pane: 7, workspace: "ws-a", tab: "@3", cwd: "/repo/a", live: true, hibernated: false }] },
  "tab ls ws-a": { tabs: [{ id: "@3", name: null, label: "a", agent: null, panes: [7] }] },
  "tab rename": {},
};

describe("Tty7.rename", () => {
  it("rename 用 tab 地址改名，名字放在 -- 之后", async () => {
    const { tty7, calls } = fake(RENAME_REPLIES);
    await tty7.rename(7, '-rf 《账本》 "x" 🧠');
    expect(calls.at(-1)?.args).toEqual(["tab", "rename", "@3", "--json", "--", '-rf 《账本》 "x" 🧠']);
  });

  it("rename 找不到 pane 时报错且不执行改名", async () => {
    const { tty7, calls } = fake(RENAME_REPLIES);
    await expect(tty7.rename(99, "x")).rejects.toThrow("%99");
    expect(calls.some((call) => call.args[1] === "rename")).toBe(false);
  });

  it("rename 拒绝空名字且不调用 tty7", async () => {
    const { tty7, calls } = fake(RENAME_REPLIES);
    await expect(tty7.rename(7, "   ")).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("Tty7 appearance", () => {
  const SESSION_REPLIES = { "ws ls": { workspaces: [] }, "pane ls": { panes: [] } };

  async function withConfig(content: string | null, run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "yb-tty7-config-"));
    try {
      if (content !== null) await writeFile(join(dir, "config.json"), content);
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("appearance 读取字体、字号、行高并限幅", async () => {
    await withConfig(JSON.stringify({ font_family: "Hack", font_fallbacks: ["Menlo", "SF Mono"], font_size: 13.0, line_height: 1.4 }), async (dir) => {
      const view = await fake(SESSION_REPLIES, dir).tty7.sessions();
      expect(view.appearance).toEqual({ fontFamily: '"Hack", "Menlo", "SF Mono", monospace', fontSize: 13, lineHeight: 1.4 });
    });
    await withConfig(JSON.stringify({ font_family: "Hack", font_size: 40, line_height: 0.5 }), async (dir) => {
      const view = await fake(SESSION_REPLIES, dir).tty7.sessions();
      expect(view.appearance).toEqual({ fontFamily: '"Hack", monospace', fontSize: 24, lineHeight: 1 });
    });
    await withConfig(JSON.stringify({ font_family: "Hack", font_size: 2, line_height: 9 }), async (dir) => {
      const view = await fake(SESSION_REPLIES, dir).tty7.sessions();
      expect(view.appearance).toMatchObject({ fontSize: 9, lineHeight: 2 });
    });
  });

  it("环境变量 TTY7_CONFIG_DIR 指定配置目录", async () => {
    await withConfig(JSON.stringify({ font_family: "Hack", font_size: 12, line_height: 1.2 }), async (dir) => {
      const tty7 = new Tty7({ runner: async () => JSON.stringify({ workspaces: [], panes: [] }), env: { TTY7_CONFIG_DIR: dir } });
      expect((await tty7.sessions()).appearance?.fontSize).toBe(12);
    });
  });

  it("appearance 配置缺失或损坏时为 null", async () => {
    await withConfig(null, async (dir) => {
      expect((await fake(SESSION_REPLIES, dir).tty7.sessions()).appearance).toBeNull();
    });
    for (const bad of ["not json", "[]", JSON.stringify({ font_family: "Hack" }), JSON.stringify({ font_family: 3, font_size: 13, line_height: 1.4 })]) {
      await withConfig(bad, async (dir) => {
        expect((await fake(SESSION_REPLIES, dir).tty7.sessions()).appearance).toBeNull();
      });
    }
  });
});
