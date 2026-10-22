import { rm } from "node:fs/promises";
import { join } from "node:path";

import { deviceRecordPath } from "@you-brain/protocol";
import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { ManualDaemonClock } from "../../src/daemon/clock.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { RemindersResponse, TopicListItem } from "../../src/http/types.js";
import { STALE_MS } from "../../src/reminders/due.js";
import { ACTIVITY_WINDOW_MS } from "../../src/reminders/delivery.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import {
  CLOCK_START,
  claudeLine,
  fakeBackend,
  makeDaemonDirs,
  testClock,
  throwingEmbedder,
  writeClaudeSession,
  type DaemonDirs,
} from "../daemon/helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_AT = new Date(CLOCK_START.getTime() - 8 * DAY_MS).toISOString();

const daemons: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("reminders on two devices", () => {
  it("issues one stale reminder, delivers it to the latest device, and snoozes across the sync", async () => {
    let clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const llm = fakeBackend(async () =>
      JSON.stringify({
        title: "停滞事项",
        summary: "一周没有新的讨论",
        topic: { action: "create", topicId: "", name: "停滞事项", aliases: [] },
        conclusions_added: [],
        todos_added: [{ text: "还没做完", confidence: 0.9 }],
        todos_completed: [],
      }),
    );
    const dirsA = await makeDaemonDirs("you-brain-e2e-remind-a-");
    const dirsB = await makeDaemonDirs("you-brain-e2e-remind-b-");
    roots.push(dirsA.root, dirsB.root);
    await writeClaudeSession(dirsA.sourceDir, [
      claudeLine("stale-1", "user", "这个事项先放着", SESSION_AT),
      claudeLine("stale-1", "assistant", "待办还开着。", SESSION_AT),
    ]);

    let daemonA = await startOne(dirsA, "device-a", clock, drive, llm);
    let daemonB = await startOne(dirsB, "device-b", clock, drive, llm);
    await daemonA.settled();
    await daemonB.settled();
    const idA = await deviceId(daemonA);
    const idB = await deviceId(daemonB);

    expect((await putJson(daemonA, "/api/roles", { mainDevice: idA })).status).toBe(200);
    expect(
      (await putJson(daemonA, "/api/config", { reminders: { notifications: false } })).status,
    ).toBe(200);
    expect((await postJson<{ started: boolean }>(daemonB, "/api/actions/sync", {})).started).toBe(
      true,
    );
    const rolesB = await getJson<{ mainDevice: string | null }>(daemonB, "/api/roles");
    const configB = await getJson<{ reminders: { notifications: boolean } }>(daemonB, "/api/config");
    expect(rolesB.mainDevice).toBe(idA);
    expect(configB.reminders.notifications).toBe(false);

    const uploaded = await postJson<{ uploaded: number }>(daemonA, "/api/actions/upload", {
      backfill: true,
    });
    expect(uploaded.uploaded).toBeGreaterThan(0);
    const topics = await getJson<{ topics: TopicListItem[] }>(daemonA, "/api/topics?zone=active");
    const topic = topics.topics.find((item) => item.openTodoCount >= 1);
    expect(topic?.lastActive).toBeTruthy();
    expect(clock.nowMs() - Date.parse(topic?.lastActive ?? "")).toBeGreaterThanOrEqual(STALE_MS);

    await advanceUntil(clock, async () => staleIds(await reminders(daemonA)).length > 0, {
      stepMs: INTERVALS.flushMs,
      limitMs: INTERVALS.reminderMs + INTERVALS.flushMs,
    });
    await clock.advance(INTERVALS.flushMs);
    expect((await postJson<{ started: boolean }>(daemonB, "/api/actions/sync", {})).started).toBe(
      true,
    );

    const onA = await reminders(daemonA);
    const onB = await reminders(daemonB);
    const staleA = staleIds(onA);
    const staleB = staleIds(onB);
    expect(staleA).toHaveLength(1);
    expect(staleB).toEqual(staleA);
    const reminderId = staleA[0] ?? "";
    expect(issuedEventIds([dirsA, dirsB], reminderId).size).toBe(1);
    expect(onA.delivery).toEqual({ notify: false, reason: "disabled" });
    expect(onB.delivery).toEqual({ notify: false, reason: "disabled" });

    await daemonA.stop();
    daemonA = await startOne(dirsA, "device-a", clock, drive, llm);
    await daemonA.settled();
    expect(await deviceId(daemonA)).toBe(idA);
    expect(staleIds(await reminders(daemonA))).toEqual([reminderId]);
    expect(issuedEventIds([dirsA, dirsB], reminderId).size).toBe(1);

    expect(
      (await putJson(daemonA, "/api/config", { reminders: { notifications: true } })).status,
    ).toBe(200);
    expect((await postJson<{ started: boolean }>(daemonB, "/api/actions/sync", {})).started).toBe(
      true,
    );
    expect(
      (await getJson<{ reminders: { notifications: boolean } }>(daemonB, "/api/config")).reminders
        .notifications,
    ).toBe(true);

    const earlier = new Date(clock.nowMs() - 20_000).toISOString();
    const later = new Date(clock.nowMs() - 5_000).toISOString();
    expect(await postJson<{ at: string }>(daemonA, "/api/activity", { at: earlier })).toEqual({
      at: earlier,
    });
    expect(await postJson<{ at: string }>(daemonB, "/api/activity", { at: later })).toEqual({
      at: later,
    });
    await advanceUntil(
      clock,
      async () =>
        (await driveActiveAt(drive, idA)) === earlier &&
        (await driveActiveAt(drive, idB)) === later &&
        (await seenActiveAt(daemonB, idA)) === earlier &&
        (await seenActiveAt(daemonA, idB)) === later,
      { stepMs: INTERVALS.flushMs, limitMs: INTERVALS.heartbeatMs + 2 * INTERVALS.pullMs },
    );
    const freshA = await reminders(daemonA);
    const freshB = await reminders(daemonB);
    expect(freshB.delivery).toEqual({ notify: true, reason: "ok" });
    expect(freshA.delivery).toEqual({ notify: false, reason: "other-device" });

    const quietFor = laterMs(later) + ACTIVITY_WINDOW_MS + 1_000 - clock.nowMs();
    if (quietFor > 0) await clock.advance(quietFor);
    expect(clock.nowMs() - laterMs(later)).toBeGreaterThan(ACTIVITY_WINDOW_MS);
    expect((await reminders(daemonA)).delivery).toEqual({ notify: false, reason: "inactive" });
    expect((await reminders(daemonB)).delivery).toEqual({ notify: false, reason: "inactive" });
    expect(await driveActiveAt(drive, idA)).toBe(earlier);
    expect(await driveActiveAt(drive, idB)).toBe(later);

    const tie = new Date(clock.nowMs() - 1_000).toISOString();
    expect(await postJson<{ at: string }>(daemonA, "/api/activity", { at: tie })).toEqual({
      at: tie,
    });
    expect(await postJson<{ at: string }>(daemonB, "/api/activity", { at: tie })).toEqual({
      at: tie,
    });
    await advanceUntil(
      clock,
      async () =>
        (await driveActiveAt(drive, idA)) === tie &&
        (await driveActiveAt(drive, idB)) === tie &&
        (await seenActiveAt(daemonA, idB)) === tie &&
        (await seenActiveAt(daemonB, idA)) === tie,
      { stepMs: INTERVALS.flushMs, limitMs: INTERVALS.heartbeatMs + 2 * INTERVALS.pullMs },
    );
    const smaller = idA < idB ? daemonA : daemonB;
    const larger = smaller === daemonA ? daemonB : daemonA;
    expect((await reminders(smaller)).delivery).toEqual({ notify: true, reason: "ok" });
    expect((await reminders(larger)).delivery).toEqual({ notify: false, reason: "other-device" });

    const until = new Date(clock.nowMs() + 8 * DAY_MS).toISOString();
    const snoozed = await postJson<{ status: string; reminderId: string }>(
      daemonB,
      "/api/actions/reminder",
      { reminderId, action: "snooze", until },
    );
    expect(snoozed).toMatchObject({ reminderId, status: "snoozed" });
    await clock.advance(INTERVALS.flushMs);
    expect((await postJson<{ started: boolean }>(daemonA, "/api/actions/sync", {})).started).toBe(
      true,
    );
    expect(staleIds(await reminders(daemonA))).not.toContain(reminderId);
    const hidden = (await reminders(daemonA, true)).reminders.find(
      (item) => item.reminderId === reminderId,
    );
    expect(hidden?.status).toBe("snoozed");

    await daemonA.stop();
    await daemonB.stop();
    clock = new ManualDaemonClock(new Date(laterMs(until) + 1_000));
    daemonA = await startOne(dirsA, "device-a", clock, drive, llm);
    daemonB = await startOne(dirsB, "device-b", clock, drive, llm);
    await daemonA.settled();
    await daemonB.settled();
    await clock.advance(INTERVALS.flushMs + INTERVALS.pullMs);
    expect((await postJson<{ started: boolean }>(daemonB, "/api/actions/sync", {})).started).toBe(
      true,
    );

    const againA = staleIds(await reminders(daemonA));
    const againB = staleIds(await reminders(daemonB));
    expect(againA.length).toBeGreaterThan(0);
    expect(againB).toEqual(againA);
    const nextId = againA.find((id) => id !== reminderId);
    expect(nextId).toBeTruthy();
    expect(issuedEventIds([dirsA, dirsB], nextId ?? "").size).toBe(1);
    expect(issuedEventIds([dirsA, dirsB], reminderId).size).toBe(1);
  }, 180_000);
});

