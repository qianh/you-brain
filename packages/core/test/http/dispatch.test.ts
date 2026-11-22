import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemorySecretStore } from "../../src/auth/secret-store.js";
import { DeviceIdentity, DispatchExecutor, DispatchHub, type DispatchT3Port } from "../../src/dispatch/index.js";
import { createDaemonClient, DaemonClientError } from "../../src/http/client.js";
import type { DeckHttpPort, DispatchHttpPort, HttpDeps } from "../../src/http/deps.js";
import { createDispatchHttpPort } from "../../src/http/handlers.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";
import type { DeckTelegramActionBody, DeckTelegramStatusResponse, DispatchOutboxEntry } from "../../src/http/types.js";
import { FakeRelay } from "../dispatch/fake-relay.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yb-http-dispatch-"));
  dirs.push(dir);
  return dir;
}

function call(server: DaemonHttpServer, method: string, path: string, body?: unknown) {
  return fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${server.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function makeFakeT3(projects = [{ id: "p1", name: "you-brain", cwd: "/repo" }]): DispatchT3Port {
  return {
    projects: async () => projects,
    launchThread: async () => ({ threadId: "t-1", threadUrl: "http://127.0.0.1:3773/t-1" }),
    followup: async () => undefined,
    inspect: async () => ({ state: "ready", summary: "ok" }),
    threadStates: async () => [],
    latestAnswer: async () => "",
  };
}

describe("HTTP /api/dispatch/* routes and validation", () => {
  it("routes all endpoints, validates inputs (400/405/404), and handles enroll-relay", async () => {
    const entry: DispatchOutboxEntry = {
      dispatchId: "d-1",
      to: "dev-b",
      deviceName: "Mac B",
      projectId: "p1",
      title: "修 Bug",
      mode: "auto",
      cmdId: "c-1",
      threadId: "t-1",
      threadUrl: "http://127.0.0.1:3773/t-1",
      status: "running",
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
    };

    const calls: Array<{ name: string; args: unknown }> = [];
    const dispatch: DispatchHttpPort = {
      async devices() {
        calls.push({ name: "devices", args: null });
        return {
          self: { deviceId: "dev-a", name: "Mac A" },
          connected: true,
          enrolled: true,
          devices: [
            { id: "dev-a", name: "Mac A", online: true, self: true, enrolled: true },
            {
              id: "dev-b",
              name: "Mac B",
              online: true,
              self: false,
              enrolled: true,
              dispatch: { enabled: true, t3: { ready: true }, projects: [{ id: "p1", name: "you-brain" }], maxMode: "auto" },
            },
          ],
        };
      },
      async startThread(body) {
        calls.push({ name: "startThread", args: body });
        if (body.to === "dev-fail") {
          return {
            ok: false,
            dispatchId: "d-fail",
            error: "目标设备不在线",
            entry: { ...entry, dispatchId: "d-fail", status: "failed", error: "目标设备不在线" },
          };
        }
        return {
          ok: true,
          dispatchId: "d-1",
          threadId: "t-1",
          threadUrl: "http://127.0.0.1:3773/t-1",
          mode: body.mode ?? "auto",
          capped: false,
          entry,
        };
      },
      async followup(dispatchId, body) {
        calls.push({ name: "followup", args: { dispatchId, body } });
        return { ok: true, dispatchId, threadId: "t-1" };
      },
      async outbox() {
        calls.push({ name: "outbox", args: null });
        return { entries: [entry] };
      },
      async getOutbox(dispatchId, opts) {
        calls.push({ name: "getOutbox", args: { dispatchId, opts } });
        if (dispatchId === "missing") return null;
        return {
          entry,
          refreshed: opts?.refresh === true,
          ...(opts?.refresh ? { read: { state: "ready" as const, summary: "完成了", link: "https://t3/t-1" } } : {}),
        };
      },
      async send(body) {
        calls.push({ name: "send", args: body });
        return { ok: true, result: { projects: [{ id: "p1", name: "you-brain" }] } };
      },
      async policy() {
        return {
          policy: { enabled: false, viewT3: false, notify: true, maxMode: "auto", allowedSenders: [], allowedProjects: [] },
          projects: [{ id: "p1", name: "you-brain" }],
          knownSenders: [],
        };
      },
      async updatePolicy(body) {
        calls.push({ name: "updatePolicy", args: body });
        return {
          policy: { enabled: body.enabled ?? false, viewT3: false, notify: true, maxMode: body.maxMode ?? "auto", allowedSenders: [], allowedProjects: body.allowedProjects ?? [] },
          projects: [{ id: "p1", name: "you-brain" }],
          knownSenders: [],
        };
      },
    };

    const telegramActions: DeckTelegramActionBody[] = [];
    const telegramStatus: DeckTelegramStatusResponse = {
      configured: true,
      bot: null,
      connection: "ok",
      error: null,
      bound: null,
      notificationsEnabled: false,
      pairing: null,
      relay: null,
    };
    const deck = {
      telegramStatus: async () => telegramStatus,
      telegramAction: async (body: DeckTelegramActionBody) => {
        telegramActions.push(body);
        return telegramStatus;
      },
    } as Pick<DeckHttpPort, "telegramStatus" | "telegramAction"> as DeckHttpPort;

    const server = await startDaemonHttp({ dataDir: tempDir(), deps: { dispatch, deck } as HttpDeps });
    const client = createDaemonClient({ port: server.port, token: server.token });
    try {
      const devices = await client.dispatchDevices!();
      expect(devices.self).toEqual({ deviceId: "dev-a", name: "Mac A" });
      expect(devices.connected).toBe(true);
      expect(devices.devices).toHaveLength(2);

      // 正常派活
      const started = await client.dispatchStartThread!({
        to: "dev-b",
        projectId: "p1",
        title: "修 Bug",
        prompt: "排查一下",
        mode: "auto",
      });
      expect(started.ok).toBe(true);

      // 业务失败仍 HTTP 200，ok:false 带中文错误
      const bizFail = await call(server, "POST", "/api/dispatch/threads", {
        to: "dev-fail",
        projectId: "p1",
        title: "任务",
        prompt: "试试",
      });
      expect(bizFail.status).toBe(200);
      expect(await bizFail.json()).toMatchObject({ ok: false, error: "目标设备不在线" });

      // 校验错误 -> 400（拒绝 approval-required、空 prompt、缺少必填字段）
      expect(
        (await call(server, "POST", "/api/dispatch/threads", {
          to: "dev-b",
          projectId: "p1",
          title: "任务",
          prompt: "执行",
          mode: "approval-required",
        })).status,
      ).toBe(400);
      expect(
        (await call(server, "POST", "/api/dispatch/threads", {
          to: "dev-b",
          projectId: "p1",
          title: "任务",
          prompt: "   ",
        })).status,
      ).toBe(400);
      expect((await call(server, "POST", "/api/dispatch/threads", { to: "dev-b" })).status).toBe(400);

      // outbox 列表、单项、?refresh=1、404
      expect((await client.dispatchOutbox!()).entries).toHaveLength(1);
      const cached = await client.dispatchOutboxItem!("d-1");
      expect(cached.refreshed).toBe(false);
      const refreshed = await client.dispatchOutboxItem!("d-1", { refresh: true });
      expect(refreshed.refreshed).toBe(true);
      expect(refreshed.read?.summary).toBe("完成了");
      expect((await call(server, "GET", "/api/dispatch/outbox/missing")).status).toBe(404);

      // followup + 校验
      expect(await client.dispatchFollowup!("d-1", { prompt: "继续" })).toEqual({
        ok: true,
        dispatchId: "d-1",
        threadId: "t-1",
      });
      expect((await call(server, "POST", "/api/dispatch/outbox/d-1/followup", { prompt: "" })).status).toBe(400);

      // send
      expect(await client.dispatchSend!({ to: "dev-b", kind: "t3.projects", args: {} })).toEqual({
        ok: true,
        result: { projects: [{ id: "p1", name: "you-brain" }] },
      });
      expect((await call(server, "POST", "/api/dispatch/send", { kind: "t3.projects", args: {} })).status).toBe(400);

      // policy 拒绝 approval-required
      expect((await call(server, "PUT", "/api/dispatch/policy", { maxMode: "approval-required" })).status).toBe(400);
      expect((await call(server, "DELETE", "/api/dispatch/policy")).status).toBe(405);
      expect((await call(server, "POST", "/api/dispatch/devices")).status).toBe(405);

      // enroll-relay 通过 telegram action 校验与 client.deckTelegramAction
      await client.deckTelegramAction!({
        action: "enroll-relay",
        url: "https://relay.example.com",
        code: "ABCD1234",
        name: "Mac A",
      });
      expect(telegramActions).toEqual([
        { action: "enroll-relay", url: "https://relay.example.com", code: "ABCD1234", name: "Mac A" },
      ]);
      expect((await call(server, "POST", "/api/deck/telegram", { action: "enroll-relay", url: "https://relay.example.com" })).status).toBe(400);
    } finally {
      await server.stop();
    }
  });
});

describe("createDispatchHttpPort policy resolution & executor checks", () => {
  it("fills allowedSenders publicKey from relay state, rejects un-enrolled peers (400), calls refreshHello, and returns 409 without executor", async () => {
    const dirA = tempDir();
    const dirB = tempDir();
    const dirC = tempDir();
    const relay = new FakeRelay();

    const idA = new DeviceIdentity({ store: new MemorySecretStore(null) });
    const idB = new DeviceIdentity({ store: new MemorySecretStore(null) });
    const idC = new DeviceIdentity({ store: new MemorySecretStore(null) });
    const keyA = (await idA.ensure()).publicKey;
    const keyB = (await idB.ensure()).publicKey;

    let hubB!: DispatchHub;
    const execB = new DispatchExecutor({
      dataDir: dirB,
      deviceId: "dev-b",
      t3: makeFakeT3([
        { id: "p1", name: "you-brain", cwd: "/repo" },
        { id: "p2", name: "other", cwd: "/other" },
      ]),
      emitEvent: (to, frame) => hubB.emitEvent(to, frame),
    });
    hubB = new DispatchHub({ dataDir: dirB, deviceId: "dev-b", deviceName: "Mac B", identity: idB, executor: execB });
    const hubA = new DispatchHub({ dataDir: dirA, deviceId: "dev-a", deviceName: "Mac A", identity: idA, executor: null });
    const hubC = new DispatchHub({ dataDir: dirC, deviceId: "dev-c", deviceName: "Legacy C", identity: idC, executor: null });

    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: keyA, hub: hubA, enrolled: true });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: keyB, hub: hubB, enrolled: true });
    relay.connect({ deviceId: "dev-c", name: "Legacy C", publicKey: "", hub: hubC, enrolled: false });

    const portB = createDispatchHttpPort({
      hub: hubB,
      executor: execB,
      deviceId: "dev-b",
      selfName: () => "Mac B",
      isConnected: () => true,
      isEnrolled: () => true,
      projects: async () => [
        { id: "p1", name: "you-brain" },
        { id: "p2", name: "other" },
      ],
    });
    const serverB = await startDaemonHttp({ dataDir: dirB, deps: { dispatch: portB } as HttpDeps });
    const clientB = createDaemonClient({ port: serverB.port, token: serverB.token });

    // 无 executor 的发起端节点 A
    const portA = createDispatchHttpPort({
      hub: hubA,
      executor: null,
      deviceId: "dev-a",
      selfName: () => "Mac A",
      isConnected: () => true,
      isEnrolled: () => true,
      projects: async () => {
        throw new Error("T3 unavailable");
      },
    });
    const serverA = await startDaemonHttp({ dataDir: dirA, deps: { dispatch: portA } as HttpDeps });
    const clientA = createDaemonClient({ port: serverA.port, token: serverA.token });

    try {
      // GET policy：包含全部项目、knownSenders 不含自己
      const initial = await clientB.dispatchPolicy!();
      expect(initial.projects).toEqual([
        { id: "p1", name: "you-brain" },
        { id: "p2", name: "other" },
      ]);
      expect(initial.knownSenders.map((s) => s.deviceId).sort()).toEqual(["dev-a", "dev-c"]);
      expect(initial.knownSenders.find((s) => s.deviceId === "dev-a")).toEqual({
        deviceId: "dev-a",
        name: "Mac A",
        enrolled: true,
        publicKey: keyA,
      });

      // PUT policy 填入 dev-a 的公钥并触发 refreshHello
      const hellosBefore = relay.hellos.filter((h) => h.from === "dev-b").length;
      const updated = await clientB.updateDispatchPolicy!({
        enabled: true,
        maxMode: "full-access",
        allowedProjects: ["p1"],
        allowedSenders: ["dev-a"],
      });
      expect(updated.policy.enabled).toBe(true);
      expect(updated.policy.maxMode).toBe("full-access");
      expect(updated.policy.allowedProjects).toEqual(["p1"]);
      expect(updated.policy.allowedSenders).toEqual([
        { deviceId: "dev-a", name: "Mac A", publicKey: keyA },
      ]);
      expect(relay.hellos.filter((h) => h.from === "dev-b").length).toBeGreaterThan(hellosBefore);

      // 未入网设备（dev-c）或未知设备 -> 400「该设备尚未入网，无法允许」
      for (const badSender of ["dev-c", "dev-unknown"]) {
        const res = await call(serverB, "PUT", "/api/dispatch/policy", { allowedSenders: [badSender] });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toBe("该设备尚未入网，无法允许");
      }

      // 拒绝 approval-required
      expect((await call(serverB, "PUT", "/api/dispatch/policy", { maxMode: "approval-required" })).status).toBe(400);

      // 无 executor 的节点 A：GET 降级返回 projects: []，PUT 返回 409「本机不支持接收派活」
      const policyA = await clientA.dispatchPolicy!();
      expect(policyA.projects).toEqual([]);
      let err409: unknown = null;
      try {
        await clientA.updateDispatchPolicy!({ enabled: true });
      } catch (error) {
        err409 = error;
      }
      expect(err409).toBeInstanceOf(DaemonClientError);
      expect((err409 as DaemonClientError).status).toBe(409);
      expect((err409 as DaemonClientError).message).toBe("本机不支持接收派活");
    } finally {
      await serverB.stop();
      await serverA.stop();
    }
  });
});
