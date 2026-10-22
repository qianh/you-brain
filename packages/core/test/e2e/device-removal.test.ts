import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { DevicesResponse, VirtualDeviceResponse } from "../../src/http/types.js";
import {
  fakeBackend,
  makeDaemonDirs,
  testClock,
  throwingEmbedder,
  type DaemonDirs,
} from "../daemon/helpers.js";

const daemons: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("device removal across daemons", () => {
  it("drops a virtual device from the other daemon after DELETE", async () => {
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const llm = fakeBackend(async () => "{}");
    const dirsA = await makeDaemonDirs("you-brain-e2e-device-a-");
    const dirsB = await makeDaemonDirs("you-brain-e2e-device-b-");
    roots.push(dirsA.root, dirsB.root);
    const daemonA = await startOne(dirsA, "device-a", clock, drive, llm);
    const daemonB = await startOne(dirsB, "device-b", clock, drive, llm);
    await daemonA.settled();
    await daemonB.settled();

    const created = await postJson<VirtualDeviceResponse>(daemonA, "/api/devices/virtual", {
      displayName: "沉淀机器人",
    });
    const virtualId = created.device.deviceId;
    expect(created.device.kind).toBe("virtual");
    expect((await postJson<{ started: boolean }>(daemonB, "/api/actions/sync", {})).started).toBe(
      true,
    );
    const idA = await deviceId(daemonA);
    const idB = await deviceId(daemonB);
    expect(ids(await getJson<DevicesResponse>(daemonB, "/api/devices"))).toEqual(
      expect.arrayContaining([virtualId, idA, idB]),
    );

    const removed = await send(daemonA, `/api/devices/${virtualId}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    const kinds: string[] = [];
    const stop = daemonB.changes.subscribe((event) => kinds.push(event.kind));
    expect((await postJson<{ started: boolean }>(daemonB, "/api/actions/sync", {})).started).toBe(
      true,
    );
    const left = ids(await getJson<DevicesResponse>(daemonB, "/api/devices"));
    stop();
    expect(kinds).toContain("devices");
    expect(left).not.toContain(virtualId);
    expect(left).toEqual(expect.arrayContaining([idA, idB]));
  });
});

async function startOne(
  dirs: DaemonDirs,
  hostname: string,
  clock: ReturnType<typeof testClock>,
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

function ids(body: DevicesResponse): string[] {
  return body.devices.map((device) => device.deviceId);
}

async function deviceId(daemon: YouBrainDaemon): Promise<string> {
  const status = await getJson<{ deviceId: string }>(daemon, "/api/status");
  return status.deviceId;
}

async function getJson<T>(daemon: YouBrainDaemon, path: string): Promise<T> {
  return readBody<T>(await send(daemon, path));
}

async function postJson<T>(daemon: YouBrainDaemon, path: string, body: unknown): Promise<T> {
  const response = await send(daemon, path, { method: "POST", body: JSON.stringify(body) });
  return readBody<T>(response);
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
