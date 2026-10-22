import { rm } from "node:fs/promises";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { deviceRecordPath, PROTOCOL_VERSION } from "@you-brain/protocol";
import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import {
  ACTIVITY_FUTURE_SLACK_MS,
  ACTIVITY_PAST_LIMIT_MS,
} from "../../src/reminders/activity.js";
import { ACTIVITY_EPOCH } from "../../src/reminders/delivery.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import type { ReminderDelivery } from "../../src/http/types.js";
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

describe("device activity", () => {
  it("keeps lastActiveAt off the heartbeat clock until a real signal arrives", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const daemon = await startTracked(dirs, clock, drive);
    await daemon.settled();

    const startedAt = clock.now().toISOString();
    const first = await readDevices(daemon);
    expect(first.local.lastActiveAt).toBe(ACTIVITY_EPOCH);
    expect(first.local.lastSeenAt).toBe(startedAt);
    const registered = await readDriveDevice(drive, first.local.deviceId);
    expect(registered.lastSeenAt).toBe(startedAt);

    await clock.advance(INTERVALS.heartbeatMs);
    await daemon.settled();
    const heart = clock.now().toISOString();
    const second = await readDevices(daemon);
    expect(second.local.lastSeenAt).toBe(heart);
    expect(second.local.lastActiveAt).toBe(ACTIVITY_EPOCH);
    const driveAfter = await readDriveDevice(drive, second.local.deviceId);
    expect(driveAfter.lastSeenAt).toBe(heart);
    expect(driveAfter.lastActiveAt).toBe(startedAt);

    const activity = new Date(clock.nowMs() - 60_000).toISOString();
    const reported = await postActivity(daemon, { at: activity });
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({ at: activity });
    const third = await readDevices(daemon);
    expect(third.local.lastActiveAt).toBe(activity);

    await clock.advance(INTERVALS.heartbeatMs);
    await daemon.settled();
    const fourth = await readDevices(daemon);
    expect(fourth.local.lastSeenAt).toBe(clock.now().toISOString());
    expect(fourth.local.lastActiveAt).toBe(activity);
    expect(fourth.delivery).toEqual({ notify: true, reason: "ok" });
  }, 30_000);

  it("rejects activity outside an hour behind or a minute ahead, and requires the bearer token", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const daemon = await startTracked(dirs, clock, null);
    await daemon.settled();
    const now = clock.nowMs();

    const missing = await fetch(`${daemon.baseUrl}/api/activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(401);

    const wrong = await postActivity(daemon, {}, "not-the-token");
    expect(wrong.status).toBe(401);

    const get = await fetch(`${daemon.baseUrl}/api/activity`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(get.status).toBe(405);

    const empty = await postActivity(daemon, {});
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ at: new Date(now).toISOString() });

    const ahead = await postActivity(daemon, {
      at: new Date(now + ACTIVITY_FUTURE_SLACK_MS).toISOString(),
    });
    expect(ahead.status).toBe(200);
    expect(await ahead.json()).toEqual({
      at: new Date(now + ACTIVITY_FUTURE_SLACK_MS).toISOString(),
    });

    const behind = await postActivity(daemon, {
      at: new Date(now - ACTIVITY_PAST_LIMIT_MS).toISOString(),
    });
    expect(behind.status).toBe(200);
    const behindBody = (await behind.json()) as { at: string };
    expect(behindBody.at).toBe(new Date(now + ACTIVITY_FUTURE_SLACK_MS).toISOString());

    const tooLate = await postActivity(daemon, {
      at: new Date(now + ACTIVITY_FUTURE_SLACK_MS + 1).toISOString(),
    });
    expect(tooLate.status).toBe(400);
    expect(await tooLate.json()).toEqual({
      error: { code: "INVALID_INPUT", message: "活动时间超出允许范围" },
    });

    const tooEarly = await postActivity(daemon, {
      at: new Date(now - ACTIVITY_PAST_LIMIT_MS - 1).toISOString(),
    });
    expect(tooEarly.status).toBe(400);

    const junk = await postActivity(daemon, { at: "yesterday" });
    expect(junk.status).toBe(400);
    expect(daemon.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
  }, 20_000);

  it("treats a captured session update as activity and decides delivery from it", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const sessionAt = new Date(clock.nowMs() - 2 * 60_000).toISOString();
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("live-1", "user", "Plan the launch checklist", sessionAt),
    ]);
    const daemon = await startTracked(dirs, clock, null, { "claude-code": [dirs.sourceDir] });
    await daemon.settled();

    const seen = await readDevices(daemon);
    expect(seen.local.lastActiveAt).toBe(sessionAt);
    expect(seen.local.lastSeenAt).not.toBe(sessionAt);
    expect(seen.delivery).toEqual({ notify: true, reason: "ok" });

    const otherId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const newer = new Date(clock.nowMs() - 30_000).toISOString();
    writeDevice(dirs, otherId, newer);
    const yielded = await readDevices(daemon);
    expect(yielded.delivery).toEqual({ notify: false, reason: "other-device" });

    const smaller = smallerUuid(seen.local.deviceId);
    writeDevice(dirs, otherId, sessionAt);
    writeDevice(dirs, smaller, sessionAt);
    const tie = await readDevices(daemon);
    expect(smaller < seen.local.deviceId).toBe(true);
    expect(tie.delivery).toEqual({ notify: false, reason: "other-device" });

    deleteDevice(dirs, otherId);
    deleteDevice(dirs, smaller);
    const config = await fetch(`${daemon.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reminders: { notifications: false } }),
    });
    expect(config.status).toBe(200);
    const disabled = await readDevices(daemon);
    expect(disabled.delivery).toEqual({ notify: false, reason: "disabled" });
  }, 20_000);
});

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-activity-");
  roots.push(dirs.root);
  return dirs;
}

