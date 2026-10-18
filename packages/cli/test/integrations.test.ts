import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("you-brain integrations consent", () => {
  it("persists setup choices and deletes them on revoke", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-cli-consent-"));
    roots.push(root);
    const home = join(root, "home");
    const data = join(root, "data");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      YOU_BRAIN_HOME: home,
      YOU_BRAIN_DATA_DIR: data,
    };
    const setup = await runCli(
      ["setup", "--yes", "--no-backfill", "--skip-brainhub", "--integrations", "claude-code,codex"],
      env,
    );
    expect(setup.status).toBe(0);
    if (!setup.stdout.includes("已接入")) {
      throw new Error(`setup failed\n${setup.stdout}\n${setup.stderr}`);
    }
    const claude = await readFile(join(home, ".claude", "CLAUDE.md"), "utf8");
    const codex = await readFile(join(home, ".codex", "AGENTS.md"), "utf8");
    expect(claude).toContain("you-brain:start");
    expect(claude).toContain("@~/.you-brain/portrait/coding.md");
    expect(codex).toContain("you-brain:start");
    const consent = JSON.parse(await readFile(join(data, "portrait-consent.json"), "utf8")) as {
      itemIds: string[];
      fingerprint: string | null;
    };
    expect(consent.itemIds).toContain("claude-code:portrait");
    expect(consent.itemIds).toContain("codex:portrait");
    expect(consent.fingerprint).toContain("JOHN-TWIN-coding.md");

    const revoke = await runCli(["integrations", "revoke", "--yes", "--only", "claude-code"], env);
    expect(revoke.status).toBe(0);
    let claudeAfter = "";
    try {
      claudeAfter = await readFile(join(home, ".claude", "CLAUDE.md"), "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as { code?: string }).code !== "ENOENT") {
        throw error;
      }
    }
    expect(claudeAfter).not.toContain("you-brain:start");
    const codexAfter = await readFile(join(home, ".codex", "AGENTS.md"), "utf8");
    expect(codexAfter).toContain("you-brain:start");
    const after = JSON.parse(await readFile(join(data, "portrait-consent.json"), "utf8")) as {
      itemIds: string[];
    };
    expect(after.itemIds.some((id) => id.startsWith("claude-code:"))).toBe(false);
    expect(after.itemIds).toContain("codex:portrait");
  }, 60_000);
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
    }, 45_000);
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
