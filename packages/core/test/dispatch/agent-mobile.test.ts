import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeyPair, newNonce, signCommand, type CommandSigningFields } from "@you-brain/protocol";

import { MemorySecretStore } from "../../src/auth/secret-store.js";
import {
  MASTER_AGENT_PREAMBLE_END,
  MASTER_AGENT_PREAMBLE_START,
  stripMasterAgentPreamble,
  type T3ThreadBrief,
  type T3ThreadConversation,
} from "../../src/deck/t3/automation.js";
import type { SessionNotice, SessionNoticeList } from "../../src/deck/session-notices.js";
import { TelegramBridge } from "../../src/deck/telegram/bridge.js";
import type { RelaySocketLike } from "../../src/deck/telegram/relay.js";
import type { Tty7SendInput, Tty7Session } from "../../src/deck/tty7.js";
import {
  DeviceIdentity,
  DispatchExecutor,
  type DispatchEmitEvent,
  type DispatchOutboxPort,
  type DispatchT3Port,
  type OutboxEntry,
} from "../../src/dispatch/index.js";
import { createDispatchHttpPort } from "../../src/http/handlers.js";
import { RelayCore, type RelayPorts, type RelaySocket } from "../../../../services/telegram-relay/src/core.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeSignedFrame(
  keys: { privateKey: string },
  from: string,
  to: string,
  kind: string,
  args: unknown,
  now: number,
) {
  const fields: CommandSigningFields = {
    cmdId: `cmd-${Math.random().toString(36).slice(2)}`,
    from,
    to,
    ts: now,
    nonce: newNonce(),
    cmd: { kind, args },
  };
  return { t: "cmd" as const, ...fields, sig: signCommand(keys.privateKey, fields) };
}

class MockAgentT3 implements DispatchT3Port {
  launches: Array<{
    projectId: string;
    title: string;
    prompt: string;
    requestId: string;
    runtimeMode: string;
    maxMode?: string;
    modelSelection?: { instanceId: string; model: string; options?: Array<{ id: string; value: unknown }> };
    fastOrchestrator?: boolean;
  }> = [];
  sent: Array<{ threadId: string; message: string; requestId: string }> = [];
  threadStatus = "running";
  messages: Array<{ position: number; role: "user" | "assistant"; text: string; runId: string | null }> = [];
  projectList = [{ id: "proj-1", name: "you-brain", cwd: "/repo" }];

  async projects() {
    return this.projectList;
  }

  async defaultDispatchProject() {
    return { id: "proj-1", name: "you-brain" };
  }

  async launchThread(input: {
    projectId: string;
    title: string;
    prompt: string;
    requestId: string;
    runtimeMode: "auto-accept-edits" | "auto" | "full-access";
    maxMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    modelSelection?: { instanceId: string; model: string; options?: Array<{ id: string; value: unknown }> };
    fastOrchestrator?: boolean;
  }) {
    this.launches.push(input);
    const threadId = `th-${this.launches.length}`;
    this.messages.push({
      position: 1,
      role: "user",
      text: stripMasterAgentPreamble(input.prompt),
      runId: "run-1",
    });
    this.messages.push({
      position: 2,
      role: "assistant",
      text: "收到，正在查在线设备并准备派活。",
      runId: "run-1",
    });
    return { threadId, threadUrl: `http://127.0.0.1:3773/env/${threadId}` };
  }

  async followup() {}

  async inspect() {
    return { state: "ready" as const, summary: "done" };
  }

  async threadStates(): Promise<T3ThreadBrief[]> {
    return this.launches.map((_, idx) => ({
      threadId: `th-${idx + 1}`,
      title: "主控会话",
      status: this.threadStatus,
      latestRunId: "run-1",
      snoozed: false,
      link: `http://127.0.0.1:3773/env/th-${idx + 1}`,
    }));
  }

  async latestAnswer() {
    return this.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
  }

  async sendMessage(threadId: string, message: string, requestId: string): Promise<string> {
    this.sent.push({ threadId, message, requestId });
    this.messages.push({
      position: this.messages.length + 1,
      role: "user",
      text: message,
      runId: "run-2",
    });
    return "queued";
  }

  async readMessages(threadId: string, options?: { afterPosition?: number; limit?: number }): Promise<T3ThreadConversation> {
    const after = options?.afterPosition ?? -1;
    const filtered = this.messages.filter((m) => m.position > after).slice(-(options?.limit ?? 80));
    return {
      threadId,
      state: this.threadStatus === "completed" ? "ready" : "running",
      rawStatus: this.threadStatus,
      threadUrl: `http://127.0.0.1:3773/env/${threadId}`,
      itemCount: this.messages.length,
      messages: filtered,
    };
  }
}

