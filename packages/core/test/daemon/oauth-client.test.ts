import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { platformPaths } from "../../src/domain/paths.js";
import { createDefaultLocalConfig } from "../../src/domain/config.js";
import { writeLocalConfig } from "../../src/domain/config-io.js";
import type { OAuthClientPublic } from "../../src/http/types.js";
import {
  makeDaemonDirs,
  testClock,
  throwingEmbedder,
  type DaemonDirs,
} from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-oauth-client-");
  roots.push(dirs.root);
  return dirs;
}

function paths(dirs: DaemonDirs) {
  return platformPaths({ platform: "darwin", homeDir: dirs.homeDir, env: dirs.env });
}

async function start(dirs: DaemonDirs): Promise<YouBrainDaemon> {
  const clock = testClock();
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    clock,
    drive: new MemoryDrive({ now: () => clock.now() }),
    llm: null,
    embedder: throwingEmbedder,
    sourceRoots: {},
    watch: false,
    signals: false,
  });
  started.push(daemon);
  await daemon.settled();
  return daemon;
}

async function read(daemon: YouBrainDaemon): Promise<OAuthClientPublic> {
  const response = await fetch(`${daemon.baseUrl}/api/oauth-client`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as OAuthClientPublic;
}

async function put(
  daemon: YouBrainDaemon,
  body: unknown,
  token = daemon.token,
): Promise<Response> {
  return fetch(`${daemon.baseUrl}/api/oauth-client`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("OAuth client credentials over the API", () => {
  it("stores a custom client id and secret without echoing the secret", async () => {
    const dirs = await trackDirs();
    const daemon = await start(dirs);
    const before = await read(daemon);
    expect(before.mode).toBe("official");
    expect(before.hasClientSecret).toBe(false);

    const response = await put(daemon, {
      mode: "custom",
      clientId: "mine.apps.googleusercontent.com",
      clientSecret: "super-secret",
    });
    expect(response.status).toBe(200);
    const after = (await response.json()) as OAuthClientPublic;
    expect(after).toEqual({
      mode: "custom",
      clientId: "mine.apps.googleusercontent.com",
      hasClientSecret: true,
      officialAvailable: expect.any(Boolean) as boolean,
    });
    // secret 永远不回显，config.toml 里也不留。
    expect(JSON.stringify(after)).not.toContain("super-secret");
    const config = await readFile(paths(dirs).configFile, "utf8");
    expect(config).toContain("mine.apps.googleusercontent.com");
    expect(config).not.toContain("super-secret");
  });

  it("rejects a client id without the Google suffix", async () => {
    const dirs = await trackDirs();
    const daemon = await start(dirs);
    const response = await put(daemon, {
      mode: "custom",
      clientId: "not-a-google-id",
      clientSecret: "s",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain(".apps.googleusercontent.com");
    expect((await read(daemon)).mode).toBe("official");
  });

  it("keeps the stored secret when only the client id changes", async () => {
    const dirs = await trackDirs();
    const daemon = await start(dirs);
    await put(daemon, {
      mode: "custom",
      clientId: "first.apps.googleusercontent.com",
      clientSecret: "first-secret",
    });

    const changed = await put(daemon, {
      mode: "custom",
      clientId: "second.apps.googleusercontent.com",
    });
    expect(changed.status).toBe(200);
    const body = (await changed.json()) as OAuthClientPublic;
    expect(body.clientId).toBe("second.apps.googleusercontent.com");
    expect(body.hasClientSecret).toBe(true);
  });

  it("refuses an id-only change when nothing was stored yet", async () => {
    const dirs = await trackDirs();
    const daemon = await start(dirs);
    const response = await put(daemon, {
      mode: "custom",
      clientId: "mine.apps.googleusercontent.com",
    });
    expect(response.status).toBe(400);
    expect((await read(daemon)).mode).toBe("official");
  });

  it("switching back to official drops the custom secret", async () => {
    const dirs = await trackDirs();
    const daemon = await start(dirs);
    await put(daemon, {
      mode: "custom",
      clientId: "mine.apps.googleusercontent.com",
      clientSecret: "secret",
    });
    const back = await put(daemon, { mode: "official" });
    expect(back.status).toBe(200);
    const body = (await back.json()) as OAuthClientPublic;
    expect(body.mode).toBe("official");
    expect(body.clientId).toBe("");
    expect(body.hasClientSecret).toBe(false);
  });

  it("requires the bearer token", async () => {
    const dirs = await trackDirs();
    const daemon = await start(dirs);
    const unauthorized = await fetch(`${daemon.baseUrl}/api/oauth-client`);
    expect(unauthorized.status).toBe(401);
    expect((await put(daemon, { mode: "official" }, "wrong-token")).status).toBe(401);
  });

  it("uses the file secret backend on a server-role device", async () => {
    const dirs = await trackDirs();
    const config = createDefaultLocalConfig({
      hostname: "srv",
      dataDir: paths(dirs).dataDir,
      role: "server",
    });
    await writeLocalConfig(paths(dirs).configFile, config);
    const daemon = await start(dirs);
    await put(daemon, {
      mode: "custom",
      clientId: "mine.apps.googleusercontent.com",
      clientSecret: "server-secret",
    });
    const secrets = JSON.parse(
      await readFile(join(paths(dirs).dataDir, "secrets.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.values(secrets)).toContain("server-secret");
    expect((await read(daemon)).hasClientSecret).toBe(true);
  });
});
