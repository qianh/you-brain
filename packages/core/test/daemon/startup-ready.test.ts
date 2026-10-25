import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import type { DrivePort } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { createStartupLog } from "../../src/daemon/startup-log.js";
import { makeDaemonDirs, readStatus, type DaemonDirs } from "./helpers.js";

const HTTP_READY_MS = 3_000;
const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("startup log", () => {
  it("records one elapsed line per step", async () => {
    const lines: string[] = [];
    const log = createStartupLog((line) => {
      lines.push(line);
    });
    await log.time("openDrive", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^startup: openDrive \d+ms$/u);
  });
});

describe("daemon HTTP readiness", () => {
  it("listens while Drive is still hanging, and search stays unavailable", async () => {
    const dirs = await trackDirs("you-brain-startup-hang-");
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drive = holdFirstCall(new MemoryDrive(), gate);
    const startedAt = performance.now();
    const daemon = await startTracked(dirs, drive);
    expect(performance.now() - startedAt).toBeLessThan(HTTP_READY_MS);
    const status = await readStatus(daemon);
    expect(status.drive.reachable).toBeNull();
    const search = await fetch(`${daemon.baseUrl}/api/search?q=hello`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual({
      query: "hello",
      indexStatus: "stale",
      searchMode: "keyword",
      results: [],
      warnings: [],
    });
    release();
    await daemon.settled();
    expect((await readStatus(daemon)).drive.reachable).toBe(true);
  }, 15_000);

  it("publishes a status change when the Drive check settles, so open pages refresh", async () => {
    const dirs = await trackDirs("you-brain-startup-notify-");
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const daemon = await startTracked(dirs, holdFirstCall(new MemoryDrive(), gate));
    expect((await readStatus(daemon)).drive.reachable).toBeNull();
    const kinds: string[] = [];
    daemon.changes.subscribe((event) => kinds.push(event.kind));
    release();
    await daemon.settled();
    expect(kinds).toContain("status");
    expect((await readStatus(daemon)).drive.reachable).toBe(true);
  }, 15_000);

  it("publishes a status change when the Drive check fails", async () => {
    const dirs = await trackDirs("you-brain-startup-notify-fail-");
    const daemon = await startTracked(dirs, failingDrive());
    const kinds: string[] = [];
    daemon.changes.subscribe((event) => kinds.push(event.kind));
    await daemon.settled();
    expect(kinds).toContain("status");
    expect((await readStatus(daemon)).drive.reachable).toBe(false);
  });

  it("keeps HTTP up when Drive setup fails", async () => {
    const dirs = await trackDirs("you-brain-startup-fail-");
    const startedAt = performance.now();
    const daemon = await startTracked(dirs, failingDrive());
    expect(performance.now() - startedAt).toBeLessThan(HTTP_READY_MS);
    await daemon.settled();
    const status = await readStatus(daemon);
    expect(status.drive.reachable).toBe(false);
    const again = await fetch(`${daemon.baseUrl}/api/status`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(again.status).toBe(200);
  });

  it("returns the unwired search response when Drive is absent", async () => {
    const dirs = await trackDirs("you-brain-startup-nodrive-");
    const daemon = await startDaemon({
      homeDir: dirs.homeDir,
      platform: "darwin",
      env: dirs.env,
      hostname: "device-a",
      drive: null,
      llm: null,
      sourceRoots: {},
      watch: false,
      signals: false,
    });
    started.push(daemon);
    const search = await fetch(`${daemon.baseUrl}/api/search?q=hello`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(search.status).toBe(200);
    const body = (await search.json()) as { indexStatus: string; results: unknown[] };
    expect(body.indexStatus).toBe("stale");
    expect(body.results).toEqual([]);
    expect((await readStatus(daemon)).drive.reachable).toBe(false);
  });
});

function holdFirstCall(inner: MemoryDrive, gate: Promise<void>): DrivePort {
  let held = false;
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const run = async (): Promise<unknown> => {
          if (!held) {
            held = true;
            await gate;
          }
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
        return run();
      };
    },
  }) as DrivePort;
}

function failingDrive(): DrivePort {
  const inner = new MemoryDrive();
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return () => Promise.reject(new Error("drive down"));
    },
  }) as DrivePort;
}

async function trackDirs(prefix: string): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs(prefix);
  roots.push(dirs.root);
  return dirs;
}

function startTracked(dirs: DaemonDirs, drive: DrivePort): Promise<YouBrainDaemon> {
  return startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    drive,
    llm: null,
    embedder: {
      model: "fake",
      revision: "0",
      dimensions: 8,
      embedQuery: () => Promise.reject(new Error("no embedder")),
      embedPassages: () => Promise.reject(new Error("no embedder")),
    },
    sourceRoots: {},
    watch: false,
    signals: false,
  }).then((daemon) => {
    started.push(daemon);
    return daemon;
  });
}