async function startTracked(
  dirs: DaemonDirs,
  clock: ReturnType<typeof testClock>,
  drive: MemoryDrive | null,
  sourceRoots: Record<string, string[]> = {},
): Promise<YouBrainDaemon> {
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "activity-device",
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

function postActivity(
  daemon: YouBrainDaemon,
  body: { at?: string },
  token = daemon.token,
): Promise<Response> {
  return fetch(`${daemon.baseUrl}/api/activity`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

interface DeviceView {
  deviceId: string;
  lastSeenAt: string;
  lastActiveAt: string;
}

async function readDevices(daemon: YouBrainDaemon): Promise<{
  local: DeviceView;
  delivery: ReminderDelivery;
}> {
  const headers = { authorization: `Bearer ${daemon.token}` };
  const devicesResponse = await fetch(`${daemon.baseUrl}/api/devices`, { headers });
  const remindersResponse = await fetch(`${daemon.baseUrl}/api/reminders`, { headers });
  const statusResponse = await fetch(`${daemon.baseUrl}/api/status`, { headers });
  const devices = (await devicesResponse.json()) as { devices: DeviceView[] };
  const reminders = (await remindersResponse.json()) as { delivery?: ReminderDelivery };
  const status = (await statusResponse.json()) as { deviceId: string };
  const local = devices.devices.find((item) => item.deviceId === status.deviceId);
  if (!local) throw new Error("local device missing");
  if (!reminders.delivery) throw new Error("delivery missing");
  return { local, delivery: reminders.delivery };
}

function stateFile(dirs: DaemonDirs): string {
  return join(dirs.dataDir, "state.sqlite");
}

function writeDevice(dirs: DaemonDirs, deviceId: string, lastActiveAt: string): void {
  const store = new SqliteStore(stateFile(dirs));
  try {
    store.upsertDevice({
      deviceId,
      displayName: "Other device",
      kind: "desktop",
      platform: "linux",
      appVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ["capture"],
      lastSeenAt: lastActiveAt,
      lastActiveAt,
    });
  } finally {
    store.close();
  }
}

function deleteDevice(dirs: DaemonDirs, deviceId: string): void {
  const db = new Database(stateFile(dirs));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.query("DELETE FROM devices WHERE device_id = ?").run(deviceId);
  } finally {
    db.close();
  }
}

/** A UUID that sorts before `id`, leaving the version and variant nibbles intact. */
function smallerUuid(id: string): string {
  const chars = [...id];
  for (let index = chars.length - 1; index >= 24; index -= 1) {
    const value = Number.parseInt(chars[index] ?? "", 16);
    if (value > 0) {
      chars[index] = (value - 1).toString(16);
      return chars.join("");
    }
  }
  throw new Error(`cannot build a smaller uuid than ${id}`);
}

async function readDriveDevice(
  drive: MemoryDrive,
  deviceId: string,
): Promise<{ lastSeenAt: string; lastActiveAt: string }> {
  const object = await drive.readPath(deviceRecordPath(deviceId));
  if (!object) throw new Error("drive device missing");
  return JSON.parse(object.bytes.toString("utf8")) as {
    lastSeenAt: string;
    lastActiveAt: string;
  };
}
