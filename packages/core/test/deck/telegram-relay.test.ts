import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { MemorySecretStore } from "../../src/auth/secret-store.js";
import type { SessionNotice, SessionNoticeList } from "../../src/deck/session-notices.js";
import { TelegramBridge } from "../../src/deck/telegram/bridge.js";
import { normalizeRelayUrl, type RelaySocketLike } from "../../src/deck/telegram/relay.js";
import { decodeRelayInvite, encodeRelayInvite } from "../../src/deck/telegram/invite.js";
import type { Tty7Session, Tty7SendInput } from "../../src/deck/tty7.js";
import { RelayCore, type RelaySocket, type TgMessage } from "../../../../services/telegram-relay/src/core.js";

const KEY = "relay-key-0123456789abcdef";
const URL_ = "https://relay.example.workers.dev";
const OWNER = 1001;

/** 内存里的中转：真的 RelayCore，假的 Telegram 和 WebSocket。 */
class FakeRelay {
  store = new Map<string, unknown>();
  sockets: Array<RelaySocket & { fake: FakeSocket }> = [];
  sent: Array<{ text: string; reply_parameters?: { message_id: number } }> = [];
  nextId = 700;
  nextIncoming = 1;
  rejectKey = false;
  core = new RelayCore({
    storage: {
      get: async <T>(key: string) => structuredClone(this.store.get(key)) as T | undefined,
      put: async (key, value) => void this.store.set(key, structuredClone(value)),
      delete: async (key) => this.store.delete(key),
    },
    sockets: () => this.sockets.filter((socket) => socket.fake.readyState === 1),
    telegram: async <T>(method: string, params: Record<string, unknown>) => {
      if (method === "getMe") return { id: 77, username: "ub_bot", first_name: "UB" } as T;
      if (method === "sendMessage") {
        this.sent.push(params as never);
        return { message_id: this.nextId++ } as T;
      }
      return true as T;
    },
    now: () => Date.now(),
    randomInt: () => 1,
  });

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    expect(url).toBe(`${URL_}/check`);
    const auth = new Headers(init.headers).get("Authorization");
    if (this.rejectKey || auth !== `Bearer ${KEY}`) return Response.json({ ok: false }, { status: 401 });
    return Response.json({ ok: true, botConfigured: true });
  };

  socket = (url: string, headers: Record<string, string>): RelaySocketLike => {
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("wss:");
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    const fake = new FakeSocket();
    const entry = {
      deviceId: parsed.searchParams.get("device")!,
      name: parsed.searchParams.get("name")!,
      fake,
      send: (frame: string) => fake.emit("message", { data: frame }),
    };
    fake.onSend = (data) => {
      if (data === "ping") return fake.emit("message", { data: "pong" });
      void this.core.frame(entry, data);
    };
    queueMicrotask(() => {
      this.sockets.push(entry);
      fake.readyState = 1;
      fake.emit("open", {});
      void this.core.connected(entry.deviceId, entry.name);
    });
    return fake;
  };

  async say(text: string, replyTo?: number): Promise<void> {
    const message: TgMessage = {
      message_id: this.nextIncoming++,
      chat: { id: OWNER, type: "private" },
      from: { id: OWNER, username: "owner" },
      text,
      ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }),
    };
    await this.core.update({ update_id: message.message_id, message });
  }
}

