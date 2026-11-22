import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryKeychain, MemorySecretStore } from "../../src/auth/secret-store.js";
import { dispatchIdentityStore, telegramRelayTokenStore } from "../../src/auth/telegram-secrets.js";
import { createDispatchEventHandler, resolveDispatchDeviceId } from "../../src/daemon/daemon.js";
import type { T3ThreadBrief } from "../../src/deck/t3/automation.js";
import type { TelegramDispatchNotice } from "../../src/deck/telegram/index.js";
import { DeviceIdentity, DispatchExecutor, DispatchHub, type DispatchT3Port } from "../../src/dispatch/index.js";
import { createDaemonClient } from "../../src/http/client.js";
import type { HttpDeps } from "../../src/http/deps.js";
import { createDispatchHttpPort } from "../../src/http/handlers.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";
import { FakeRelay } from "./fake-relay.js";

interface ThreadRow {
  title: string;
  status: string;
  link: string | null;
  state: "planning" | "running" | "ready" | "failed";
  summary: string;
  error?: string;
}

class FakeT3 implements DispatchT3Port {
  projectsImpl = [
    { id: "p1", name: "you-brain", cwd: "/repo" },
    { id: "p2", name: "other", cwd: "/other" },
  ];
  launches: Array<{ projectId: string; title: string; prompt: string; requestId: string; runtimeMode: string }> = [];
  followups: Array<{ threadId: string; prompt: string; commandId: string }> = [];
  threads = new Map<string, ThreadRow>();

  async projects() {
    return this.projectsImpl;
  }

  async launchThread(input: {
    projectId: string;
    title: string;
    prompt: string;
    requestId: string;
    runtimeMode: "auto-accept-edits" | "auto" | "full-access";
  }) {
    this.launches.push(input);
    const threadId = `thread-${this.launches.length}`;
    this.threads.set(threadId, {
      title: input.title,
      status: "running",
      link: `https://t3.example/${threadId}`,
      state: "running",
      summary: "",
    });
    return { threadId, threadUrl: `http://127.0.0.1:3773/env/${threadId}` };
  }

  async followup(threadId: string, prompt: string, commandId: string) {
    this.followups.push({ threadId, prompt, commandId });
    const row = this.threads.get(threadId);
    if (row) {
      row.status = "running";
      row.state = "running";
    }
  }

  async inspect(threadId: string) {
    const row = this.threads.get(threadId);
    if (!row) return { state: "failed" as const, summary: "", error: "不存在" };
    return {
      state: row.state,
      summary: row.summary,
      ...(row.error !== undefined ? { error: row.error } : {}),
    };
  }

  async threadStates(): Promise<T3ThreadBrief[]> {
    return [...this.threads.entries()].map(([threadId, row]) => ({
      threadId,
      title: row.title,
      status: row.status,
      latestRunId: null,
      snoozed: false,
      link: row.link,
    }));
  }

