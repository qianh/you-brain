import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareNodeVersion,
  locateNode,
  nodeVersionSupported,
  parseNodeVersion,
} from "../../src/deck/dsh/node.js";
import { renderDshPatch, type DshPluginStatus } from "../../src/deck/dsh/patch.js";
import { DshRuntime } from "../../src/deck/dsh/runtime.js";
import { DshLogin } from "../../src/deck/dsh/login.js";
import { DshWeb, type DshWebState } from "../../src/deck/dsh/web.js";

describe("dsh node discovery", () => {
  it("parses and compares versions", () => {
    expect(parseNodeVersion("v24.15.0\n")).toEqual([24, 15, 0]);
    expect(parseNodeVersion("nonsense")).toBeNull();
    expect(compareNodeVersion([24, 9, 0], [24, 15, 0])).toBeLessThan(0);
    expect(nodeVersionSupported([24, 8, 9])).toBe(false);
    expect(nodeVersionSupported([24, 9, 0])).toBe(true);
    expect(nodeVersionSupported([22, 15, 0])).toBe(false);
  });

  it("picks the highest supported node and skips old or broken ones", async () => {
    const versions: Record<string, string> = {
      "/a/node": "v22.15.0",
      "/b/node": "v24.9.0",
      "/c/node": "v26.0.1",
    };
    const located = await locateNode({
      homeDir: "/nonexistent-home",
      env: { PATH: "" },
      extraCandidates: ["/a/node", "/b/node", "/c/node", "/broken/node"],
      probe: async (path) => {
        const version = versions[path];
        if (version === undefined) throw new Error("spawn failed");
        return version;
      },
    });
    expect(located?.path).toBe("/c/node");
    expect(located?.version).toEqual([26, 0, 1]);
  });

  it("override is authoritative and does not fall back", async () => {
    const located = await locateNode({
      homeDir: "/nonexistent-home",
      env: { PATH: "" },
      override: "/old/node",
      extraCandidates: ["/good/node"],
      probe: async (path) => (path === "/good/node" ? "v24.15.0" : "v20.0.0"),
    });
    expect(located).toBeNull();
  });
});

describe("dsh patch", () => {
  const plugins: DshPluginStatus[] = [
    { id: "claude-code", title: "Claude Code", bin: "/bin/claude" },
    { id: "codex", title: "Codex", bin: null },
    { id: "gemini", title: "Gemini CLI", bin: "/bin/gemini" },
    { id: "opencode", title: "opencode", bin: null },
  ];

  it("mounts only installed CLIs", () => {
    const text = renderDshPatch({ plugins });
    expect(text).toContain("@deepseek-ai/dsh-subagent-claude-code");
    expect(text).toContain("subagent_claude_code");
    expect(text).toContain("@deepseek-ai/dsh-subagent-acp");
    expect(text).toContain('command: "/bin/gemini"');
    expect(text).toContain('args: ["--acp"]');
    expect(text).not.toContain("codex");
    expect(text).not.toContain("opencode");
    expect(text).not.toContain("mcp-you-brain");
  });

  it("is an empty list when nothing is installed", () => {
    expect(renderDshPatch({ plugins: plugins.map((item) => ({ ...item, bin: null })) })).toBe("[]\n");
  });

  it("adds the you-brain MCP row when a launch spec is given", () => {
    const text = renderDshPatch({ plugins: [], mcp: { command: "/usr/bin/you-brain", args: ["mcp"] } });
    expect(text).toContain("@deepseek-ai/dsh-mcp-client");
    expect(text).toContain('command: "/usr/bin/you-brain"');
    expect(text).toContain('args: ["mcp"]');
  });

  it("passes the data dir to the you-brain MCP as an env entry", () => {
    const text = renderDshPatch({
      plugins: [],
      mcp: { command: "/app/you-brain", args: ["mcp"], env: { YOU_BRAIN_DATA_DIR: "/data dir/you-brain" } },
    });
    expect(text).toContain("        env:\n          YOU_BRAIN_DATA_DIR: \"/data dir/you-brain\"");
  });

  it("quotes hostile paths as YAML scalars", () => {
    const text = renderDshPatch({
      plugins: [{ id: "gemini", title: "g", bin: '/x y/"z"\n- id: evil' }],
    });
    expect(text).not.toContain("\n- id: evil");
    expect(text).toContain('\\"z\\"');
  });
});