class FakeSocket implements RelaySocketLike {
  readyState = 0;
  onSend: (data: string) => void = () => undefined;
  readonly #listeners = new Map<string, Array<(event: { data?: unknown; code?: number }) => void>>();
  send(data: string): void {
    this.onSend(data);
  }
  close(code?: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code: code ?? 1000 });
  }
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: { data?: unknown; code?: number }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out: ${label}`);
}

function session(pane: number): Tty7Session {
  return {
    pane,
    workspaceId: "ws",
    workspaceName: "ws",
    tabId: `t${pane}`,
    tabLabel: null,
    agent: "Claude",
    cwd: `/w/${pane}`,
    hibernated: false,
    status: "idle",
    statusMessage: null,
    model: null,
  };
}

function notice(seq: number, pane: number, title: string): SessionNotice {
  return {
    seq,
    pane,
    kind: "waiting",
    status: "open",
    sessionName: `dir${pane}`,
    agent: "Claude",
    cwd: `/w/${pane}`,
    title,
    body: "要不要继续？",
    at: "2026-11-19T00:00:00.000Z",
  };
}

async function device(relay: FakeRelay, name: string, token: string | null = null) {
  const dir = await mkdtemp(join(tmpdir(), "ub-telegram-relay-"));
  const list: SessionNoticeList = { epoch: "e1", latest: 0, notices: [] };
  const sends: Tty7SendInput[] = [];
  const relayKey = new MemorySecretStore(null);
  const bridge = new TelegramBridge({
    configPath: join(dir, "deck", "telegram.json"),
    token: new MemorySecretStore(token),
    relayKey,
    notices: () => list,
    sessions: async () => ({ available: true, detail: "", workspaces: [], sessions: [session(1)], harnesses: [], appearance: null }),
    send: async (input) => void sends.push(input),
    dismiss: () => undefined,
    relayFetch: relay.fetch,
    relaySocket: relay.socket,
    retryMs: [5],
  });
  await bridge.start();
  const push = (item: SessionNotice) => {
    list.notices.push(item);
    list.latest = item.seq;
    bridge.noticesChanged();
  };
  return { bridge, sends, push, relayKey, dir };
}

describe("TelegramBridge 中转模式", () => {
  it("两台设备共用一个 Bot：推送标出设备，回复回到推送它的那台", async () => {
    const relay = new FakeRelay();
    const mac = await device(relay, "MacBook");
    const mini = await device(relay, "Mac mini");

    await expect(mac.bridge.action({ action: "set-relay", url: URL_, key: "short" })).rejects.toThrow("至少 16 位");
    relay.rejectKey = true;
    await expect(mac.bridge.action({ action: "set-relay", url: URL_, key: KEY })).rejects.toThrow("不认这个密钥");
    relay.rejectKey = false;

    await mac.bridge.action({ action: "set-relay", url: `${URL_}/`, key: KEY, name: "MacBook" });
    expect(await mac.relayKey.get()).toBe(KEY);
    await mini.bridge.action({ action: "set-relay", url: URL_, key: KEY, name: "Mac mini" });
    await until(() => mac.bridge.status().connection === "ok" && mini.bridge.status().connection === "ok", "connected");

    const pairing = (await mac.bridge.action({ action: "pair" })).pairing!;
    expect(pairing.link).toBe(`https://t.me/ub_bot?start=${pairing.code}`);
    await relay.say(`/start ${pairing.code}`);
    await until(() => mini.bridge.status().bound !== null && mac.bridge.bound(), "bound on both");
    expect(mac.bridge.status().relay?.devices.map((item) => [item.name, item.online, item.self])).toEqual(
      expect.arrayContaining([
        ["MacBook", true, true],
        ["Mac mini", true, false],
      ]),
    );

    await mac.bridge.action({ action: "set-notifications", enabled: true });
    const before = relay.sent.length;
    mini.push(notice(1, 1, "mini 未开启通知"));
    await mini.bridge.flush();
    expect(relay.sent).toHaveLength(before);
    mac.push(notice(1, 1, "mac 在等你"));
    await until(() => relay.sent.some((item) => item.text.startsWith("💻 MacBook\n⏳ mac 在等你")), "mac push");
    const macPush = relay.nextId - 1;
    await mini.bridge.action({ action: "set-notifications", enabled: true });
    mini.push(notice(2, 1, "mini 在等你"));
    await until(() => relay.sent.some((item) => item.text.startsWith("💻 Mac mini\n⏳ mini 在等你")), "mini push");

    // 回复 mac 的提醒：只打进 mac 的终端。
    await relay.say("继续", macPush);
    await until(() => mac.sends.length === 1, "mac delivered");
    expect(mac.sends[0]).toEqual({ pane: 1, text: "继续", enter: true });
    await until(() => relay.sent.some((item) => item.text === "✓ 已发送到「mac 在等你」" || item.text.startsWith("✓ 已发送到")), "ack");
    expect(mini.sends).toHaveLength(0);

    // 直接发的消息跟着最近回复过的设备走。
    await relay.say("再来");
    await until(() => mac.sends.length === 2, "plain to mac");
    expect(mini.sends).toHaveLength(0);

    mac.bridge.stop();
    mini.bridge.stop();
  });

  it("连接信息：已连中转的电脑导出地址和密钥，新电脑粘贴即可连上", async () => {
    expect(decodeRelayInvite("随便")).toBeNull();
    expect(decodeRelayInvite("u-brain-relay:!!!")).toBeNull();
    expect(decodeRelayInvite(` ${encodeRelayInvite(URL_, KEY)}\n`)).toEqual({ url: URL_, key: KEY });

    const relay = new FakeRelay();
    const mac = await device(relay, "MacBook");
    await expect(mac.bridge.relayInvite()).rejects.toThrow("还没有连接中转");
    await mac.bridge.action({ action: "set-relay", url: URL_, key: KEY });
    const invite = await mac.bridge.relayInvite();
    expect(invite.startsWith("u-brain-relay:")).toBe(true);
    expect(invite).not.toContain(KEY);

    const mini = await device(relay, "Mac mini");
    const decoded = decodeRelayInvite(invite)!;
    await mini.bridge.action({ action: "set-relay", url: decoded.url, key: decoded.key, name: "Mac mini" });
    await until(() => mini.bridge.status().connection === "ok", "mini connected");
    mac.bridge.stop();
    mini.bridge.stop();
  });

  it("清除中转后回到直连；地址校验", async () => {
    expect(normalizeRelayUrl(" https://a.workers.dev// ")).toBe("https://a.workers.dev");
    expect(() => normalizeRelayUrl("http://a.workers.dev")).toThrow("https");
    const relay = new FakeRelay();
    const mac = await device(relay, "MacBook");
    await mac.bridge.action({ action: "set-relay", url: URL_, key: KEY });
    await until(() => mac.bridge.status().connection === "ok", "connected");
    await expect(mac.bridge.action({ action: "set-token", token: "123456789:AAbbccddeeffgghhiijjkkllmmnnooppqq" })).rejects.toThrow("中转");
    const status = await mac.bridge.action({ action: "clear-relay" });
    expect(status.relay).toBeNull();
    expect(status.connection).toBe("off");
    expect(await mac.relayKey.get()).toBeNull();
    mac.bridge.stop();
  });
});

