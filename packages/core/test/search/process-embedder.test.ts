import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { splitEmbedBatches } from "../../src/search/embedder.js";
import {
  ProcessEmbedder,
  embedWorkerCommand,
  type IdleClock,
} from "../../src/search/process-embedder.js";

const workerSource = `
/* extra */
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const vector = [1, ...Array.from({ length: request.dimensions - 1 }, () => 0)];
    if (request.method === "embedQuery") {
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, vector }) + "\\n");
      continue;
    }
    if (request.method === "embedPassages") {
      process.stdout.write(JSON.stringify({
        id: request.id,
        ok: true,
        vectors: (request.texts ?? []).map(() => vector),
      }) + "\\n");
      continue;
    }
    if (request.method === "prepare" || request.method === "shutdown") {
      process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
      if (request.method === "shutdown") process.exit(0);
      continue;
    }
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: "unknown method" }) + "\\n");
  }
}
`;

describe("process embedder", () => {
  it("points the worker command at the source worker", () => {
    expect(embedWorkerCommand()).toEqual([
      "bun",
      expect.stringMatching(/embed-worker\.ts$/u),
    ]);
  });

  it("embeds through a replaceable subprocess", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-embed-worker-"));
    const workerPath = join(directory, "fake-embed-worker.ts");
    await writeFile(workerPath, workerSource);
    const embedder = new ProcessEmbedder({
      command: [process.execPath, workerPath],
      model: "subprocess-test",
      revision: "v1",
      dimensions: 3,
      cacheDir: directory,
    });

    try {
      await embedder.prepare();
      expect(await embedder.embedQuery("release")).toEqual([1, 0, 0]);
      expect(await embedder.embedPassages(["a", "b"])).toEqual([
        [1, 0, 0],
        [1, 0, 0],
      ]);
    } finally {
      await embedder.close();
    }
  });

  it("fails when the worker exits before answering", async () => {
    const embedder = new ProcessEmbedder({
      command: [process.execPath, "-e", "process.exit(1)"],
      model: "subprocess-test",
      revision: "v1",
      dimensions: 3,
      cacheDir: tmpdir(),
    });

    try {
      await expect(embedder.embedQuery("release")).rejects.toThrow(/embed worker/);
    } finally {
      await embedder.close();
    }
  });

  it("uses the packaged binary as the embed-worker when vendor modules exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-vendor-bin-"));
    const binary = join(directory, "you-brain");
    await mkdir(join(directory, "vendor", "node_modules"), { recursive: true });
    await writeFile(binary, "");

    expect(embedWorkerCommand("bun", binary)).toEqual([binary, "embed-worker"]);
  });

  it("splits passage batches on the shared cap", () => {
    expect(splitEmbedBatches(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(splitEmbedBatches([], 8)).toEqual([]);
  });

  it("unloads the worker after idle and starts a new one on the next request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-embed-idle-"));
    const workerPath = join(directory, "fake-embed-worker.ts");
    const pidFile = join(directory, "pids.txt");
    await writeFile(workerPath, workerSource.replace("/* extra */", pidLogger));
    const clock = fakeClock();
    const embedder = new ProcessEmbedder({
      command: [process.execPath, workerPath, pidFile],
      model: "subprocess-test",
      revision: "v1",
      dimensions: 3,
      cacheDir: directory,
      idleMs: 120_000,
      idleClock: clock,
    });

    try {
      await embedder.embedQuery("one");
      expect(clock.timers.at(-1)?.ms).toBe(120_000);
      const first = await pidLines(pidFile);
      expect(first).toHaveLength(1);
      clock.fireLast();
      await waitUntilGone(first[0] ?? "");
      expect(await embedder.embedQuery("two")).toEqual([1, 0, 0]);
      const restarted = await pidLines(pidFile);
      expect(restarted).toHaveLength(2);
      expect(restarted[1]).not.toBe(restarted[0]);
    } finally {
      await embedder.close();
    }
  });

  it("keeps one worker for concurrent requests and ignores a stale idle stop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-embed-concurrent-"));
    const workerPath = join(directory, "fake-embed-worker.ts");
    const pidFile = join(directory, "pids.txt");
    await writeFile(workerPath, workerSource.replace("/* extra */", pidLogger));
    const clock = fakeClock();
    const embedder = new ProcessEmbedder({
      command: [process.execPath, workerPath, pidFile],
      model: "subprocess-test",
      revision: "v1",
      dimensions: 3,
      cacheDir: directory,
      idleMs: 50,
      idleClock: clock,
    });

    try {
      const [left, right] = await Promise.all([
        embedder.embedQuery("left"),
        embedder.embedQuery("right"),
      ]);
      expect(left).toEqual([1, 0, 0]);
      expect(right).toEqual([1, 0, 0]);
      expect(await pidLines(pidFile)).toHaveLength(1);

      await embedder.embedQuery("warm");
      const stale = clock.captureLast();
      const followed = embedder.embedQuery("followed");
      stale();
      expect(await followed).toEqual([1, 0, 0]);
      await Bun.sleep(50);
      const pid = (await pidLines(pidFile))[0] ?? "";
      expect(await pidLines(pidFile)).toEqual([pid]);
      expect(processAlive(pid)).toBe(true);
      expect(await embedder.embedQuery("still")).toEqual([1, 0, 0]);
      expect(await pidLines(pidFile)).toEqual([pid]);
    } finally {
      await embedder.close();
    }
  });

  it("restarts when a request arrives while the idle worker is exiting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-embed-overlap-"));
    const workerPath = join(directory, "fake-embed-worker.ts");
    const pidFile = join(directory, "pids.txt");
    await writeFile(workerPath, workerSource.replace("/* extra */", slowStopLogger));
    const clock = fakeClock();
    const embedder = new ProcessEmbedder({
      command: [process.execPath, workerPath, pidFile],
      model: "subprocess-test",
      revision: "v1",
      dimensions: 3,
      cacheDir: directory,
      idleMs: 10,
      idleClock: clock,
    });

    try {
      await embedder.embedQuery("one");
      const first = (await pidLines(pidFile))[0] ?? "";
      clock.fireLast();
      await waitForText(pidFile, "term");
      expect(await embedder.embedQuery("two")).toEqual([1, 0, 0]);
      const pids = await pidLines(pidFile);
      expect(pids.filter((line) => line !== "term")).toHaveLength(2);
      expect(pids[0]).toBe(first);
      expect(pids.at(-1)).not.toBe(first);
      expect(processAlive(first)).toBe(false);
    } finally {
      await embedder.close();
    }
  });
});

