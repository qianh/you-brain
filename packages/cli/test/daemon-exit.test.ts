import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon signals", () => {
  it("exits on SIGTERM and deletes daemon.json and the lock", async () => {
    const { child, dataDir } = await startDaemon();
    await expectExit(child, dataDir, "SIGTERM");
  });

  it("exits on SIGINT and deletes daemon.json and the lock", async () => {
    const { child, dataDir } = await startDaemon();
    await expectExit(child, dataDir, "SIGINT");
  });

  it("exits on SIGTERM while an SSE client is connected", async () => {
    const { child, dataDir } = await startDaemon();
    const endpoint = JSON.parse(await readFile(join(dataDir, "daemon.json"), "utf8")) as {
      port: number;
      token: string;
    };
    const response = await fetch(
      `http://127.0.0.1:${endpoint.port}/api/events?token=${encodeURIComponent(endpoint.token)}`,
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE body missing");
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5_000;
    while (!text.includes("event: ready")) {
      if (Date.now() > deadline) throw new Error(`SSE did not become ready\n${text}`);
      const part = await reader.read();
      if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
    }
    expect(text).toContain("event: ready");
    try {
      await expectExit(child, dataDir, "SIGTERM");
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });
});

async function startDaemon(): Promise<{ child: ChildProcess; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-daemon-exit-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const child = spawn(process.execPath, [cli, "daemon"], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      YOU_BRAIN_DATA_DIR: dataDir,
      YOU_BRAIN_HOME: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`daemon did not listen\n${stdout}\n${stderr}`));
    }, 20_000);
    const onData = (): void => {
      if (!stdout.includes("正在监听") || !existsSync(join(dataDir, "daemon.json"))) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early code=${code} signal=${signal}\n${stdout}\n${stderr}`));
    });
  });
  await ready;
  return { child, dataDir };
}

async function expectExit(
  child: ChildProcess,
  dataDir: string,
  signal: "SIGTERM" | "SIGINT",
): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
  child.kill(signal);
  const result = await Promise.race([
    exited.then(() => "exited" as const),
    Bun.sleep(5_000).then(() => "timeout" as const),
  ]);
  if (result === "timeout") {
    child.kill("SIGKILL");
    throw new Error(`${signal} left the daemon alive after 5s`);
  }
  expect(existsSync(join(dataDir, "daemon.json"))).toBe(false);
  expect(existsSync(join(dataDir, "daemon.lock"))).toBe(false);
}
