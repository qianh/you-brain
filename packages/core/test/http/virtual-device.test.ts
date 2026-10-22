import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDefaultRoles,
  createDefaultSharedConfig,
  createVirtualDeviceRecord,
  type DeviceRecord,
  type Roles,
} from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import type { HttpDeps } from "../../src/http/deps.js";
import { HttpError } from "../../src/http/handlers.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";

const NOW = new Date("2026-10-18T03:00:00.000Z");
const DESKTOP = "11111111-1111-4111-8111-111111111111";

function desktop(): DeviceRecord {
  return {
    deviceId: DESKTOP,
    displayName: "这台 Mac",
    kind: "desktop",
    platform: "darwin",
    appVersion: "0.1.0",
    protocolVersion: 1,
    capabilities: ["capture"],
    lastSeenAt: NOW.toISOString(),
    lastActiveAt: NOW.toISOString(),
  };
}

function deps(input: {
  devices: DeviceRecord[];
  roles?: Roles;
  registerVirtualDevice?: HttpDeps["registerVirtualDevice"];
  removeVirtualDevice?: HttpDeps["removeVirtualDevice"];
}): HttpDeps {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    today: unused,
    topics: unused,
    topic: async () => null,
    todo: async () => null,
    portrait: async () => null,
    portraitSnapshots: async () => [],
    portraitCorrections: async () => [],
    search: unused,
    devices: async () => input.devices,
    readRoles: async () => input.roles ?? createDefaultRoles(),
    writeRoles: async () => undefined,
    readConfig: async () => createDefaultSharedConfig(),
    writeConfig: async () => undefined,
    status: unused,
    reminders: async () => ({ reminders: [] }),
    reminder: async () => null,
    reportActivity: async (at) => ({ at }),
    now: () => NOW,
    sync: async () => ({ started: false, at: NOW.toISOString() }),
    upload: unused,
    events: { emit() {} },
    ...(input.registerVirtualDevice ? { registerVirtualDevice: input.registerVirtualDevice } : {}),
    ...(input.removeVirtualDevice ? { removeVirtualDevice: input.removeVirtualDevice } : {}),
  };
}

async function withServer(
  httpDeps: HttpDeps,
  run: (server: DaemonHttpServer) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "you-brain-virtual-http-"));
  const server = await startDaemonHttp({ dataDir, deps: httpDeps, createId: () => "01J00000000000000000000000" });
  try {
    await run(server);
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function api(server: DaemonHttpServer, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${server.token}`);
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

describe("virtual device HTTP", () => {
  it("creates a virtual device and publishes a devices change", async () => {
    const devices: DeviceRecord[] = [];
    await withServer(
      deps({
        devices,
        registerVirtualDevice: async (record) => {
          devices.push(record);
          return record;
        },
      }),
      async (server) => {
        const stream = await api(server, "/api/events");
        const reader = stream.body?.getReader();
        if (!reader) throw new Error("missing stream");
        const created = await api(server, "/api/devices/virtual", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: " 沉淀机器人 ", capabilities: ["consolidate"] }),
        });
        expect(created.status).toBe(200);
        const body = (await created.json()) as { device: DeviceRecord };
        expect(body.device.kind).toBe("virtual");
        expect(body.device.platform).toBe("bot");
        expect(body.device.displayName).toBe("沉淀机器人");
        expect(body.device.capabilities).toEqual(["consolidate"]);
        expect(body.device.lastSeenAt).toBe(NOW.toISOString());
        const decoder = new TextDecoder();
        let text = "";
        const started = Date.now();
        while (!text.includes("event: devices") && Date.now() - started < 2000) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value);
        }
        expect(text).toContain("event: devices");
        await reader.cancel();
      },
    );
  });

  it("returns 404, 409, and 503 for removal", async () => {
    const virtual = createVirtualDeviceRecord({
      deviceId: "44444444-4444-4444-8444-444444444444",
      displayName: "沉淀机器人",
      now: NOW,
    });
    const roles = createDefaultRoles();
    roles.mainDevice = virtual.deviceId;
    await withServer(
      deps({
        devices: [desktop(), virtual],
        roles,
        removeVirtualDevice: async () => undefined,
      }),
      async (server) => {
        const missing = await api(server, "/api/devices/55555555-5555-4555-8555-555555555555", {
          method: "DELETE",
        });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: { code: "NOT_FOUND", message: "设备不存在" } });

        const desktopResponse = await api(server, `/api/devices/${DESKTOP}`, { method: "DELETE" });
        expect(desktopResponse.status).toBe(409);
        expect(((await desktopResponse.json()) as { error: { code: string } }).error.code).toBe("NOT_VIRTUAL");

        const inUse = await api(server, `/api/devices/${virtual.deviceId}`, { method: "DELETE" });
        expect(inUse.status).toBe(409);
        const inUseBody = (await inUse.json()) as { error: { code: string; message: string } };
        expect(inUseBody.error.code).toBe("DEVICE_IN_USE");
        expect(inUseBody.error.message).toContain("主设备");
      },
    );

    await withServer(deps({ devices: [virtual] }), async (server) => {
      const response = await api(server, `/api/devices/${virtual.deviceId}`, { method: "DELETE" });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "DRIVE_UNAVAILABLE", message: "Drive 未就绪" },
      });
    });

    await withServer(
      deps({
        devices: [virtual],
        removeVirtualDevice: async () => {
          throw new HttpError(503, "DRIVE_UNAVAILABLE", "Drive 未就绪");
        },
      }),
      async (server) => {
        const response = await api(server, `/api/devices/${virtual.deviceId}`, { method: "DELETE" });
        expect(response.status).toBe(503);
      },
    );
  });

  it("removes a virtual device that is not a role target", async () => {
    const virtual = createVirtualDeviceRecord({
      deviceId: "44444444-4444-4444-8444-444444444444",
      displayName: "沉淀机器人",
      now: NOW,
    });
    const removed: string[] = [];
    await withServer(
      deps({
        devices: [virtual],
        roles: { ...createDefaultRoles(), webProcessor: DESKTOP },
        removeVirtualDevice: async (deviceId) => {
          removed.push(deviceId);
        },
      }),
      async (server) => {
        const response = await api(server, `/api/devices/${virtual.deviceId}`, { method: "DELETE" });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(removed).toEqual([virtual.deviceId]);
      },
    );
  });
});
