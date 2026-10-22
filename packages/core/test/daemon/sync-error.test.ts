import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import { YouBrainError } from "../../src/domain/errors.js";
import type { DrivePort } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { describeSyncFailure } from "../../src/daemon/sync-error.js";
import { makeDaemonDirs, readStatus, testClock, throwingEmbedder, type DaemonDirs } from "./helpers.js";

const SECRET = "ya29.SUPERSECRET";
const SENSITIVE = `拉取没有完成 https://www.googleapis.com/drive/v3/files/abc?access_token=${SECRET} Authorization: Bearer ${SECRET}`;

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("describeSyncFailure", () => {
  it("turns a Chinese failure into short copy and strips tokens, headers, and query strings", () => {
    const message = describeSyncFailure(new Error(SENSITIVE));
    expect(message.startsWith("同步失败：拉取没有完成")).toBe(true);
    expect(message).toContain("https://www.googleapis.com/drive/v3/files/abc");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("access_token");
    expect(message).not.toContain("Bearer");
    expect(message).not.toContain("?");
    expect([...message].length).toBeLessThanOrEqual(200);
  });

  it("uses a fixed sentence for auth, cursor, and timeout failures", () => {
    const leaked = `https://www.googleapis.com/drive/v3/changes?pageToken=${SECRET}`;
    expect(describeSyncFailure(Object.assign(new Error(leaked), { response: { status: 401 } }))).toBe(
      "同步失败：Google 授权无效，请重新登录",
    );
    expect(describeSyncFailure(new Error(`Invalid pageToken ${SECRET}`))).toBe("同步失败：变更游标无效");
    expect(describeSyncFailure(Object.assign(new Error("hang"), { code: "ETIMEDOUT" }))).toBe("同步失败：请求超时");
    expect(describeSyncFailure(new YouBrainError("AUTH_REQUIRED", `Bearer ${SECRET}`))).toBe(
      "同步失败：Google 授权无效，请重新登录",
    );
  });

  it("truncates a long Chinese message to 200 characters", () => {
    const message = describeSyncFailure(new Error(`拉取没有完成 ${"字".repeat(400)}`));
    expect([...message].length).toBe(200);
    expect(message.startsWith("同步失败：拉取没有完成")).toBe(true);
  });

  it("does not pass an English dump through", () => {
    expect(describeSyncFailure(new Error("drive down"))).toBe("同步失败");
    expect(describeSyncFailure("nope")).toBe("同步失败");
  });
});

describe("daemon sync error", () => {
  it("records a failed pull, keeps it across a later flush, and clears it after a successful pull", async () => {
    const dirs = await trackDirs("you-brain-sync-error-");
    const clock = testClock();
    let failPull = false;
    const drive = flakyDrive(new MemoryDrive({ now: () => clock.now() }), () => failPull);
    const daemon = await startTracked(dirs, drive, clock);
    await daemon.settled();
    expect((await readStatus(daemon)).sync.lastError ?? null).toBeNull();

    failPull = true;
    const denied = await fetch(`${daemon.baseUrl}/api/actions/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(denied.ok).toBe(false);
    const deniedBody = await denied.text();
    expect(deniedBody).not.toContain(SECRET);
    expect(deniedBody).not.toContain("access_token");
    expect(deniedBody).not.toContain("Bearer");
    const failed = await readStatus(daemon);
    expect(failed.sync.lastError?.startsWith("同步失败：拉取没有完成")).toBe(true);
    expect(failed.sync.lastError).not.toContain(SECRET);
    expect(failed.sync.lastError).not.toContain("?");
    expect(failed.sync.lastErrorAt).toBe(clock.now().toISOString());
    expect(failed.drive.reachable).toBe(false);

    failPull = false;
    const restored = await fetch(`${daemon.baseUrl}/api/actions/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(restored.ok).toBe(true);
    const cleared = await readStatus(daemon);
    expect(cleared.sync.lastError).toBeNull();
    expect(cleared.sync.lastErrorAt).toBeNull();
    expect(cleared.sync.lastSyncAt).toBe(clock.now().toISOString());
    expect(cleared.drive.reachable).toBe(true);

    failPull = true;
    await clock.advance(60_000);
    await daemon.settled();
    const polled = await readStatus(daemon);
    expect(polled.sync.lastError?.startsWith("同步失败：拉取没有完成")).toBe(true);
    expect(polled.sync.lastError).not.toContain(SECRET);
    expect(polled.drive.reachable).toBe(false);

    failPull = false;
    await clock.advance(30_000);
    await daemon.settled();
    const flushed = await readStatus(daemon);
    expect(flushed.sync.lastError?.startsWith("同步失败：拉取没有完成")).toBe(true);
    expect(flushed.drive.reachable).toBe(true);
    expect(flushed.sync.pendingOutbox).toBe(0);

    await clock.advance(30_000);
    await daemon.settled();
    const pulled = await readStatus(daemon);
    expect(pulled.sync.lastError).toBeNull();
    expect(pulled.sync.lastErrorAt).toBeNull();
    expect(pulled.drive.reachable).toBe(true);
  }, 20_000);
});

function flakyDrive(inner: MemoryDrive, fail: () => boolean): DrivePort {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (fail() && (property === "list" || property === "changes")) {
          return Promise.reject(new Error(SENSITIVE));
        }
        return (value as (...input: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as DrivePort;
}

async function trackDirs(prefix: string): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs(prefix);
  roots.push(dirs.root);
  return dirs;
}

function startTracked(dirs: DaemonDirs, drive: DrivePort, clock: ReturnType<typeof testClock>): Promise<YouBrainDaemon> {
  return startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    clock,
    drive,
    llm: null,
    embedder: throwingEmbedder,
    sourceRoots: {},
    watch: false,
    signals: false,
  }).then((daemon) => {
    started.push(daemon);
    return daemon;
  });
}
