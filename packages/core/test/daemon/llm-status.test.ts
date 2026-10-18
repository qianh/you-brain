import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";
import { parseSharedConfig } from "@you-brain/protocol";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { physicalPath, llmCliWorkDir } from "../../src/llm/cli/workdir.js";
import {
  claudeLine,
  makeDaemonDirs,
  readStatus,
  testClock,
  throwingEmbedder,
  writeClaudeSession,
  type DaemonDirs,
} from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function prepare(prefix: string): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs(prefix);
  roots.push(dirs.root);
  await mkdir(dirs.dataDir, { recursive: true });
  await writeClaudeSession(dirs.sourceDir, [
    claudeLine("llm-1", "user", "Plan the launch checklist", "2026-10-18T02:00:00.000Z"),
  ]);
  return dirs;
}

async function writeProvider(dirs: DaemonDirs, provider: "codex-cli"): Promise<void> {
  const shared = parseSharedConfig({ llm: { provider, model: "", baseUrl: "" } });
  await writeFile(join(dirs.dataDir, "shared.json"), `${JSON.stringify(shared)}\n`);
}

function track(daemon: YouBrainDaemon): YouBrainDaemon {
  started.push(daemon);
  return daemon;
}

const REFINE_JSON = JSON.stringify({
  title: "发布清单",
  summary: "讨论了分阶段发布",
  topic: { action: "create", topicId: "", name: "发布流程", aliases: [] },
  conclusions_added: [],
  todos_added: [],
  todos_completed: [],
});

describe("daemon llm status", () => {
  it("reports a missing CLI, keeps running, and does not retry refine", async () => {
    const dirs = await prepare("you-brain-cli-missing-");
    await writeProvider(dirs, "codex-cli");
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const daemon = track(
      await startDaemon({
        homeDir: dirs.homeDir,
        platform: "darwin",
        env: { ...dirs.env, YOU_BRAIN_CODEX_BIN: join(dirs.root, "missing-codex") },
        hostname: "device-a",
        clock,
        drive,
        embedder: throwingEmbedder,
        sourceRoots: { "claude-code": [dirs.sourceDir] },
        watch: false,
        signals: false,
      }),
    );
    await daemon.settled();
    await clock.advance(5 * 60_000);
    await daemon.settled();
    const first = await readStatus(daemon);
    expect(first.warnings).toContainEqual({
      code: "LLM_CLI_MISSING",
      message: "未找到 codex 命令行，已上传会话但跳过提炼",
    });
    expect(first.warnings.some((warning) => warning.code === "LLM_NOT_CONFIGURED")).toBe(false);
    expect(first.refine.pending).toBe(0);
    expect((await drive.list({ prefix: "inbox/" })).length).toBeGreaterThan(0);

    await clock.advance(5 * 60_000);
    await daemon.settled();
    const second = await readStatus(daemon);
    expect(second.refine.pending).toBe(0);
    expect(second.warnings.filter((warning) => warning.code === "LLM_CLI_MISSING")).toHaveLength(1);
  });

  it("runs the subscription CLI in the daemon data directory without a model flag", async () => {
    const dirs = await prepare("you-brain-cli-datadir-");
    await writeProvider(dirs, "codex-cli");
    const bin = join(dirs.root, "fake-codex");
    const calls = join(dirs.root, "calls.log");
    await writeFile(
      bin,
      `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ cwd: process.cwd(), argv }) + "\\n");
const index = argv.indexOf("--output-last-message");
if (index >= 0 && argv[index + 1]) writeFileSync(argv[index + 1], ${JSON.stringify(REFINE_JSON)});
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
`,
      { mode: 0o755 },
    );
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const daemon = track(
      await startDaemon({
        homeDir: dirs.homeDir,
        platform: "darwin",
        env: { ...dirs.env, YOU_BRAIN_CODEX_BIN: bin, FAKE_CALLS: calls },
        hostname: "device-a",
        clock,
        drive,
        embedder: throwingEmbedder,
        sourceRoots: { "claude-code": [dirs.sourceDir] },
        watch: false,
        signals: false,
      }),
    );
    await daemon.settled();
    await clock.advance(5 * 60_000);
    await daemon.settled();
    const lines = (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean);
    const first = JSON.parse(lines[0] ?? "{}") as { cwd?: string; argv?: string[] };
    expect(first.cwd).toBe(physicalPath(llmCliWorkDir(dirs.dataDir)));
    expect(first.argv ?? []).not.toContain("-m");
    const status = await readStatus(daemon);
    expect(status.warnings.some((warning) => warning.code.startsWith("LLM_"))).toBe(false);
    expect(status.refine.pending).toBe(0);
  });

  it("reports a logged-out CLI once and does not retry", async () => {
    const dirs = await prepare("you-brain-cli-auth-");
    await writeProvider(dirs, "codex-cli");
    const bin = join(dirs.root, "fake-codex");
    const calls = join(dirs.root, "calls.log");
    await writeFile(
      bin,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_CALLS, "call\\n");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  console.error("not logged in");
  process.exit(1);
});
`,
      { mode: 0o755 },
    );
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const daemon = track(
      await startDaemon({
        homeDir: dirs.homeDir,
        platform: "darwin",
        env: { ...dirs.env, YOU_BRAIN_CODEX_BIN: bin, FAKE_CALLS: calls },
        hostname: "device-a",
        clock,
        drive,
        embedder: throwingEmbedder,
        sourceRoots: { "claude-code": [dirs.sourceDir] },
        watch: false,
        signals: false,
      }),
    );
    await daemon.settled();
    await clock.advance(5 * 60_000);
    await daemon.settled();
    await clock.advance(5 * 60_000);
    await daemon.settled();
    const status = await readStatus(daemon);
    expect(status.warnings).toContainEqual({
      code: "LLM_CLI_UNAUTHENTICATED",
      message: "codex 未登录，已上传会话但跳过提炼。请运行 codex login",
    });
    expect(status.refine.pending).toBe(1);
    const callsText = await readFile(calls, "utf8");
    expect(callsText.trim().split("\n").filter(Boolean)).toHaveLength(1);
  });
});
