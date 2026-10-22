import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "@you-brain/core/daemon";
import { MemoryDrive } from "@you-brain/core/drive";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const roots: string[] = [];
const daemons: YouBrainDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("you-brain commands", () => {
  it("prints local status when the daemon is not running", async () => {
    const env = await emptyEnv();
    const result = spawnSync(process.execPath, [cli, "status"], {
      encoding: "utf8",
      env,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("没有在运行");
    expect(existsSync(join(env.YOU_BRAIN_DATA_DIR, "state.sqlite"))).toBe(false);
    expect(existsSync(join(env.YOU_BRAIN_DATA_DIR, "config.toml"))).toBe(false);
  });

  it("reads today from a running daemon", async () => {
    const env = await emptyEnv();
    const daemon = await startDaemon({
      platform: "darwin",
      homeDir: env.YOU_BRAIN_HOME,
      env,
      hostname: "cli-device",
      drive: null,
      llm: null,
      sourceRoots: {},
      watch: false,
      signals: false,
    });
    daemons.push(daemon);
    // spawnSync would freeze this process, so the in-process daemon could not answer.
    const result = await runCli(["today"], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("今天还没有会话");
    expect(result.stdout).not.toContain("没有在运行");
    expect(result.stderr).not.toContain("没有在运行");
  });

  it("registers and removes a virtual device", async () => {
    const env = await emptyEnv();
    const daemon = await startDaemon({
      platform: "darwin",
      homeDir: env.YOU_BRAIN_HOME,
      env,
      hostname: "cli-device",
      drive: new MemoryDrive(),
      llm: null,
      sourceRoots: {},
      watch: false,
      signals: false,
    });
    daemons.push(daemon);
    await daemon.settled();
    const added = await runCli(
      ["devices", "--add-virtual", "沉淀机器人", "--capabilities", "refine,consolidate"],
      env,
    );
    expect(added.status).toBe(0);
    const id = added.stdout.split("\n")[0]?.trim() ?? "";
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(added.stdout).toContain(`下一步：you-brain devices --set-main ${id}`);
    const removed = await runCli(["devices", "--remove-virtual", id], env);
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain(`已移除 ${id}`);
  }, 20_000);

  it("validates local protocol files and reports failures", async () => {
    const env = await emptyEnv();
    await mkdir(env.YOU_BRAIN_DATA_DIR, { recursive: true });
    const device = join(env.YOU_BRAIN_DATA_DIR, "device.json");
    await writeFile(
      device,
      `${JSON.stringify({
        deviceId: "44444444-4444-4444-8444-444444444444",
        displayName: "沉淀机器人",
        kind: "virtual",
        platform: "bot",
        appVersion: "virtual",
        protocolVersion: 1,
        capabilities: ["refine"],
        lastSeenAt: "2026-10-18T03:00:00.000Z",
        lastActiveAt: "2026-10-18T03:00:00.000Z",
      })}\n`,
    );
    const ok = spawnSync(process.execPath, [cli, "protocol", "validate", device], {
      encoding: "utf8",
      env,
    });
    expect(ok.status).toBe(0);
    expect(ok.stderr).toBe("");

    const events = join(env.YOU_BRAIN_DATA_DIR, "bad.jsonl");
    await writeFile(events, "{no\n");
    const failed = spawnSync(process.execPath, [cli, "protocol", "validate", events], {
      encoding: "utf8",
      env,
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(`${events}:1:`);

    const session = join(env.YOU_BRAIN_DATA_DIR, "session.md");
    await writeFile(session, "## User\n");
    const sessionResult = spawnSync(
      process.execPath,
      [cli, "protocol", "validate", "--kind", "session", session],
      { encoding: "utf8", env },
    );
    expect(sessionResult.status).toBe(1);
    expect(sessionResult.stderr).toContain("缺少 frontmatter");

    const named = spawnSync(
      process.execPath,
      [cli, "devices", "--add-virtual", "   ", "--capabilities", "nope"],
      { encoding: "utf8", env },
    );
    expect(named.status).toBe(1);
    expect(named.stderr).toContain("设备名称需要 1 到 60 个字");
  });

  it("answers an MCP initialize request on stdio", async () => {
    const env = await emptyEnv();
    await mkdir(env.YOU_BRAIN_HOME, { recursive: true });
    await mkdir(env.YOU_BRAIN_DATA_DIR, { recursive: true });
    const child = spawn(process.execPath, [cli, "mcp"], {
      env: {
        ...env,
        HOME: env.YOU_BRAIN_HOME,
        USERPROFILE: env.YOU_BRAIN_HOME,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const response = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`mcp timed out\n${stdout}\n${stderr}`));
      }, 20_000);
      child.stdout.on("data", () => {
        const line = stdout.split("\n").find((item) => item.includes('"jsonrpc"'));
        if (!line) return;
        clearTimeout(timer);
        resolve(line);
      });
      child.on("close", () => {
        clearTimeout(timer);
        reject(new Error(`mcp exited before initialize\n${stdout}\n${stderr}`));
      });
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      })}\n`,
    );
    const line = await response;
    child.kill("SIGTERM");
    const message = JSON.parse(line) as {
      id?: number;
      result?: { protocolVersion?: string; serverInfo?: { name?: string } };
    };
    expect(message.id).toBe(1);
    expect(message.result?.protocolVersion).toBe("2024-11-05");
    expect(message.result?.serverInfo?.name).toBe("you-brain");
  });
});

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cli timed out\n${stdout}\n${stderr}`));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function emptyEnv(): Promise<NodeJS.ProcessEnv & {
  YOU_BRAIN_DATA_DIR: string;
  YOU_BRAIN_HOME: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-cli-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const homeDir = join(root, "home");
  return {
    ...process.env,
    YOU_BRAIN_DATA_DIR: dataDir,
    YOU_BRAIN_HOME: homeDir,
  };
}
