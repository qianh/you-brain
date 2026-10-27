import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { platformPaths } from "../../src/domain/paths.js";
import { createDefaultLocalConfig, type DeviceRole } from "../../src/domain/config.js";
import { writeLocalConfig } from "../../src/domain/config-io.js";
import type { StatusResponse } from "../../src/http/types.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import {
  claudeLine,
  makeDaemonDirs,
  testClock,
  throwingEmbedder,
  writeClaudeSession,
  type DaemonDirs,
} from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-role-");
  roots.push(dirs.root);
  return dirs;
}

/** 预写 config.toml，模拟已跑过 setup 的机器。 */
async function seedConfig(dirs: DaemonDirs, role: DeviceRole): Promise<void> {
  const paths = platformPaths({ platform: "darwin", homeDir: dirs.homeDir, env: dirs.env });
  const config = createDefaultLocalConfig({
    hostname: "seeded",
    dataDir: paths.dataDir,
    role,
  });
  await writeLocalConfig(paths.configFile, config);
}

async function start(
  dirs: DaemonDirs,
  drive: MemoryDrive | null,
  sourceRoots: Record<string, string[]> = {},
): Promise<YouBrainDaemon> {
  const clock = testClock();
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "role-device",
    clock,
    drive,
    llm: null,
    embedder: throwingEmbedder,
    sourceRoots,
    watch: false,
    signals: false,
  });
  started.push(daemon);
  return daemon;
}

async function localDevice(daemon: YouBrainDaemon): Promise<{
  kind: string;
  capabilities: string[];
}> {
  const headers = { authorization: `Bearer ${daemon.token}` };
  const status = (await (await fetch(`${daemon.baseUrl}/api/status`, { headers })).json()) as
    StatusResponse;
  const body = (await (await fetch(`${daemon.baseUrl}/api/devices`, { headers })).json()) as {
    devices: Array<{ deviceId: string; kind: string; capabilities: string[] }>;
  };
  const local = body.devices.find((device) => device.deviceId === status.deviceId);
  if (!local) throw new Error("local device missing");
  return { kind: local.kind, capabilities: local.capabilities };
}

describe("device role", () => {
  it("registers a server as kind server without the capture capability", async () => {
    const dirs = await trackDirs();
    await seedConfig(dirs, "server");
    const clock = testClock();
    const daemon = await start(dirs, new MemoryDrive({ now: () => clock.now() }));
    await daemon.settled();

    const device = await localDevice(daemon);
    expect(device.kind).toBe("server");
    expect(device.capabilities).toEqual(["refine", "consolidate"]);
  }, 30_000);

  it("keeps a desktop device on capture and refine", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const daemon = await start(dirs, new MemoryDrive({ now: () => clock.now() }));
    await daemon.settled();

    const device = await localDevice(daemon);
    expect(device.kind).toBe("desktop");
    expect(device.capabilities).toEqual(["capture", "refine"]);
  }, 30_000);

  it("does not scan or upload local CLI sessions on a server", async () => {
    const dirs = await trackDirs();
    await seedConfig(dirs, "server");
    const sessionFile = await writeClaudeSession(dirs.sourceDir, [
      claudeLine("server-session", "user", "服务器上不该采集这条", "2026-10-18T01:00:00.000Z"),
      claudeLine("server-session", "assistant", "嗯", "2026-10-18T01:00:10.000Z"),
    ]);
    const clock = testClock();
    const daemon = await start(dirs, new MemoryDrive({ now: () => clock.now() }), {
      "claude-code": [dirs.sourceDir],
    });
    await daemon.settled();
    await daemon.scan();
    await daemon.settled();

    const store = new SqliteStore(platformPaths({
      platform: "darwin",
      homeDir: dirs.homeDir,
      env: dirs.env,
    }).stateFile);
    try {
      expect(store.listSessions()).toHaveLength(0);
      expect(store.countOutbox()).toBe(0);
    } finally {
      store.close();
    }
    expect(sessionFile.length).toBeGreaterThan(0);
  }, 30_000);

  it("still scans local sessions on a desktop device", async () => {
    const dirs = await trackDirs();
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("desktop-session", "user", "桌面设备要采集这条", "2026-10-18T01:00:00.000Z"),
      claudeLine("desktop-session", "assistant", "好", "2026-10-18T01:00:10.000Z"),
    ]);
    const clock = testClock();
    const daemon = await start(dirs, new MemoryDrive({ now: () => clock.now() }), {
      "claude-code": [dirs.sourceDir],
    });
    await daemon.settled();

    // 扫描结果先落到 capture.files 指纹；会话进库要等空闲上传那一轮。
    const store = new SqliteStore(platformPaths({
      platform: "darwin",
      homeDir: dirs.homeDir,
      env: dirs.env,
    }).stateFile);
    try {
      const raw = store.getCursor("capture.files");
      const files = raw === null ? [] : (JSON.parse(raw) as unknown[]);
      expect(Array.isArray(files) ? files.length : 0).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  }, 30_000);
});