async function startOne(
  dirs: DaemonDirs,
  hostname: string,
  clock: ManualDaemonClock,
  drive: MemoryDrive,
  llm: ReturnType<typeof fakeBackend>,
): Promise<YouBrainDaemon> {
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname,
    clock,
    drive,
    llm,
    embedder: throwingEmbedder,
    sourceRoots: { "claude-code": [dirs.sourceDir] },
    watch: false,
    signals: false,
  });
  daemons.push(daemon);
  return daemon;
}

async function advanceUntil(
  clock: ManualDaemonClock,
  ready: () => Promise<boolean>,
  options: { stepMs: number; limitMs: number },
): Promise<void> {
  let waited = 0;
  while (!(await ready())) {
    if (waited >= options.limitMs) {
      throw new Error(`condition not met within ${options.limitMs}ms`);
    }
    await clock.advance(options.stepMs);
    waited += options.stepMs;
  }
}

function staleIds(body: RemindersResponse): string[] {
  return body.reminders.filter((item) => item.kind === "stale").map((item) => item.reminderId);
}

function laterMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid time ${iso}`);
  return ms;
}

function issuedEventIds(dirs: readonly DaemonDirs[], reminderId: string): Set<string> {
  const ids = new Set<string>();
  for (const dir of dirs) {
    const store = new SqliteStore(join(dir.dataDir, "state.sqlite"));
    try {
      for (const event of store.listEvents()) {
        if (event.type === "reminder.issued" && event.data.reminderId === reminderId) {
          ids.add(event.id);
        }
      }
    } finally {
      store.close();
    }
  }
  return ids;
}

async function driveActiveAt(drive: MemoryDrive, id: string): Promise<string | null> {
  const object = await drive.readPath(deviceRecordPath(id));
  if (!object) return null;
  const body = JSON.parse(object.bytes.toString("utf8")) as { lastActiveAt?: string };
  return body.lastActiveAt ?? null;
}

async function seenActiveAt(daemon: YouBrainDaemon, id: string): Promise<string | null> {
  const body = await getJson<{ devices: Array<{ deviceId: string; lastActiveAt: string }> }>(
    daemon,
    "/api/devices",
  );
  return body.devices.find((item) => item.deviceId === id)?.lastActiveAt ?? null;
}

async function deviceId(daemon: YouBrainDaemon): Promise<string> {
  const status = await getJson<{ deviceId: string }>(daemon, "/api/status");
  return status.deviceId;
}

async function reminders(daemon: YouBrainDaemon, all = false): Promise<RemindersResponse> {
  return getJson<RemindersResponse>(daemon, all ? "/api/reminders?all=1" : "/api/reminders");
}

async function getJson<T>(daemon: YouBrainDaemon, path: string): Promise<T> {
  return readBody<T>(await send(daemon, path));
}

async function postJson<T>(daemon: YouBrainDaemon, path: string, body: unknown): Promise<T> {
  const response = await send(daemon, path, { method: "POST", body: JSON.stringify(body) });
  return readBody<T>(response);
}

async function putJson(daemon: YouBrainDaemon, path: string, body: unknown): Promise<Response> {
  return send(daemon, path, { method: "PUT", body: JSON.stringify(body) });
}

async function send(daemon: YouBrainDaemon, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${daemon.token}`);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${daemon.baseUrl}${path}`, { ...init, headers });
}

async function readBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.url} ${text}`);
  return JSON.parse(text) as T;
}
