import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import {
  startDaemon,
  type DaemonOptions,
  type YouBrainDaemon,
} from "../../src/daemon/daemon.js";
import type { OpenGoogleDriveOptions } from "../../src/daemon/google.js";
import type { DrivePort } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { YouBrainError } from "../../src/domain/errors.js";
import type { LocalConfig } from "../../src/domain/config.js";
import { makeDaemonDirs, readStatus, testClock, throwingEmbedder, type DaemonDirs } from "./helpers.js";

type Opened = { drive: DrivePort; config: LocalConfig };
type Opener = NonNullable<DaemonOptions["googleOpen"]>;

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Google login from the daemon", () => {
  it("connects Drive after a login without a restart, then reports the account", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const login = scriptedLogin(async (options) => opened(drive, options.local, "john@example.com"));
    const daemon = await startTracked(dirs, clock, { drive: null, googleOpen: login.opener });

    const before = await readStatus(daemon);
    expect(before.drive).toEqual({ reachable: false, accountEmail: null });

    const first = await post(daemon, "/api/actions/google-login");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, message: "已使用 john@example.com 登录" });
    await daemon.settled();

    const after = await readStatus(daemon);
    expect(after.drive).toEqual({ reachable: true, accountEmail: "john@example.com" });
    expect(login.calls).toHaveLength(1);
    expect(login.calls[0]).toMatchObject({ interactive: true, platform: "darwin" });
    expect(login.calls[0]?.signal?.aborted).toBe(false);
  });

  it("returns ok without a second connection once Drive is already open", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const login = scriptedLogin(async (options) => opened(drive, options.local, "john@example.com"));
    const daemon = await startTracked(dirs, clock, { drive: null, googleOpen: login.opener });

    expect((await post(daemon, "/api/actions/google-login")).status).toBe(200);
    const again = await post(daemon, "/api/actions/google-login");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, message: "已登录为 john@example.com" });
    expect(login.calls).toHaveLength(1);
  });

  it("does not run the browser flow when Drive was opened at startup", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const login = scriptedLogin(async () => {
      throw new Error("must not open the browser");
    });
    const daemon = await startTracked(dirs, clock, { drive, googleOpen: login.opener });

    const response = await post(daemon, "/api/actions/google-login");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "已登录" });
    expect(login.calls).toHaveLength(0);
  });

  it("rejects a second login while the first waits for the browser", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const gate = deferred<void>();
    const login = scriptedLogin(async (options) => {
      await gate.promise;
      return opened(drive, options.local, "john@example.com");
    });
    const daemon = await startTracked(dirs, clock, { drive: null, googleOpen: login.opener });

    const first = post(daemon, "/api/actions/google-login");
    await login.called;
    const second = await post(daemon, "/api/actions/google-login");
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: { code: "LOGIN_IN_PROGRESS", message: "登录进行中，请在浏览器完成授权" },
    });

    gate.resolve();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({
      ok: true,
      message: "已使用 john@example.com 登录",
    });
    expect(login.calls).toHaveLength(1);
  });

  it("returns the 409 message from a failed browser step and allows a retry", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const login = scriptedLogin(
      async () => {
        throw new YouBrainError("AUTH_REQUIRED", "Google 登录等待超时，请重试");
      },
      async (options) => opened(drive, options.local, "john@example.com"),
    );
    const daemon = await startTracked(dirs, clock, { drive: null, googleOpen: login.opener });

    const failed = await post(daemon, "/api/actions/google-login");
    expect(failed.status).toBe(409);
    expect(await failed.json()).toEqual({
      error: { code: "AUTH_REQUIRED", message: "Google 登录等待超时，请重试" },
    });
    expect((await readStatus(daemon)).drive).toEqual({ reachable: false, accountEmail: null });

    const retried = await post(daemon, "/api/actions/google-login");
    expect(retried.status).toBe(200);
    expect(login.calls).toHaveLength(2);
  });

  it("cancels the browser wait when the daemon stops, so stop returns promptly", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const login = scriptedLogin(
      (options) =>
        new Promise<Opened>((_, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new YouBrainError("AUTH_REQUIRED", "Google 登录已取消")),
            { once: true },
          );
        }),
    );
    const daemon = await startTracked(dirs, clock, { drive: null, googleOpen: login.opener });

    const pending = post(daemon, "/api/actions/google-login").catch((error: unknown) => error);
    await login.called;
    await daemon.stop();
    expect(login.calls[0]?.signal?.aborted).toBe(true);
    await daemon.closed;
    await pending;
  });
});

function opened(drive: DrivePort, local: LocalConfig, email: string): Opened {
  return {
    drive,
    config: {
      ...local,
      driveRootId: "drive-root-id",
      account: { email, displayName: "John", permissionId: "permission-id" },
    },
  };
}

/** Each entry runs for one call. The last entry repeats. */
function scriptedLogin(...steps: Array<(options: OpenGoogleDriveOptions) => Promise<Opened>>): {
  opener: Opener;
  calls: OpenGoogleDriveOptions[];
  called: Promise<void>;
} {
  const calls: OpenGoogleDriveOptions[] = [];
  const first = deferred<void>();
  const opener: Opener = async (options) => {
    calls.push(options);
    first.resolve();
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (!step) throw new Error("no scripted login step");
    return step(options);
  };
  return { opener, calls, called: first.promise };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-google-login-");
  roots.push(dirs.root);
  return dirs;
}

function startTracked(
  dirs: DaemonDirs,
  clock: ReturnType<typeof testClock>,
  extra: Pick<DaemonOptions, "drive" | "googleOpen">,
): Promise<YouBrainDaemon> {
  return startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    clock,
    llm: null,
    embedder: throwingEmbedder,
    sourceRoots: {},
    watch: false,
    signals: false,
    ...extra,
  }).then(async (daemon) => {
    started.push(daemon);
    await daemon.settled();
    return daemon;
  });
}

function post(daemon: YouBrainDaemon, path: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}` },
  });
}
