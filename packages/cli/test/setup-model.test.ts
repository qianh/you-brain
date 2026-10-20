import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createDefaultLocalConfig, platformPaths, writeLocalConfig, type YouBrainPaths } from "@you-brain/core";

import { CliError } from "../src/env.js";
import { runSetup, type SetupFlags, type SetupHooks } from "../src/setup.js";

const roots: string[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const FAKE = `#!${process.execPath}
if (process.argv.includes("--version")) {
  console.log("fake-cli 0");
  process.exit(0);
}
const chunks = [];
const schema = process.argv.includes("--json-schema");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  if (schema) {
    console.log(JSON.stringify({ structuredOutput: { ok: true }, result: "" }));
    return;
  }
  console.log(JSON.stringify({ result: "ok" }));
});
`;

async function prepared(): Promise<{
  homeDir: string;
  paths: YouBrainPaths;
  env: NodeJS.ProcessEnv;
  bin: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-setup-model-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const env: NodeJS.ProcessEnv = {
    YOU_BRAIN_DATA_DIR: join(root, "data"),
    YOU_BRAIN_HOME: join(root, "out"),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const paths = platformPaths({ platform: "darwin", homeDir, env });
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const config = createDefaultLocalConfig({
    hostname: "setup-test",
    dataDir: paths.dataDir,
    deviceId: randomUUID(),
  });
  await writeLocalConfig(paths.configFile, {
    ...config,
    driveRootId: "folder-1",
    account: { email: "owner@example.com", displayName: "Owner", permissionId: "perm-1" },
  });
  await writeFile(
    join(paths.dataDir, "setup.json"),
    `${JSON.stringify({
      version: 1,
      google: true,
      drive: true,
      brainhub: true,
      model: false,
      sources: true,
      integrations: true,
      backfill: true,
    })}\n`,
  );
  const bin = join(root, "fake-cli");
  await writeFile(bin, FAKE, { mode: 0o755 });
  return { homeDir, paths, env, bin };
}

function flags(): SetupFlags {
  return {
    yes: false,
    inheritBrainhub: false,
    skipBrainhub: true,
    sources: [],
    integrations: "",
    backfill: false,
  };
}

function hooks(
  base: { homeDir: string; paths: YouBrainPaths; env: NodeJS.ProcessEnv },
  answers: string[],
  logs: string[],
): SetupHooks {
  return {
    isTTY: true,
    homeDir: base.homeDir,
    paths: base.paths,
    env: base.env,
    platform: "darwin",
    log: (message) => logs.push(message),
    ask: async (question) => {
      logs.push(`ASK ${question}`);
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected question: ${question}`);
      return next;
    },
    planBrainHubMigration: async () => ({ detected: false, defaults: {}, items: [], warnings: [] }),
    applyBrainHubMigration: async () => ({ backupDir: "", removed: [] }),
    openGoogleDrive: async () => {
      throw new Error("google login should not run");
    },
  };
}

describe("setup model step", () => {
  test("groups API providers and local subscriptions", async () => {
    const base = await prepared();
    const logs: string[] = [];
    const error = await runSetup(flags(), hooks(base, ["nope"], logs)).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CliError);
    const question = logs.find((line) => line.startsWith("ASK ")) ?? "";
    expect(question).toContain("API：deepseek / glm / qwen / kimi / openai / claude / ollama / custom");
    expect(question).toContain(
      "本机订阅：grok-cli / claude-cli / codex-cli / gemini-cli / opencode-cli",
    );
    expect(question).toContain("[deepseek]");
  });

  test("stops when the selected CLI is not installed", async () => {
    const base = await prepared();
    base.env.PATH = "";
    const logs: string[] = [];
    const error = await runSetup(flags(), hooks(base, ["grok-cli"], logs)).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("未找到 grok 命令行，请先安装并登录");
    expect(logs.some((line) => line.includes("API Key"))).toBe(false);
  });

  test("tests a CLI provider without asking for an API key", async () => {
    const base = await prepared();
    base.env.YOU_BRAIN_GROK_BIN = base.bin;
    base.env.FAKE_MODE = "ok";
    const logs: string[] = [];
    await runSetup(flags(), hooks(base, ["grok-cli", ""], logs));
    expect(logs.some((line) => line.includes("模型名（留空用 grok 自己的默认模型）"))).toBe(true);
    expect(logs.some((line) => line.includes("API Key"))).toBe(false);
    expect(logs).toContain("模型连接成功");
    const shared = JSON.parse(await readFile(join(base.paths.dataDir, "shared.json"), "utf8")) as {
      llm: { provider: string; model: string };
    };
    expect(shared.llm.provider).toBe("grok-cli");
    expect(shared.llm.model).toBe("");
    expect(logs).toContain("正在调用 grok 测试连接（最多 90 秒）…");
  });

  test("aborts a silent CLI connection test within the injected timeout and keeps earlier steps", async () => {
    const base = await prepared();
    const hang = join(base.homeDir, "hang-cli");
    const marker = join(base.homeDir, "hang.pid");
    await writeFile(
      hang,
      `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  console.log("hang 0");
  process.exit(0);
}
const child = spawn("sleep", ["30"], { stdio: "ignore" });
writeFileSync(process.env.FAKE_MARKER, process.pid + "\\n" + child.pid + "\\n");
setInterval(() => {}, 1_000_000);
`,
      { mode: 0o755 },
    );
    base.env.YOU_BRAIN_GROK_BIN = hang;
    base.env.FAKE_MARKER = marker;
    const logs: string[] = [];
    const started = Date.now();
    const error = await runSetup(
      flags(),
      { ...hooks(base, ["grok-cli", ""], logs), cliTimeoutMs: 800 },
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      "grok 在 1 秒内没有响应。可能是服务暂时不可用，或需要重新登录（请运行 grok login）。可稍后重试。",
    );
    expect(logs).toContain("正在调用 grok 测试连接（最多 1 秒）…");
    expect(logs).not.toContain("模型连接成功");
    const progress = JSON.parse(await readFile(join(base.paths.dataDir, "setup.json"), "utf8")) as {
      google: boolean;
      model: boolean;
      sources: boolean;
    };
    expect(progress.google).toBe(true);
    expect(progress.model).toBe(false);
    expect(progress.sources).toBe(true);
    const sharedPath = join(base.paths.dataDir, "shared.json");
    expect(await readFile(sharedPath, "utf8").then(() => true, () => false)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const [parent, child] = (await readFile(marker, "utf8")).trim().split("\n").map((value) => Number(value));
    expect(parent).toBeGreaterThan(0);
    expect(child).toBeGreaterThan(0);
    expect(alive(parent ?? 0)).toBe(false);
    expect(alive(child ?? 0)).toBe(false);
  });

  test("asks for a custom base URL and rejects an empty answer", async () => {
    const base = await prepared();
    const logs: string[] = [];
    const error = await runSetup(flags(), hooks(base, ["custom", "local-model", ""], logs)).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("需要 Base URL");
    expect(logs.some((line) => line.includes("Base URL（OpenAI 兼容，如 https://api.x.ai/v1）："))).toBe(
      true,
    );

    const filled = await prepared();
    const filledLogs: string[] = [];
    const filledHooks = hooks(filled, ["custom", "local-model", "https://api.x.ai/v1"], filledLogs);
    const ask = filledHooks.ask;
    filledHooks.ask = async (question, fallback) => {
      if (question.includes("API Key")) {
        filledLogs.push(`ASK ${question}`);
        throw new Error("stop-before-key");
      }
      if (!ask) throw new Error("missing ask");
      return ask(question, fallback);
    };
    const stopped = await runSetup(flags(), filledHooks).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(stopped).toBeInstanceOf(Error);
    expect((stopped as Error).message).toContain("stop-before-key");
    expect(filledLogs.some((line) => line.includes("API Key（存入钥匙串）"))).toBe(true);
  });
});