/** 假宿主：实现 host.mjs 的协议，行为由 ask 的 prompt 驱动。 */
describe("dsh sidecar location", () => {
  it("prefers <dataDir>/deck/dsh/sidecar over the dev layout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-loc-"));
    try {
      const runtime = new DshRuntime({ dataDir: dir, homeDir: dir });
      const dev = runtime.sidecarDir;
      expect(dev).toContain("sidecars");
      const installed = join(dir, "deck", "dsh", "sidecar");
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, "login-oauth.mjs"), "", "utf8");
      expect(runtime.sidecarDir).toBe(installed);
      expect(new DshRuntime({ dataDir: dir, homeDir: dir, sidecarDir: "/explicit" }).sidecarDir).toBe("/explicit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(web: DshWeb, wanted: DshWebState["state"], ms = 5_000): Promise<DshWebState> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (web.state.state === wanted) return web.state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return web.state;
}

async function fakeWebScript(body: string): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-web-"));
  const script = join(dir, "bin.js");
  await writeFile(script, body, "utf8");
  return { dir, script };
}

function webFor(script: string, dir: string): DshWeb {
  return new DshWeb({
    nodePath: process.execPath,
    binPath: script,
    cwd: dir,
    env: async () => ({ PATH: process.env.PATH ?? "" }),
    patches: async () => ["/tmp/a.yml"],
    startTimeoutMs: 3_000,
  });
}