  async latestAnswer() {
    return "";
  }
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out: ${label}`);
}

const dirs: string[] = [];
const servers: DaemonHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yb-dispatch-e2e-"));
  dirs.push(dir);
  return dir;
}

describe("two-daemon HTTP + FakeRelay end-to-end dispatch", () => {
  it("A dispatches via HTTP -> B creates thread -> B status changes -> A outbox & Telegram push update", async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    const relay = new FakeRelay();

    const idA = new DeviceIdentity({ store: new MemorySecretStore(null) });
    const idB = new DeviceIdentity({ store: new MemorySecretStore(null) });
    const keyA = (await idA.ensure()).publicKey;
    const keyB = (await idB.ensure()).publicKey;

    const t3A = new FakeT3();
    const t3B = new FakeT3();
    const bNotifications: Array<{ fromName: string; projectName: string; title: string }> = [];
    const aTelegramPushes: TelegramDispatchNotice[] = [];

    let hubA!: DispatchHub;
    const eventsA = createDispatchEventHandler({
      read: (dispatchId) => hubA.read(dispatchId),
      push: (notice) => aTelegramPushes.push(notice),
    });
    const execA = new DispatchExecutor({
      dataDir: dirA,
      deviceId: "dev-a-1111",
      t3: t3A,
      emitEvent: (to, frame) => hubA.emitEvent(to, frame),
    });
    hubA = new DispatchHub({
      dataDir: dirA,
      deviceId: "dev-a-1111",
      deviceName: "Mac A",
      identity: idA,
      executor: execA,
      onEvent: (entry, event) => {
        void eventsA.onEvent(entry, event);
      },
    });

    let hubB!: DispatchHub;
    const execB = new DispatchExecutor({
      dataDir: dirB,
      deviceId: "dev-b-2222",
      t3: t3B,
      emitEvent: (to, frame) => hubB.emitEvent(to, frame),
      notify: (info) => bNotifications.push(info),
    });
    hubB = new DispatchHub({
      dataDir: dirB,
      deviceId: "dev-b-2222",
      deviceName: "Mac B",
      identity: idB,
      executor: execB,
    });

    relay.connect({ deviceId: "dev-a-1111", name: "Mac A", publicKey: keyA, hub: hubA });
    relay.connect({ deviceId: "dev-b-2222", name: "Mac B", publicKey: keyB, hub: hubB });
    await until(() => relay.hellos.length >= 2, "initial hellos");

    const serverA = await startDaemonHttp({
      dataDir: dirA,
      deps: {
        dispatch: createDispatchHttpPort({
          hub: hubA,
          executor: execA,
          deviceId: "dev-a-1111",
          selfName: () => "Mac A",
          isConnected: () => true,
          isEnrolled: () => true,
          projects: async () => (await t3A.projects()).map(({ id, name }) => ({ id, name })),
          onFollowup: (dispatchId) => eventsA.reset(dispatchId),
        }),
      } as HttpDeps,
    });
    const serverB = await startDaemonHttp({
      dataDir: dirB,
      deps: {
        dispatch: createDispatchHttpPort({
          hub: hubB,
          executor: execB,
          deviceId: "dev-b-2222",
          selfName: () => "Mac B",
          isConnected: () => true,
          isEnrolled: () => true,
          projects: async () => (await t3B.projects()).map(({ id, name }) => ({ id, name })),
        }),
      } as HttpDeps,
    });
    servers.push(serverA, serverB);

    const clientA = createDaemonClient({ port: serverA.port, token: serverA.token });
    const clientB = createDaemonClient({ port: serverB.port, token: serverB.token });

    // 1. B 通过 HTTP 配置策略：开启接收派活、允许 dev-a-1111、允许项目 p1、上限 auto
    const policyB = await clientB.updateDispatchPolicy!({
      enabled: true,
      maxMode: "auto",
      allowedProjects: ["p1"],
      allowedSenders: ["dev-a-1111"],
    });
    expect(policyB.policy.enabled).toBe(true);
    expect(policyB.policy.allowedSenders).toEqual([
      { deviceId: "dev-a-1111", name: "Mac A", publicKey: keyA },
    ]);

    // 2. A 通过 HTTP 看到 B 已开启并暴露项目 p1
    await until(
      async () => {
        const view = await clientA.dispatchDevices!();
        return view.devices.find((d) => d.id === "dev-b-2222")?.dispatch?.enabled === true;
      },
      "A sees B enabled",
    );

    // 3. A 通过 HTTP 派活到 B（请求 full-access，被 B 上限降级为 auto）
    const started = await clientA.dispatchStartThread!({
      to: "dev-b-2222",
      projectId: "p1",
      title: "跨设备联调",
      prompt: "跑完测试并汇报",
      mode: "full-access",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.mode).toBe("auto");
    expect(started.capped).toBe(true);
    expect(t3B.launches).toHaveLength(1);
    expect(bNotifications).toEqual([{ fromName: "Mac A", projectName: "you-brain", title: "跨设备联调" }]);

    // 4. B 会话状态变为 completed（超长摘要应截到 1500 字）-> A outbox 更新且推 Telegram
    await execB.tick(); // 建基线
    const row = t3B.threads.get(started.threadId)!;
    row.status = "completed";
    row.state = "ready";
    row.summary = "结".repeat(1_800);
    await execB.tick();

    await until(() => aTelegramPushes.length === 1, "A receives telegram dispatch push");
    expect(aTelegramPushes[0]).toMatchObject({
      deviceName: "Mac B",
      title: "跨设备联调",
      kind: "done",
      link: `https://t3.example/${started.threadId}`,
    });
    expect(aTelegramPushes[0]!.body).toBe(`${"结".repeat(1_500)}…`);

    const outboxAfter = await clientA.dispatchOutboxItem!(started.dispatchId);
    expect(outboxAfter.entry.status).toBe("done");
    expect(outboxAfter.entry.lastSummary).toBe("结".repeat(1_800));

    // 5. 同一状态重复 event 不重复推 Telegram
    hubA.onFrame({
      t: "event",
      from: "dev-b-2222",
      dispatchId: started.dispatchId,
      kind: "thread.status",
      data: {
        threadId: started.threadId,
        status: "completed",
        previous: "running",
        title: "跨设备联调",
        link: `https://t3.example/${started.threadId}`,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aTelegramPushes).toHaveLength(1);

    // 6. A 通过 HTTP followup -> B 收到后续指令 -> 再次完成会再次推送
    const followed = await clientA.dispatchFollowup!(started.dispatchId, { prompt: "再补一行说明" });
    expect(followed).toEqual({ ok: true, dispatchId: started.dispatchId, threadId: started.threadId });
    expect(t3B.followups).toHaveLength(1);

    await execB.tick(); // 看到 running
    row.status = "completed";
    row.state = "ready";
    row.summary = "第二轮完成";
    await execB.tick();
    await until(() => aTelegramPushes.length === 2, "second round push");
    expect(aTelegramPushes[1]!.body).toBe("第二轮完成");

    // 7. A 用 ?refresh=1 主动刷新摘要
    row.summary = "最新刷新摘要";
    const refreshed = await clientA.dispatchOutboxItem!(started.dispatchId, { refresh: true });
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.read?.summary).toBe("最新刷新摘要");
  });
});

