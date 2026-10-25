import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";
import { DRIVE_PATHS } from "@you-brain/protocol";

import type { DrivePort } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { makeDaemonDirs, readStatus, testClock, throwingEmbedder, type DaemonDirs } from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("background config push", () => {
  it("returns from config and roles writes while a held Drive push is still waiting", async () => {
    const dirs = await trackDirs("you-brain-config-push-");
    const clock = testClock();
    const control = new ControlledDrive(new MemoryDrive({ now: () => clock.now() }));
    const daemon = await startTracked(dirs, control.drive, clock);
    control.hold();

    const config = await putJson(daemon, "/api/config", { reminders: { notifications: false } });
    const roles = await putJson(daemon, "/api/roles", { consolidation: { time: "04:00" } });
    expect(config.ok).toBe(true);
    expect(roles.ok).toBe(true);

    await control.held;
    expect(control.waiting).toBeGreaterThan(0);
    expect(await readLocal(dirs, "shared.json")).toMatchObject({ reminders: { notifications: false } });
    expect(await readLocal(dirs, "roles.json")).toMatchObject({ consolidation: { time: "04:00" } });

    control.release();
    await daemon.settleConfigPush();
    expect(control.waiting).toBe(0);
    expect(await readDrive(control.drive, DRIVE_PATHS.sharedConfig)).toMatchObject({
      reminders: { notifications: false },
    });
    expect(await readDrive(control.drive, DRIVE_PATHS.roles)).toMatchObject({
      consolidation: { time: "04:00" },
    });
  });

  it("sends only the newest roles value when writes arrive during a push", async () => {
    const dirs = await trackDirs("you-brain-config-latest-");
    const clock = testClock();
    const control = new ControlledDrive(new MemoryDrive({ now: () => clock.now() }));
    const daemon = await startTracked(dirs, control.drive, clock);
    control.hold();

    await putJson(daemon, "/api/roles", { consolidation: { time: "01:00" } });
    await control.held;
    await putJson(daemon, "/api/roles", { consolidation: { time: "02:00" } });
    await putJson(daemon, "/api/roles", { consolidation: { time: "03:00" } });
    control.release();
    await daemon.settleConfigPush();

    expect(control.roleTimesWritten()).toEqual(["01:00", "03:00"]);
    expect(await readDrive(control.drive, DRIVE_PATHS.roles)).toMatchObject({
      consolidation: { time: "03:00" },
    });
    expect(await readLocal(dirs, "roles.json")).toMatchObject({ consolidation: { time: "03:00" } });
  });

  it("reports a failed config push in status and retries it on the next heartbeat", async () => {
    const dirs = await trackDirs("you-brain-config-retry-");
    const clock = testClock();
    const control = new ControlledDrive(new MemoryDrive({ now: () => clock.now() }));
    const daemon = await startTracked(dirs, control.drive, clock);

    await putJson(daemon, "/api/config", { reminders: { notifications: true } });
    await daemon.settleConfigPush();
    expect((await readStatus(daemon)).sync.lastError).toBeNull();

    control.failWrites = true;
    const put = await putJson(daemon, "/api/config", { reminders: { notifications: false } });
    expect(put.ok).toBe(true);
    await daemon.settleConfigPush();
    const failed = await readStatus(daemon);
    expect(failed.sync.lastError?.startsWith("同步失败：上传没有完成")).toBe(true);
    expect(failed.sync.lastErrorAt).toBe(clock.now().toISOString());
    expect(await readDrive(control.drive, DRIVE_PATHS.sharedConfig)).toMatchObject({
      reminders: { notifications: true },
    });

    control.failWrites = false;
    await clock.advance(5 * 60_000);
    await daemon.settled();
    await daemon.settleConfigPush();
    const retried = await readStatus(daemon);
    expect(retried.sync.lastError).toBeNull();
    expect(retried.sync.lastErrorAt).toBeNull();
    expect(await readDrive(control.drive, DRIVE_PATHS.sharedConfig)).toMatchObject({
      reminders: { notifications: false },
    });
  });
});

/**
 * Wraps a MemoryDrive. While held, Drive writes wait on a gate. While failing, they reject.
 * Each write's JSON body is recorded when the write is first attempted.
 */
class ControlledDrive {
  readonly drive: DrivePort;
  failWrites = false;
  waiting = 0;
  readonly #writes: unknown[] = [];
  #gate: Promise<void> | null = null;
  #openGate: () => void = () => undefined;
  #reachGate: () => void = () => undefined;
  #held: Promise<void> = new Promise(() => undefined);

  constructor(inner: MemoryDrive) {
    this.drive = new Proxy(inner, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (property === "update" || property === "create") {
            this.#writes.push(bodyOf(args));
            if (this.#gate) {
              this.waiting += 1;
              this.#reachGate();
              await this.#gate;
              this.waiting -= 1;
            }
            if (this.failWrites) throw new Error("上传没有完成");
          }
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }

  /** Resolves once a write is waiting at the gate. */
  get held(): Promise<void> {
    return this.#held;
  }

  hold(): void {
    this.#writes.length = 0;
    this.#gate = new Promise<void>((resolve) => {
      this.#openGate = resolve;
    });
    this.#held = new Promise<void>((resolve) => {
      this.#reachGate = resolve;
    });
  }

  release(): void {
    this.#gate = null;
    this.#openGate();
  }

  roleTimesWritten(): unknown[] {
    return this.#writes
      .filter((body) => isObject(body) && "consolidation" in body)
      .map((body) => (body as { consolidation: { time: unknown } }).consolidation.time);
  }
}

function bodyOf(args: unknown[]): unknown {
  const first = args[0];
  const raw = isObject(first) && "bytes" in first ? first.bytes : args[1];
  try {
    return JSON.parse(Buffer.from(raw as Buffer | string).toString("utf8"));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function putJson(daemon: YouBrainDaemon, path: string, body: unknown): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function readLocal(dirs: DaemonDirs, name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dirs.dataDir, name), "utf8"));
}

async function readDrive(drive: DrivePort, path: string): Promise<unknown> {
  const object = await drive.readPath(path);
  if (!object) throw new Error(`missing Drive file ${path}`);
  return JSON.parse(object.bytes.toString("utf8"));
}

async function trackDirs(prefix: string): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs(prefix);
  roots.push(dirs.root);
  return dirs;
}

function startTracked(
  dirs: DaemonDirs,
  drive: DrivePort,
  clock: ReturnType<typeof testClock>,
): Promise<YouBrainDaemon> {
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
  }).then(async (daemon) => {
    started.push(daemon);
    await daemon.settled();
    return daemon;
  });
}