describe("dsh web process", () => {
  it("starts lazily, reads the printed url and does not respawn while running", async () => {
    const { dir, script } = await fakeWebScript(
      `console.log("dsh web: http://127.0.0.1:43210/?token=abc_DEF-123"); console.error(JSON.stringify(process.argv.slice(2))); setInterval(() => {}, 1000);`,
    );
    const web = webFor(script, dir);
    try {
      expect(web.state.state).toBe("stopped");
      expect(web.ensureStarted().state).toBe("starting");
      const ready = await waitFor(web, "ready");
      expect(ready).toEqual({ state: "ready", url: "http://127.0.0.1:43210/?token=abc_DEF-123" });
      expect(web.ensureStarted()).toEqual(ready);
    } finally {
      web.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes the web profile, an OS-chosen port and every patch", async () => {
    const { dir, script } = await fakeWebScript(
      `console.log("http://127.0.0.1:1/?token=x " + JSON.stringify(process.argv.slice(2))); setInterval(() => {}, 1000);`,
    );
    const web = webFor(script, dir);
    try {
      web.ensureStarted();
      const ready = await waitFor(web, "ready");
      expect(ready.state).toBe("ready");
    } finally {
      web.stop();
    }
    // 参数通过 stdout 回显时被 URL 截断，这里改用独立脚本断言。
    const probe = await fakeWebScript(
      `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2))); console.log("http://127.0.0.1:2/?token=y"); setInterval(() => {}, 1000);`,
    );
    const web2 = webFor(probe.script, dir);
    try {
      web2.ensureStarted();
      await waitFor(web2, "ready");
      expect(JSON.parse(await readFile(join(dir, "args.json"), "utf8"))).toEqual([
        "--profile", "web", "--patch", "/tmp/a.yml", "--no-open", "--port", "0",
      ]);
    } finally {
      web2.stop();
      await rm(dir, { recursive: true, force: true });
      await rm(probe.dir, { recursive: true, force: true });
    }
  });

  it("reports an early exit with the stderr tail and restarts on the next request", async () => {
    const { dir, script } = await fakeWebScript(`console.error("boom: no pnpm"); process.exit(2);`);
    const web = webFor(script, dir);
    try {
      web.ensureStarted();
      const failed = await waitFor(web, "error");
      expect(failed.state).toBe("error");
      expect((failed as { error: string }).error).toContain("boom: no pnpm");
      // 出错后轮询不会自动重启（否则页面永远看不到错误）；显式 retry 才重启。
      expect(web.ensureStarted().state).toBe("error");
      expect(web.ensureStarted(true).state).toBe("starting");
      expect((await waitFor(web, "error")).state).toBe("error");
    } finally {
      web.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times out when the process never prints an address", async () => {
    const { dir, script } = await fakeWebScript(`setInterval(() => {}, 1000);`);
    const web = new DshWeb({
      nodePath: process.execPath, binPath: script, cwd: dir,
      env: async () => ({ PATH: process.env.PATH ?? "" }), patches: async () => [], startTimeoutMs: 300,
    });
    try {
      web.ensureStarted();
      const state = await waitFor(web, "error");
      expect((state as { error: string }).error).toContain("超时");
    } finally {
      web.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runtime webState explains a missing sidecar instead of spawning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-nosidecar-"));
    const runtime = new DshRuntime({
      dataDir: dir,
      homeDir: dir,
      sidecarDir: join(dir, "sidecar"),
      locateNodeImpl: async () => ({ path: "/fake/node", version: [24, 15, 0] }),
      detectPluginsImpl: () => [],
    });
    try {
      const state = await runtime.webState();
      expect(state.state).toBe("error");
      expect((state as { error: string }).error).toContain("npm install");
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** 假登录引擎：按 MODE 环境变量模拟 login-oauth.mjs 的 JSON 事件协议。 */
const FAKE_LOGIN = `
const fs = require("node:fs");
const path = require("node:path");
const [action, provider] = process.argv.slice(2);
const file = path.join(process.env.DSH_HOME, ".credentials.yaml");
const emit = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
const mode = process.env.MODE || "ok";
if (action === "logout") {
  if (mode === "logout-fail") { emit({ event: "error", message: "写入失败" }); process.exit(1); }
  try { fs.unlinkSync(file); } catch {}
  emit({ event: "done" }); process.exit(0);
}
if (mode === "crash") { process.stderr.write("node: boom"); process.exit(3); }
if (mode === "silent-exit") process.exit(0);
emit({ event: "auth_url", url: "https://example.test/authorize?x=1" });
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "error") setTimeout(() => { emit({ event: "error", message: "授权被拒绝" }); process.exit(1); }, 100);
else setTimeout(() => { fs.mkdirSync(process.env.DSH_HOME, { recursive: true }); fs.writeFileSync(file, "version: 1\\nrecords:\\n  llm-pi-ai/" + provider + ":\\n    kind: grant\\n"); emit({ event: "done" }); process.exit(0); }, 100);
`;

async function loginFixture(mode: string): Promise<{ login: DshLogin; dir: string; signedIn: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-login-"));
  const script = join(dir, "login-oauth.mjs");
  await writeFile(script, FAKE_LOGIN, "utf8");
  const signedIn: string[] = [];
  const login = new DshLogin({
    nodePath: process.execPath,
    script,
    dshHome: join(dir, "home"),
    env: () => ({ MODE: mode, PATH: process.env.PATH ?? "" }),
    onSignedIn: (id) => signedIn.push(id),
    timeoutMs: 5_000,
  });
  return { login, dir, signedIn };
}

async function until(check: () => Promise<boolean>, ms = 4_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("dsh subscription login", () => {
  it("walks idle → waiting(url) → signed in, and notifies once", async () => {
    const f = await loginFixture("ok");
    try {
      expect((await f.login.view())[0]).toMatchObject({ id: "anthropic", signedIn: false, state: "idle" });
      f.login.start("anthropic");
      expect(await until(async () => (await f.login.view())[0]?.url !== undefined)).toBe(true);
      expect((await f.login.view())[0]).toMatchObject({ state: "waiting", url: "https://example.test/authorize?x=1" });
      expect(await until(async () => (await f.login.view())[0]?.signedIn === true)).toBe(true);
      expect((await f.login.view())[0]).toMatchObject({ signedIn: true, state: "idle" });
      expect(f.signedIn).toEqual(["anthropic"]);
    } finally {
      f.login.stop();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("does not spawn a second flow while one is waiting", async () => {
    const f = await loginFixture("hang");
    try {
      f.login.start("anthropic");
      await until(async () => (await f.login.view())[0]?.state === "waiting");
      f.login.start("anthropic");
      expect((await f.login.view())[0]?.state).toBe("waiting");
    } finally {
      f.login.stop();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("surfaces an engine error and clears it on the next attempt", async () => {
    const f = await loginFixture("error");
    try {
      f.login.start("anthropic");
      expect(await until(async () => (await f.login.view())[0]?.state === "error")).toBe(true);
      expect((await f.login.view())[0]?.error).toBe("授权被拒绝");
      expect(f.signedIn).toEqual([]);
      f.login.start("anthropic");
      expect((await f.login.view())[0]?.state).toBe("waiting");
    } finally {
      f.login.stop();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("treats a crash or a silent exit as a failure with the stderr tail", async () => {
    const crash = await loginFixture("crash");
    const silent = await loginFixture("silent-exit");
    try {
      crash.login.start("anthropic");
      expect(await until(async () => (await crash.login.view())[0]?.state === "error")).toBe(true);
      expect((await crash.login.view())[0]?.error).toContain("boom");
      silent.login.start("anthropic");
      expect(await until(async () => (await silent.login.view())[0]?.state === "error")).toBe(true);
      expect((await silent.login.view())[0]?.error).toContain("没有返回结果");
    } finally {
      for (const f of [crash, silent]) {
        f.login.stop();
        await rm(f.dir, { recursive: true, force: true });
      }
    }
  });

  it("cancel kills the flow and leaves no error behind", async () => {
    const f = await loginFixture("hang");
    try {
      f.login.start("anthropic");
      await until(async () => (await f.login.view())[0]?.state === "waiting");
      f.login.cancel("anthropic");
      expect((await f.login.view())[0]).toMatchObject({ state: "idle", signedIn: false });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await f.login.view())[0]?.state).toBe("idle");
    } finally {
      f.login.stop();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("logout removes the record; a failing logout rejects with the reason", async () => {
    const ok = await loginFixture("ok");
    const bad = await loginFixture("logout-fail");
    try {
      ok.login.start("anthropic");
      await until(async () => (await ok.login.view())[0]?.signedIn === true);
      await ok.login.logout("anthropic");
      expect((await ok.login.view())[0]?.signedIn).toBe(false);
      await expect(bad.login.logout("anthropic")).rejects.toThrow("写入失败");
    } finally {
      for (const f of [ok, bad]) {
        f.login.stop();
        await rm(f.dir, { recursive: true, force: true });
      }
    }
  });

  it("DshWeb.restart replaces the process and comes back up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-web-restart-"));
    const marker = join(dir, "count");
    const script = join(dir, "bin.js");
    await writeFile(
      script,
      `const fs=require("node:fs");const f=${JSON.stringify(marker)};const n=(fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0)+1;fs.writeFileSync(f,String(n));console.log("http://127.0.0.1:"+(40000+n)+"/?token=t");setInterval(()=>{},1000);`,
      "utf8",
    );
    const web = webFor(script, dir);
    try {
      web.ensureStarted();
      expect((await waitFor(web, "ready")).state).toBe("ready");
      expect(web.state).toEqual({ state: "ready", url: "http://127.0.0.1:40001/?token=t" });
      expect(web.restart().state).toBe("starting");
      expect((await waitFor(web, "ready")).state).toBe("ready");
      expect(web.state).toEqual({ state: "ready", url: "http://127.0.0.1:40002/?token=t" });
    } finally {
      web.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("bundled dsh runtime", () => {
  it("finds the runtime shipped next to the executable and ignores incomplete directories", async () => {
    const { bundledDsh } = await import("../../src/deck/dsh/bundled.js");
    const dir = await mkdtemp(join(tmpdir(), "dsh-bundled-"));
    try {
      const execPath = join(dir, "MacOS", "you-brain");
      expect(bundledDsh(execPath, {})).toBeNull();
      // 只有 node、没有 sidecar：不算。
      await mkdir(join(dir, "Resources", "dsh", "sidecar"), { recursive: true });
      await writeFile(join(dir, "Resources", "dsh", "node"), "", "utf8");
      expect(bundledDsh(execPath, {})).toBeNull();
      await writeFile(join(dir, "Resources", "dsh", "sidecar", "login-oauth.mjs"), "", "utf8");
      expect(bundledDsh(execPath, {})).toEqual({
        node: join(dir, "Resources", "dsh", "node"),
        sidecarDir: join(dir, "Resources", "dsh", "sidecar"),
      });
      // 环境变量指定的目录优先。
      const other = join(dir, "other");
      await mkdir(join(other, "sidecar"), { recursive: true });
      await writeFile(join(other, "node"), "", "utf8");
      await writeFile(join(other, "sidecar", "login-oauth.mjs"), "", "utf8");
      expect(bundledDsh(execPath, { YOU_BRAIN_DSH_DIR: other })?.node).toBe(join(other, "node"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not mount native subagents whose payload was pruned from the bundle", async () => {
    const { detectDshPlugins } = await import("../../src/deck/dsh/patch.js");
    const dir = await mkdtemp(join(tmpdir(), "dsh-payload-"));
    const fakeBin = join(dir, "bin");
    await mkdir(fakeBin, { recursive: true });
    for (const name of ["claude", "codex"]) {
      await writeFile(join(fakeBin, name), "#!/bin/sh\n", { mode: 0o755 });
    }
    const sidecar = join(dir, "sidecar");
    await mkdir(join(sidecar, "node_modules"), { recursive: true });
    try {
      const options = { homeDir: dir, env: { PATH: fakeBin } };
      const pruned = detectDshPlugins({ ...options, sidecarDir: sidecar });
      expect(pruned.find((p) => p.id === "claude-code")?.bin).toBeNull();
      expect(pruned.find((p) => p.id === "codex")?.bin).toBeNull();
      await mkdir(join(sidecar, "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64"), { recursive: true });
      const withClaude = detectDshPlugins({ ...options, sidecarDir: sidecar });
      expect(withClaude.find((p) => p.id === "claude-code")?.bin).not.toBeNull();
      expect(withClaude.find((p) => p.id === "codex")?.bin).toBeNull();
      // 不给 sidecarDir 时不检查载荷（开发环境）。
      expect(detectDshPlugins(options).find((p) => p.id === "codex")?.bin).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("dsh web keep-alive", () => {
  const keepAlive = { maxRestarts: 2, baseDelayMs: 20, stableMs: 60_000 };

  function keptWeb(script: string, dir: string, extra?: Partial<ConstructorParameters<typeof DshWeb>[0]>): DshWeb {
    return new DshWeb({
      nodePath: process.execPath, binPath: script, cwd: dir,
      env: async () => ({ PATH: process.env.PATH ?? "" }), patches: async () => [],
      startTimeoutMs: 3_000, keepAlive, ...extra,
    });
  }

  it("restarts after an unexpected exit once it had been ready, with a fresh address", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-keep-"));
    const marker = join(dir, "count");
    const script = join(dir, "bin.js");
    // 第一次：就绪后 300ms 退出；第二次起：常驻。
    await writeFile(
      script,
      `const fs=require("node:fs");const f=${JSON.stringify(marker)};const n=(fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0)+1;fs.writeFileSync(f,String(n));console.log("http://127.0.0.1:"+(41000+n)+"/?token=t");if(n===1)setTimeout(()=>process.exit(9),300);else setInterval(()=>{},1000);`,
      "utf8",
    );
    const web = keptWeb(script, dir);
    try {
      web.ensureStarted();
      expect((await waitFor(web, "ready")).state).toBe("ready");
      expect(web.state).toEqual({ state: "ready", url: "http://127.0.0.1:41001/?token=t" });
      // 进程退出后进入 starting（而不是 error），随后换新地址就绪。
      expect((await waitFor(web, "starting", 3_000)).state).toBe("starting");
      expect((await waitFor(web, "ready", 5_000)).state).toBe("ready");
      expect(web.state).toEqual({ state: "ready", url: "http://127.0.0.1:41002/?token=t" });
    } finally {
      web.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives up after maxRestarts consecutive failures and reports the error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-keep-"));
    const script = join(dir, "bin.js");
    await writeFile(script, `console.log("http://127.0.0.1:41999/?token=t");console.error("crash loop");setTimeout(()=>process.exit(3),60);`, "utf8");
    const web = keptWeb(script, dir);
    try {
      web.ensureStarted();
      const failed = await waitFor(web, "error", 8_000);
      expect(failed.state).toBe("error");
      expect((failed as { error: string }).error).toContain("crash loop");
    } finally {
      web.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not restart after stop()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-keep-"));
    const marker = join(dir, "count");
    const script = join(dir, "bin.js");
    await writeFile(
      script,
      `const fs=require("node:fs");const f=${JSON.stringify(marker)};fs.writeFileSync(f,String((fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0)+1));console.log("http://127.0.0.1:41500/?token=t");setInterval(()=>{},1000);`,
      "utf8",
    );
    const web = keptWeb(script, dir);
    try {
      web.ensureStarted();
      await waitFor(web, "ready");
      web.stop();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await import("node:fs")).readFileSync(marker, "utf8")).toBe("1");
      expect(web.state.state).toBe("stopped");
    } finally {
      web.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
