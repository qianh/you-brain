import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));

describe("embed-worker command", () => {
  it("answers shutdown without loading a model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-embed-cli-"));
    const child = spawn(process.execPath, [cli, "embed-worker"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        YOU_BRAIN_DATA_DIR: join(directory, "data"),
        YOU_BRAIN_HOME: join(directory, "home"),
      },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stdin.end(
      `${JSON.stringify({
        id: 1,
        method: "shutdown",
        model: "unused",
        revision: "unused",
        dimensions: 3,
        cacheDir: directory,
      })}\n`,
    );
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`embed-worker hung; stdout=${stdout}`));
      }, 15_000);
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    expect(code).toBe(0);
    expect(stdout).toContain('"ok":true');
    await rm(directory, { recursive: true, force: true });
  });
});
