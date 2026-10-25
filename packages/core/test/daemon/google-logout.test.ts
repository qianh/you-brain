import { existsSync, readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { MemorySecretStore } from "../../src/auth/secret-store.js";
import {
  startDaemon,
  type DaemonOptions,
  type YouBrainDaemon,
} from "../../src/daemon/daemon.js";
import type { OpenGoogleDriveOptions } from "../../src/daemon/google.js";
import type { DrivePort } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { writeLocalConfig, type LocalConfig } from "../../src/domain/index.js";
import { makeDaemonDirs, readStatus, testClock, throwingEmbedder, type DaemonDirs } from "./helpers.js";

type Opened = { drive: DrivePort; config: LocalConfig };

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Google sign-out and account switch", () => {
  it("signs out, revokes the grant, deletes the credential and keeps local data", async () => {
    const h = await harness();
    await login(h, "john@example.com", "perm-john");
    expect((await readStatus(h.daemon)).drive).toEqual({ reachable: true, accountEmail: "john@example.com" });
    expect(await readFile(join(h.dirs.dataDir, "config.toml"), "utf8")).toContain("john@example.com");

    const response = await post(h.daemon, "/api/actions/google-logout");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "已退出 john@example.com，本机数据已保留" });

    expect(h.revoked).toEqual(["token=refresh-1"]);
    expect(await h.secrets.get()).toBeNull();
    expect((await readStatus(h.daemon)).drive).toEqual({ reachable: false, accountEmail: null });
    const saved = await readFile(join(h.dirs.dataDir, "config.toml"), "utf8");
    expect(saved).not.toContain("john@example.com");
    expect(saved).not.toContain("drive-root-id");
    expect(existsSync(join(h.dirs.dataDir, "state.sqlite"))).toBe(true);
  });

  it("still signs out when Google cannot be reached, and says so", async () => {
    const h = await harness({ revokeFails: true });
    await login(h, "john@example.com", "perm-john");

    const response = await post(h.daemon, "/api/actions/google-logout");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; message: string };
    expect(body.message).toContain("已退出 john@example.com");
    expect(body.message).toContain("未能通知 Google 撤销授权");
    expect(await h.secrets.get()).toBeNull();
    expect((await readStatus(h.daemon)).drive.accountEmail).toBeNull();
  });

  it("reports nothing to do when nobody is signed in", async () => {
    const h = await harness();
    const response = await post(h.daemon, "/api/actions/google-logout");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "当前没有登录的 Google 账号" });
    expect(h.revoked).toEqual([]);
  });

  it("refuses to sign out while a login waits for the browser", async () => {
    const h = await harness();
    const gate = deferred<void>();
    h.script(async (options) => {
      await gate.promise;
      return opened(h.drive, options.local, "john@example.com", "perm-john");
    });
    const pending = post(h.daemon, "/api/actions/google-login");
    await h.called();

    const response = await post(h.daemon, "/api/actions/google-logout");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("LOGIN_IN_PROGRESS");
    gate.resolve();
    await pending;
  });

  it("lets the same account sign back in after a sign-out", async () => {
    const h = await harness();
    await login(h, "john@example.com", "perm-john");
    await post(h.daemon, "/api/actions/google-logout");

    const again = await login(h, "john@example.com", "perm-john");
    expect(again.status).toBe(200);
    expect((await readStatus(h.daemon)).drive).toEqual({ reachable: true, accountEmail: "john@example.com" });
  });

  it("rejects another account after a sign-out and leaves nothing signed in", async () => {
    const h = await harness();
    await login(h, "john@example.com", "perm-john");
    await post(h.daemon, "/api/actions/google-logout");
    h.revoked.length = 0;

    const other = await login(h, "mary@example.com", "perm-mary");
    expect(other.status).toBe(409);
    const body = (await other.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ACCOUNT_MISMATCH");
    expect(body.error.message).toContain("mary@example.com");
    expect(body.error.message).toContain("切换账号");
    expect(await h.secrets.get()).toBeNull();
    expect((await readStatus(h.daemon)).drive).toEqual({ reachable: false, accountEmail: null });
    expect(h.revoked).toEqual(["token=refresh-2"]);
  });

  it("switch signs out, moves the state aside and stops, so any account can sign in next", async () => {
    const h = await harness();
    await login(h, "john@example.com", "perm-john");
    const stateFile = join(h.dirs.dataDir, "state.sqlite");
    expect(existsSync(stateFile)).toBe(true);

    const response = await post(h.daemon, "/api/actions/google-switch");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
    expect(await h.secrets.get()).toBeNull();

    await h.daemon.closed;
    expect(existsSync(stateFile)).toBe(false);
    const backups = readdirSync(join(h.dirs.dataDir, "backups"));
    expect(backups).toHaveLength(1);
    expect(existsSync(join(h.dirs.dataDir, "backups", backups[0] ?? "", "state.sqlite"))).toBe(true);

    // The supervisor starts the daemon again; a different account is now accepted.
    const next = await harness({ dirs: h.dirs });
    const other = await login(next, "mary@example.com", "perm-mary");
    expect(other.status).toBe(200);
    expect((await readStatus(next.daemon)).drive.accountEmail).toBe("mary@example.com");
  });
});

interface Harness {
  daemon: YouBrainDaemon;
  dirs: DaemonDirs;
  drive: MemoryDrive;
  secrets: MemorySecretStore;
  revoked: string[];
  script(step: (options: OpenGoogleDriveOptions) => Promise<Opened>): void;
  called(): Promise<void>;
}

async function harness(options: { revokeFails?: boolean; dirs?: DaemonDirs } = {}): Promise<Harness> {
  const dirs = options.dirs ?? (await makeDaemonDirs("you-brain-google-logout-"));
  if (!options.dirs) roots.push(dirs.root);
  const clock = testClock();
  const drive = new MemoryDrive({ now: () => clock.now() });
  const secrets = new MemorySecretStore(null);
  const revoked: string[] = [];
  let grants = 0;
  let step: ((options: OpenGoogleDriveOptions) => Promise<Opened>) | null = null;
  let firstCall = deferred<void>();
  const googleOpen: NonNullable<DaemonOptions["googleOpen"]> = async (open) => {
    firstCall.resolve();
    if (!step) throw new Error("no scripted login step");
    grants += 1;
    await secrets.set(JSON.stringify({ refresh_token: `refresh-${grants}` }));
    const result = await step(open);
    // The real opener saves the account to the config file, so the mock does too.
    await writeLocalConfig(open.configFile, result.config);
    return result;
  };
  const revokeFetch = ((_url: unknown, init?: RequestInit) => {
    if (options.revokeFails) return Promise.reject(new Error("offline"));
    revoked.push(String(init?.body));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  const daemon = await startDaemon({
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
    drive: null,
    secrets,
    googleOpen,
    revokeFetch,
  });
  started.push(daemon);
  await daemon.settled();
  return {
    daemon,
    dirs,
    drive,
    secrets,
    revoked,
    script: (next) => {
      step = next;
      firstCall = deferred<void>();
    },
    called: () => firstCall.promise,
  };
}

/** One login attempt that ends with the given account. */
function login(h: Harness, email: string, permissionId: string): Promise<Response> {
  h.script(async (options) => opened(h.drive, options.local, email, permissionId));
  return post(h.daemon, "/api/actions/google-login");
}

function opened(drive: DrivePort, local: LocalConfig, email: string, permissionId: string): Opened {
  return {
    drive,
    config: {
      ...local,
      driveRootId: "drive-root-id",
      account: { email, displayName: "Name", permissionId },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function post(daemon: YouBrainDaemon, path: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}` },
  });
}