describe("resolveDispatchDeviceId & keychain accounts", () => {
  it("follows priority: telegram.json relay.deviceId -> dispatch/device-id -> generate 0600", async () => {
    const dir1 = await makeTempDir();
    // 1) 空目录：生成并写入 0600
    const generated = await resolveDispatchDeviceId(dir1);
    expect(generated.length).toBeGreaterThanOrEqual(8);
    const idFile = join(dir1, "dispatch", "device-id");
    expect((await readFile(idFile, "utf8")).trim()).toBe(generated);
    expect((await stat(idFile)).mode & 0o777).toBe(0o600);
    // 再次读取返回同一个 ID
    expect(await resolveDispatchDeviceId(dir1)).toBe(generated);

    // 2) telegram.json 已有 relay.deviceId 时优先沿用
    const dir2 = await makeTempDir();
    await mkdir(join(dir2, "deck"), { recursive: true });
    await writeFile(
      join(dir2, "deck", "telegram.json"),
      JSON.stringify({ relay: { url: "https://relay.example.com", deviceId: "existing-relay-id", name: "Mac" } }),
      "utf8",
    );
    expect(await resolveDispatchDeviceId(dir2)).toBe("existing-relay-id");
    expect((await readFile(join(dir2, "dispatch", "device-id"), "utf8")).trim()).toBe("existing-relay-id");
  });

  it("telegramRelayTokenStore and dispatchIdentityStore use separate keychain accounts", async () => {
    const memory = new MemoryKeychain();
    const relayToken = telegramRelayTokenStore({ platform: "darwin", memory });
    const identity = dispatchIdentityStore({ platform: "darwin", memory });

    await relayToken.set("ubd_token_1");
    await identity.set("priv_key_1");
    expect(await relayToken.get()).toBe("ubd_token_1");
    expect(await identity.get()).toBe("priv_key_1");
  });

  it("createDispatchEventHandler pushes without body when read fails and dedupes by latestRun", async () => {
    const pushed: TelegramDispatchNotice[] = [];
    const handler = createDispatchEventHandler({
      read: async (dispatchId) => ({ ok: false, dispatchId, error: "离线" }),
      push: (notice) => pushed.push(notice),
    });
    const entry = {
      dispatchId: "d-x",
      to: "dev-b",
      deviceName: "Mac B",
      projectId: "p1",
      title: "任务",
      mode: "auto" as const,
      cmdId: "c-1",
      threadId: "t-1",
      threadUrl: "https://t3/t-1",
      status: "waiting" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    await handler.onEvent(entry, {
      kind: "thread.status",
      data: { threadId: "t-1", status: "waiting", previous: "running", title: "任务", link: null, latestRunId: "run-1" },
    });
    await handler.onEvent(entry, {
      kind: "thread.status",
      data: { threadId: "t-1", status: "waiting", previous: "running", title: "任务", link: null, latestRunId: "run-1" },
    });
    await handler.onEvent(entry, {
      kind: "thread.status",
      data: { threadId: "t-1", status: "waiting", previous: "running", title: "任务", link: null, latestRunId: "run-2" },
    });
    expect(pushed).toHaveLength(2);
    expect(pushed[0]).toEqual({ deviceName: "Mac B", title: "任务", kind: "waiting", link: "https://t3/t-1" });
  });
});