describe("移动端主控会话、派活看板、快捷回复与全量推送", () => {
  test("stripMasterAgentPreamble 只剥离引导前缀，保留用户原始输入", () => {
    const prompt = `${MASTER_AGENT_PREAMBLE_START}\n系统提示\n${MASTER_AGENT_PREAMBLE_END}\n\n帮我让 Mac 编译安卓`;
    expect(stripMasterAgentPreamble(prompt)).toBe("帮我让 Mac 编译安卓");
  });

  test("agent.session / agent.send / agent.read / dispatch.* / tick agent.status 全流程", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-agent-mobile-"));
    tempDirs.push(dir);
    const phoneKeys = generateKeyPair();
    const now = 1_760_000_000_000;
    const t3 = new MockAgentT3();
    const events: Array<{ to: string; frame: DispatchEmitEvent }> = [];
    const outboxList: OutboxEntry[] = [
      {
        dispatchId: "d-1",
        to: "device-mac",
        deviceName: "Mac Pro",
        projectId: "p1",
        title: "修测试",
        mode: "auto",
        cmdId: "c-1",
        threadId: "th-mac-1",
        status: "running",
        createdAt: now - 1000,
        updatedAt: now,
      },
    ];
    const outboxPort: DispatchOutboxPort = {
      list: async () => outboxList,
      followup: async (dispatchId, prompt) => ({ ok: true, dispatchId, threadId: `th-${prompt.length}` }),
      refresh: async (dispatchId) => ({
        ok: true,
        dispatchId,
        state: "ready",
        summary: "已修好",
        link: null,
        entry: { ...outboxList[0]!, status: "done", lastSummary: "已修好" },
      }),
    };

    const executor = new DispatchExecutor({
      dataDir: dir,
      deviceId: "device-vps",
      now: () => now,
      t3,
      role: "server",
      outboxPort,
      devicesPort: async () => [
        {
          id: "device-mac",
          name: "Mac Pro",
          online: true,
          self: false,
          acceptsDispatch: true,
          maxMode: "full-access",
          projects: [{ id: "p1", name: "you-brain" }],
        },
      ],
      emitEvent: (to, frame) => events.push({ to, frame }),
    });
    await executor.updatePolicy({
      enabled: true,
      allProjects: true,
      maxMode: "full-access",
      allowedSenders: [{ deviceId: "device-phone", name: "Android", publicKey: phoneKeys.publicKey }],
    });

    const hello = await executor.hello();
    expect(hello.role).toBe("server");

    // 1. agent.session 建立、登记订阅者并随包返回当前会话快照（1 RTT）
    const sessRes = await executor.handle(makeSignedFrame(phoneKeys, "device-phone", "device-vps", "agent.session", {}, now));
    expect(sessRes.ok).toBe(true);
    const { activeSessionId, defaultProject, conversation } = (
      sessRes as {
        ok: true;
        result: {
          activeSessionId: string;
          defaultProject: { id: string };
          conversation?: { sessionId: string | null; state: string; outbox: OutboxEntry[] };
        };
      }
    ).result;
    expect(activeSessionId).toStartWith("ag-");
    expect(defaultProject.id).toBe("proj-1");
    expect(conversation?.sessionId).toBe(activeSessionId);
    expect(conversation?.state).toBe("idle");
    expect(conversation?.outbox).toHaveLength(1);
    expect(await executor.agentSubscribers()).toEqual(["device-phone"]);

    // 2. 首次 agent.send 创建主控 T3 会话、注入实时设备快照，并启用低延迟 fastOrchestrator
    const firstSend = await executor.handle(
      makeSignedFrame(phoneKeys, "device-phone", "device-vps", "agent.send", {
        sessionId: activeSessionId,
        text: "帮我查看哪些设备在线",
        requestId: "req-1",
      }, now),
    );
    expect(firstSend.ok).toBe(true);
    expect(t3.launches).toHaveLength(1);
    expect(t3.launches[0]!.fastOrchestrator).toBe(true);
    expect(t3.launches[0]!.prompt).toContain(MASTER_AGENT_PREAMBLE_START);
    expect(t3.launches[0]!.prompt).toContain("Mac Pro");
    expect(t3.launches[0]!.prompt).toContain("帮我查看哪些设备在线");

    // 3. 再次 agent.send 同一 sessionId 走 sendMessage 排队续聊
    const secondSend = await executor.handle(
      makeSignedFrame(phoneKeys, "device-phone", "device-vps", "agent.send", {
        sessionId: activeSessionId,
        text: "给 Mac Pro 派个任务",
        requestId: "req-2",
      }, now),
    );
    expect(secondSend.ok).toBe(true);
    expect((secondSend as { ok: true; result: { delivery: string } }).result.delivery).toBe("queued");
    expect(t3.sent).toHaveLength(1);

    // 4. agent.read 读取完整清洗后对话与 outbox 看板
    const readRes = await executor.handle(
      makeSignedFrame(phoneKeys, "device-phone", "device-vps", "agent.read", { sessionId: activeSessionId }, now),
    );
    expect(readRes.ok).toBe(true);
    const readBody = (readRes as { ok: true; result: { messages: Array<{ role: string; text: string }>; outbox: OutboxEntry[] } }).result;
    expect(readBody.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "帮我查看哪些设备在线"],
      ["assistant", "收到，正在查在线设备并准备派活。"],
      ["user", "给 Mac Pro 派个任务"],
    ]);
    expect(readBody.outbox).toHaveLength(1);

    // 5. dispatch.list / followup / refresh
    const listRes = await executor.handle(makeSignedFrame(phoneKeys, "device-phone", "device-vps", "dispatch.list", {}, now));
    expect(listRes.ok).toBe(true);
    const followRes = await executor.handle(
      makeSignedFrame(phoneKeys, "device-phone", "device-vps", "dispatch.followup", { dispatchId: "d-1", prompt: "顺便跑下 lint" }, now),
    );
    expect(followRes.ok).toBe(true);
    const refRes = await executor.handle(
      makeSignedFrame(phoneKeys, "device-phone", "device-vps", "dispatch.refresh", { dispatchId: "d-1" }, now),
    );
    expect(refRes.ok).toBe(true);

    // 6. tick 检测状态变化后向订阅手机推 agent.status
    await executor.tick();
    t3.threadStatus = "completed";
    await executor.tick();
    expect(events.some((e) => e.to === "device-phone" && e.frame.kind === "agent.status")).toBe(true);
  });

  test("notice.reply 在 policy.enabled=false 时仍允许已信任设备快捷回复，但拒绝未信任设备", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-notice-reply-"));
    tempDirs.push(dir);
    const phoneKeys = generateKeyPair();
    const strangerKeys = generateKeyPair();
    const now = 1_760_000_000_000;
    const delivered: Array<{ token: string; text: string }> = [];

    const executor = new DispatchExecutor({
      dataDir: dir,
      deviceId: "device-mac",
      now: () => now,
      t3: new MockAgentT3(),
      replyPort: async (replyToken, text) => {
        delivered.push({ token: replyToken, text });
        return { ok: true, targetName: "终端 1" };
      },
      emitEvent: () => undefined,
    });
    await executor.updatePolicy({
      enabled: false,
      allowedSenders: [{ deviceId: "device-phone", name: "Android", publicKey: phoneKeys.publicKey }],
    });

    const okReply = await executor.handle(
      makeSignedFrame(phoneKeys, "device-phone", "device-mac", "notice.reply", { replyToken: "tok-1", text: "yes" }, now),
    );
    expect(okReply.ok).toBe(true);
    expect(delivered).toEqual([{ token: "tok-1", text: "yes" }]);

    const badReply = await executor.handle(
      makeSignedFrame(strangerKeys, "device-stranger", "device-mac", "notice.reply", { replyToken: "tok-1", text: "yes" }, now),
    );
    expect(badReply.ok).toBe(false);
  });

  test("未绑定 Telegram 时已入网的 TelegramBridge 也能向手机推送全量消息（tty7 / t3 / dispatch / reminder）并接受快捷回复", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-mobile-push-"));
    tempDirs.push(dir);

    const store = new Map<string, unknown>();
    const sockets: Array<RelaySocket & { fake: FakeWs }> = [];
    const ports: RelayPorts = {
      storage: {
        get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
        put: async (k, v) => void store.set(k, structuredClone(v)),
        delete: async (k) => store.delete(k),
      },
      sockets: () => sockets.filter((s) => s.fake.readyState === 1),
      telegram: async <T>() => ({}) as T,
      now: () => 1_000_000,
      randomInt: () => 0,
    };
    const core = new RelayCore(ports);
    class FakeWs implements RelaySocketLike {
      readyState = 0;
      listeners = new Map<string, Array<(e: { data?: unknown; code?: number }) => void>>();
      send(data: string) {
        if (data === "ping") return this.emit("message", { data: "pong" });
        void core.frame(sockets.find((s) => s.fake === this)!, data);
      }
      close(code?: number) {
        this.readyState = 3;
        this.emit("close", { code: code ?? 1000 });
      }
      addEventListener(type: string, fn: (e: { data?: unknown; code?: number }) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }
      emit(type: string, e: { data?: unknown; code?: number }) {
        for (const fn of this.listeners.get(type) ?? []) fn(e);
      }
    }

    const phoneFrames: Array<Record<string, unknown>> = [];
    const phoneFake = new FakeWs();
    const phoneSock: RelaySocket & { fake: FakeWs } = {
      deviceId: "device-phone",
      name: "Android",
      auth: "enrolled",
      fake: phoneFake,
      send: (f) => phoneFrames.push(JSON.parse(f)),
    };
    phoneFake.readyState = 1;
    sockets.push(phoneSock);
    await core.connected("device-phone", "Android");

    const list: SessionNoticeList = { epoch: "e1", latest: 0, notices: [] };
    const sends: Tty7SendInput[] = [];
    const t3Sends: Array<{ threadId: string; text: string }> = [];
    const relayToken = new MemorySecretStore("ubd_test_token_123456");

    const bridge = new TelegramBridge({
      configPath: join(dir, "telegram.json"),
      token: new MemorySecretStore(null),
      relayToken,
      dispatchIdentity: new DeviceIdentity({ store: new MemorySecretStore(null) }),
      notices: () => list,
      sessions: async () => ({
        available: true,
        detail: "",
        workspaces: [],
        sessions: [
          {
            pane: 1,
            workspaceId: "ws",
            workspaceName: "ws",
            tabId: "t1",
            tabLabel: null,
            agent: "Claude",
            cwd: "/repo",
            hibernated: false,
            status: "idle",
            statusMessage: null,
            model: null,
          } satisfies Tty7Session,
        ],
        harnesses: [],
        appearance: null,
      }),
      send: async (input) => void sends.push(input),
      dismiss: () => undefined,
      relayFetch: async (url) => {
        if (url.endsWith("/enroll")) return Response.json({ token: "ubd_test_token_123456" });
        return Response.json({ ok: true, botConfigured: false });
      },
      relaySocket: (url) => {
        const parsed = new URL(url);
        const fake = new FakeWs();
        const entry = {
          deviceId: parsed.searchParams.get("device")!,
          name: parsed.searchParams.get("name")!,
          auth: "enrolled" as const,
          fake,
          send: (frame: string) => fake.emit("message", { data: frame }),
        };
        queueMicrotask(() => {
          sockets.push(entry);
          fake.readyState = 1;
          fake.emit("open", {});
          void core.connected(entry.deviceId, entry.name);
        });
        return fake;
      },
      retryMs: [10],
    });
    // 预写入 relay 配置（未绑定 Telegram Bot）
    await bridge.action({ action: "enroll-relay", url: "https://relay.example.com", code: "ABCD1234", name: "MacBook" });
    await bridge.start();
    bridge.attachT3({
      send: async (threadId, text) => {
        t3Sends.push({ threadId, text });
        return "started";
      },
      status: () => "completed",
      answer: async () => "T3 已改完",
    });

    for (let i = 0; i < 100 && !bridge.mobileConnected(); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bridge.mobileConnected()).toBe(true);
    expect(bridge.bound()).toBe(false);

    // 1. tty7 提醒
    const n1: SessionNotice = {
      seq: 1,
      pane: 1,
      kind: "waiting",
      status: "open",
      sessionName: "repo",
      agent: "Claude",
      cwd: "/repo",
      title: "终端等你输入",
      body: "Confirm deploy?",
      at: "2026-11-23T00:00:00.000Z",
    };
    list.notices.push(n1);
    list.latest = 1;
    bridge.noticesChanged();
    // 2. T3 提醒
    bridge.pushT3({ threadId: "th-1", title: "修复编译", kind: "done", link: "http://127.0.0.1:3773/env/th-1" });
    // 3. 派活提醒
    bridge.pushDispatch({ dispatchId: "d-1", deviceName: "Mac", title: "跑单测", kind: "done", body: "全部通过" });
    // 4. U-Brain 记忆/早报提醒
    bridge.pushReminder({ reminderId: "rem-1", kind: "morning", text: "今天 2 条待办" });

    await bridge.flush();
    for (let i = 0; i < 100 && phoneFrames.filter((f) => f.t === "push").length < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const pushes = phoneFrames.filter((f) => f.t === "push").map((f) => f.item as { kind: string; replyToken?: string; body: string });
    expect(pushes.map((p) => p.kind)).toEqual(["tty7", "t3", "dispatch", "reminder"]);

    // 快捷回复 tty7 与 T3
    const r1 = await bridge.deliverMobileReply(pushes[0]!.replyToken!, "yes");
    expect(r1.ok).toBe(true);
    expect(sends).toEqual([{ pane: 1, text: "yes", enter: true }]);

    const r2 = await bridge.deliverMobileReply(pushes[1]!.replyToken!, "继续优化");
    expect(r2.ok).toBe(true);
    expect(t3Sends).toEqual([{ threadId: "th-1", text: "继续优化" }]);

    bridge.stop();
  });

  test("createDispatchHttpPort 支持 trustDevice 与 trustedIds", async () => {
    const trusted: string[] = [];
    const port = createDispatchHttpPort({
      hub: {
        devices: () => [
          { id: "device-phone", name: "Pixel", online: true, self: false, enrolled: true, publicKey: "pk-1" },
        ],
        startThread: async () => { throw new Error("unused"); },
        followup: async () => { throw new Error("unused"); },
        outbox: async () => [],
        getOutbox: async () => null,
        read: async () => { throw new Error("unused"); },
        dispatch: async () => { throw new Error("unused"); },
        refreshHello: async () => undefined,
      },
      executor: null,
      deviceId: "device-mac",
      selfName: () => "Mac",
      isConnected: () => true,
      isEnrolled: () => true,
      projects: async () => [],
      trustedIds: async () => [...trusted],
      trustDevice: async (id) => {
        trusted.push(id);
      },
    });
    const before = await port.policy();
    expect(before.trustedDeviceIds).toEqual([]);
    const after = await port.trustDevice!({ deviceId: "device-phone" });
    expect(after.trustedDeviceIds).toEqual(["device-phone"]);
  });

  test("masterProjectId 与 masterModelSelection 优先锁定主控项目与模型，且不被无关策略更新抹掉", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-agent-master-pin-"));
    tempDirs.push(dir);
    const phoneKeys = generateKeyPair();
    const now = 1_760_000_000_000;
    const t3 = new MockAgentT3();
    t3.projectList = [
      { id: "proj-1", name: "project", cwd: "/project" },
      { id: "proj-home", name: "home-repo", cwd: "/project/home-repo" },
    ];
    const executor = new DispatchExecutor({
      dataDir: dir,
      deviceId: "device-vps",
      now: () => now,
      t3,
      role: "server",
      emitEvent: () => undefined,
    });
    await executor.updatePolicy({
      enabled: true,
      allProjects: true,
      maxMode: "full-access",
      allowedSenders: [{ deviceId: "device-phone", name: "Android", publicKey: phoneKeys.publicKey }],
      masterProjectId: "proj-home",
      masterModelSelection: {
        instanceId: "antigravity",
        model: "gemini-4-neon",
        options: [{ id: "thought_level", value: "medium" }],
      },
    });
    // 更新无关字段不应清空 masterProjectId / masterModelSelection
    const kept = await executor.updatePolicy({ notify: false });
    expect(kept.masterProjectId).toBe("proj-home");
    expect(kept.masterModelSelection).toEqual({
      instanceId: "antigravity",
      model: "gemini-4-neon",
      options: [{ id: "thought_level", value: "medium" }],
    });

    const sessRes = await executor.handle(makeSignedFrame(phoneKeys, "device-phone", "device-vps", "agent.session", {}, now));
    expect(sessRes.ok).toBe(true);
    const { activeSessionId, defaultProject } = (
      sessRes as { ok: true; result: { activeSessionId: string; defaultProject: { id: string; name: string } } }
    ).result;
    expect(defaultProject).toEqual({ id: "proj-home", name: "home-repo" });

    const sendRes = await executor.handle(
      makeSignedFrame(phoneKeys, "device-phone", "device-vps", "agent.send", {
        sessionId: activeSessionId,
        text: "帮我查仓库状态",
        requestId: "req-master-1",
      }, now),
    );
    expect(sendRes.ok).toBe(true);
    expect(t3.launches).toHaveLength(1);
    expect(t3.launches[0]).toMatchObject({
      projectId: "proj-home",
      runtimeMode: "auto",
      maxMode: "full-access",
      fastOrchestrator: false,
      modelSelection: {
        instanceId: "antigravity",
        model: "gemini-4-neon",
        options: [{ id: "thought_level", value: "medium" }],
      },
    });
  });
});