import {
  TelegramRelayClient,
  enrollRelay,
  type DispatchRelayFrame,
  type TelegramRelayState,
} from "../../src/deck/telegram/relay.js";
import { DeviceIdentity } from "../../src/dispatch/identity.js";

describe("TelegramRelayClient 扩展与入网", () => {
  it("token 优先于 key 作为 Bearer，支持 4001 不重连、state 扩展字段、onDispatchFrame 及异常吞掉", async () => {
    const authHeaders: string[] = [];
    const sockets: FakeSocket[] = [];
    const states: TelegramRelayState[] = [];
    const connections: Array<{ status: string; error: string | null }> = [];
    const frames: DispatchRelayFrame[] = [];
    let throwOnFrame = true;

    const client = new TelegramRelayClient({
      url: URL_,
      key: KEY,
      token: "ubd_device_token_123456",
      deviceId: "device-001",
      name: "MacBook",
      retryMs: [5],
      onState: (s) => states.push(s),
      onMessage: () => undefined,
      onConnection: (status, error) => connections.push({ status, error }),
      onDispatchFrame: (frame) => {
        frames.push(frame);
        if (throwOnFrame) throw new Error("boom");
      },
      socket: (_url, headers) => {
        authHeaders.push(headers.Authorization ?? "");
        const s = new FakeSocket();
        sockets.push(s);
        queueMicrotask(() => {
          s.readyState = 1;
          s.emit("open", {});
        });
        return s;
      },
    });

    client.start();
    await until(() => connections.some((c) => c.status === "ok"), "connected with token");
    expect(authHeaders).toEqual(["Bearer ubd_device_token_123456"]);

    // state 带新字段与旧格式均不报错
    const s1 = sockets[0]!;
    s1.emit("message", {
      data: JSON.stringify({
        t: "state",
        bot: { username: "ub_bot", name: "UB" },
        bound: null,
        devices: [
          {
            id: "device-001",
            name: "MacBook",
            online: true,
            enrolled: true,
            publicKey: "pk-1",
            dispatch: { enabled: true, t3: { ready: true }, projects: [], maxMode: "auto" },
          },
          { id: "legacy-dev", name: "Old", online: false },
        ],
      }),
    });
    expect(states).toHaveLength(1);
    expect(states[0]!.devices[0]).toEqual({
      id: "device-001",
      name: "MacBook",
      online: true,
      enrolled: true,
      publicKey: "pk-1",
      dispatch: { enabled: true, t3: { ready: true }, projects: [], maxMode: "auto" },
    });
    expect(states[0]!.devices[1]).toEqual({ id: "legacy-dev", name: "Old", online: false });

    // cmd / cmdres / event 触发 onDispatchFrame，回调抛错不影响连接
    s1.emit("message", { data: JSON.stringify({ t: "cmd", cmdId: "c-1" }) });
    throwOnFrame = false;
    s1.emit("message", { data: JSON.stringify({ t: "cmdres", cmdId: "c-1", ok: true }) });
    s1.emit("message", { data: JSON.stringify({ t: "event", dispatchId: "d-1", kind: "thread.status" }) });
    expect(frames.map((f) => f.t)).toEqual(["cmd", "cmdres", "event"]);
    expect(s1.readyState).toBe(1);

    // 关闭码 4001：报告吊销错误且不再自动重连
    s1.close(4001);
    expect(connections.at(-1)).toEqual({
      status: "error",
      error: "这台设备已被中转吊销，请重新入网",
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(sockets).toHaveLength(1);

    // 外部再次 start() 可以重新连接
    client.start();
    await until(() => sockets.length === 2, "restarted after revoke");
    client.stop();
  });

  it("enrollRelay 成功与各类错误文案，且错误信息不含邀请码与令牌", async () => {
    const code = "ABCD2345";
    const okFetch = async (url: string, init: RequestInit): Promise<Response> => {
      expect(url).toBe(`${URL_}/enroll`);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(JSON.parse(String(init.body))).toEqual({
        code,
        deviceId: "dev-12345678",
        name: "Mac A",
        publicKey: "pk-abc",
      });
      return Response.json({ token: "ubd_new_token_xyz" });
    };
    const res = await enrollRelay(URL_, { code, deviceId: "dev-12345678", name: "Mac A", publicKey: "pk-abc" }, okFetch);
    expect(res).toEqual({ token: "ubd_new_token_xyz" });

    const errorCases: Array<{ status: number; body: Record<string, unknown>; expected: string }> = [
      { status: 400, body: { error: `bad publicKey for ${code}` }, expected: "公钥" },
      { status: 401, body: { error: `invalid code ${code}` }, expected: "邀请码" },
      { status: 403, body: { error: `forbidden ${code}` }, expected: "邀请码" },
      { status: 409, body: { error: "already enrolled" }, expected: "已入网" },
      { status: 429, body: { error: "too many attempts" }, expected: "次数过多" },
    ];
    for (const item of errorCases) {
      let caught: Error | null = null;
      try {
        await enrollRelay(
          URL_,
          { code, deviceId: "dev-12345678", name: "Mac A", publicKey: "pk-abc" },
          async () => Response.json(item.body, { status: item.status }),
        );
      } catch (error) {
        caught = error instanceof Error ? error : new Error(String(error));
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toContain(item.expected);
      expect(caught!.message).not.toContain(code);
      expect(caught!.message).not.toContain("ubd_");
    }
  });

  it("TelegramBridge enroll-relay：入网保存令牌、删旧 relayKey、用令牌连接并接通 dispatch 钩子", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-telegram-enroll-"));
    const list: SessionNoticeList = { epoch: "e1", latest: 0, notices: [] };
    const relayKey = new MemorySecretStore(KEY);
    const relayToken = new MemorySecretStore(null);
    const identityStore = new MemorySecretStore(null);
    const identity = new DeviceIdentity({ store: identityStore });

    const attached: Array<unknown> = [];
    const seenStates: TelegramRelayState[] = [];
    const seenFrames: DispatchRelayFrame[] = [];
    const authHeaders: string[] = [];
    const enrolledPayloads: Array<Record<string, unknown>> = [];
    const sockets: FakeSocket[] = [];

    const bridgeWithoutEnroll = new TelegramBridge({
      configPath: join(dir, "deck", "telegram-no-enroll.json"),
      token: new MemorySecretStore(null),
      notices: () => list,
      sessions: async () => ({ available: true, detail: "", workspaces: [], sessions: [], harnesses: [], appearance: null }),
      send: async () => undefined,
      dismiss: () => undefined,
    });
    await expect(
      bridgeWithoutEnroll.action({ action: "enroll-relay", url: URL_, code: "ABCD2345" }),
    ).rejects.toThrow("不支持入网");

    const bridge = new TelegramBridge({
      configPath: join(dir, "deck", "telegram.json"),
      token: new MemorySecretStore(null),
      relayKey,
      relayToken,
      dispatchIdentity: identity,
      dispatch: {
        attach: (link) => attached.push(link),
        onFrame: (frame) => seenFrames.push(frame),
        setState: (state) => seenStates.push(state),
      },
      notices: () => list,
      sessions: async () => ({ available: true, detail: "", workspaces: [], sessions: [], harnesses: [], appearance: null }),
      send: async () => undefined,
      dismiss: () => undefined,
      relayFetch: async (url, init) => {
        expect(url).toBe(`${URL_}/enroll`);
        enrolledPayloads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ token: "ubd_enrolled_token_999" });
      },
      relaySocket: (_url, headers) => {
        authHeaders.push(headers.Authorization ?? "");
        const s = new FakeSocket();
        sockets.push(s);
        queueMicrotask(() => {
          s.readyState = 1;
          s.emit("open", {});
          s.emit("message", {
            data: JSON.stringify({
              t: "state",
              bot: { username: "ub_bot", name: "UB" },
              bound: null,
              devices: [{ id: String(enrolledPayloads[0]?.deviceId), name: "MacBook", online: true, enrolled: true }],
            }),
          });
        });
        return s;
      },
      retryMs: [5],
    });

    await bridge.start();
    await bridge.action({ action: "enroll-relay", url: `${URL_}/`, code: "WXYZ6789", name: "MacBook" });
    await until(() => bridge.status().connection === "ok", "enrolled connected");

    expect(await relayToken.get()).toBe("ubd_enrolled_token_999");
    expect(await relayKey.get()).toBeNull();
    expect(authHeaders).toEqual(["Bearer ubd_enrolled_token_999"]);
    expect(enrolledPayloads[0]?.publicKey).toBe(await identity.publicKey());
    expect(String(enrolledPayloads[0]?.deviceId)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(attached.at(-1)).not.toBeNull();
    expect(seenStates).toHaveLength(1);

    sockets[0]!.emit("message", { data: JSON.stringify({ t: "event", dispatchId: "d-1", kind: "thread.status" }) });
    expect(seenFrames).toHaveLength(1);

    // clear-relay 同时删除 relayToken 并 attach(null)
    await bridge.action({ action: "clear-relay" });
    expect(await relayToken.get()).toBeNull();
    expect(attached.at(-1)).toBeNull();
    bridge.stop();
  });
});