const pidLogger = `
import { appendFileSync } from "node:fs";
appendFileSync(process.argv.at(-1), String(process.pid) + "\\n");
`;

const slowStopLogger = `
import { appendFileSync } from "node:fs";
const pidFile = process.argv.at(-1);
appendFileSync(pidFile, String(process.pid) + "\\n");
const hold = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  appendFileSync(pidFile, "term\\n");
  setTimeout(() => {
    clearInterval(hold);
    process.exit(0);
  }, 400);
});
`;

function fakeClock(): IdleClock & {
  timers: Array<{ ms: number; callback: () => void; cancelled: boolean }>;
  fireLast(): void;
  captureLast(): () => void;
} {
  const timers: Array<{ ms: number; callback: () => void; cancelled: boolean }> = [];
  return {
    timers,
    schedule(ms, callback) {
      const timer = { ms, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fireLast() {
      const timer = [...timers].reverse().find((item) => !item.cancelled);
      if (!timer) throw new Error("no idle timer");
      timer.cancelled = true;
      timer.callback();
    },
    captureLast() {
      const timer = [...timers].reverse().find((item) => !item.cancelled);
      if (!timer) throw new Error("no idle timer");
      return timer.callback;
    },
  };
}

async function pidLines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((line) => line.length > 0 && line !== "term");
}

function processAlive(pid: string): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(pid)) return;
    await Bun.sleep(20);
  }
  throw new Error(`worker ${pid} is still running`);
}

async function waitForText(path: string, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await readFile(path, "utf8")).includes(needle)) return;
    } catch {
      // The worker has not written yet.
    }
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${needle}`);
}
