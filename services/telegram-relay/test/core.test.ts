import { describe, expect, it } from "bun:test";

import { CANDIDATE_TTL_MS, RECENT_DEVICE_TTL_MS, RelayCore, type RelayPorts, type RelaySocket, type TgMessage } from "../src/core.js";

const OWNER = 1001;
const STRANGER = 2002;

class World {
  store = new Map<string, unknown>();
  sockets: Array<RelaySocket & { frames: Array<Record<string, unknown>> }> = [];
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  clock = 1_000_000;
  nextId = 900;
  nextIncoming = 1;
  ports: RelayPorts = {
    storage: {
      get: async <T>(key: string) => structuredClone(this.store.get(key)) as T | undefined,
      put: async (key, value) => void this.store.set(key, structuredClone(value)),
      delete: async (key) => this.store.delete(key),
    },
    sockets: () => this.sockets,
    telegram: async <T>(method: string, params: Record<string, unknown>) => {
      this.calls.push({ method, params });
      if (method === "getMe") return { id: 77, username: "ub_bot", first_name: "UB" } as T;
      if (method === "sendMessage") return { message_id: this.nextId++ } as T;
      return true as T;
    },
    now: () => this.clock,
    randomInt: () => 0,
  };
  core = new RelayCore(this.ports);

  async connect(deviceId: string, name: string) {
    const socket = { deviceId, name, frames: [] as Array<Record<string, unknown>>, send: (frame: string) => socket.frames.push(JSON.parse(frame)) };
    this.sockets.push(socket);
    await this.core.connected(deviceId, name);
    return socket;
  }

  drop(deviceId: string) {
    this.sockets = this.sockets.filter((socket) => socket.deviceId !== deviceId);
  }

  async request(socket: RelaySocket & { frames: Array<Record<string, unknown>> }, body: Record<string, unknown>) {
    const id = `r${socket.frames.length}-${Math.random()}`;
    await this.core.frame(socket, JSON.stringify({ t: "req", id, ...body }));
    return socket.frames.find((frame) => frame.id === id)!;
  }

  async say(chatId: number, text: string, replyTo?: number): Promise<TgMessage> {
    const message: TgMessage = {
      message_id: this.nextIncoming++,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, username: chatId === OWNER ? "owner" : "someone" },
      text,
      ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }),
    };
    await this.core.update({ update_id: message.message_id, message });
    return message;
  }

  sent() {
    return this.calls.filter((call) => call.method === "sendMessage").map((call) => call.params);
  }

  async bind(socket: RelaySocket & { frames: Array<Record<string, unknown>> }) {
    const res = await this.request(socket, { op: "pair" });
    const code = (res.result as { code: string }).code;
    await this.say(OWNER, `/start ${code}`);
  }
}

describe("RelayCore", () => {
  it("绑定：设备申请绑定码，手机 /start 后只认这个私聊，状态广播给所有设备", async () => {
    const world = new World();
    const mac = await world.connect("device-mac-0001", "MacBook");
    const res = await world.request(mac, { op: "pair" });
    expect(res.ok).toBe(true);
    expect((res.result as { link: string }).link).toBe("https://t.me/ub_bot?start=AAAAAAAA");

    await world.say(STRANGER, "/start WRONG000");
    expect(world.sent().at(-1)?.text).toContain("绑定码无效");
    await world.say(OWNER, "/start aaaaaaaa");
    expect(world.sent().at(-1)?.text).toContain("已绑定");
    const state = mac.frames.filter((frame) => frame.t === "state").at(-1)!;
    expect(state.bound).toEqual({ name: "@owner" });

    // 绑定后陌生人一概不理。
    const before = world.sent().length;
    await world.say(STRANGER, "/start AAAAAAAA");
    await world.say(STRANGER, "hi");
    expect(world.sent().length).toBe(before);
  });

  it("回复按提醒所属设备分发，直接发消息给最近推送的设备", async () => {
    const world = new World();
    const mac = await world.connect("device-mac-0001", "MacBook");
    const mini = await world.connect("device-mini-0002", "Mac mini");
    await world.bind(mac);

    const fromMac = (await world.request(mac, { op: "send", text: "⏳ a", push: true })).result as { messageId: number };
    const fromMini = (await world.request(mini, { op: "send", text: "⏳ b", push: true })).result as { messageId: number };
    // 多台设备：推送开头标出设备名。
    expect(world.sent().at(-1)?.text).toBe("💻 Mac mini\n⏳ b");

    await world.say(OWNER, "给 mac", fromMac.messageId);
    expect(mac.frames.filter((f) => f.t === "message").map((f) => (f.message as TgMessage).text)).toEqual(["给 mac"]);
    // 回复过 mac 之后，直接发的消息跟着去 mac。
    await world.say(OWNER, "接着说");
    expect(mac.frames.filter((f) => f.t === "message")).toHaveLength(2);

    await world.say(OWNER, "给 mini", fromMini.messageId);
    await world.say(OWNER, "还是 mini");
    expect(mini.frames.filter((f) => f.t === "message").map((f) => (f.message as TgMessage).text)).toEqual(["给 mini", "还是 mini"]);
  });

  it("配了路由设备：不引用的消息带候选清单交给它，由它 forward 到指定推送所属设备", async () => {
    const world = new World();
    const vps = await world.connect("device-vps-0000", "VPS 主控");
    const mac = await world.connect("device-mac-0001", "MacBook");
    const mini = await world.connect("device-mini-0002", "Mac mini");
    await world.bind(vps);
    world.ports.routerDeviceId = "device-vps-0000";

    // 没有候选推送：走原来的帮助文案，不打扰路由设备。
    await world.say(OWNER, "在吗");
    expect(world.sent().at(-1)?.text).toContain("直接发消息");
    expect(vps.frames.filter((f) => f.t === "route")).toHaveLength(0);

    const a = (await world.request(mac, { op: "send", text: "✅ 修登录 做完了\n\n改好了", push: true })).result as { messageId: number };
    const b = (await world.request(mini, { op: "send", text: "⏳ 跑迁移 在等你", push: true })).result as { messageId: number };

    const message = await world.say(OWNER, "迁移那个批准");
    const routed = vps.frames.filter((f) => f.t === "route");
    expect(routed).toHaveLength(1);
    expect(routed[0]!.message).toMatchObject({ text: "迁移那个批准" });
    expect(routed[0]!.candidates).toEqual([
      { id: b.messageId, deviceId: "device-mini-0002", deviceName: "Mac mini", preview: "⏳ 跑迁移 在等你", at: world.clock },
      { id: a.messageId, deviceId: "device-mac-0001", deviceName: "MacBook", preview: "✅ 修登录 做完了 改好了", at: world.clock },
    ]);
    // 路由设备判断前，其他设备都收不到。
    expect(mac.frames.filter((f) => f.t === "message")).toHaveLength(0);
    expect(mini.frames.filter((f) => f.t === "message")).toHaveLength(0);

    const forwarded = await world.request(vps, { op: "forward", message, target: b.messageId });
    expect(forwarded.ok).toBe(true);
    const got = mini.frames.filter((f) => f.t === "message").map((f) => f.message as TgMessage);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ text: "迁移那个批准", reply_to_message: { message_id: b.messageId } });
    expect(mac.frames.filter((f) => f.t === "message")).toHaveLength(0);

    // 只有路由设备能 forward；目标过期或离线都明确报错。
    expect((await world.request(mac, { op: "forward", message, target: b.messageId })).ok).toBe(false);
    expect((await world.request(vps, { op: "forward", message, target: 424242 })).error).toContain("已过期");
    world.drop("device-mini-0002");
    expect((await world.request(vps, { op: "forward", message, target: b.messageId })).error).toContain("现在不在线");
    expect((await world.request(vps, { op: "forward", message: { ...message, chat: { id: STRANGER, type: "private" } }, target: a.messageId })).ok).toBe(false);

    // 引用回复仍然精确路由，不经过路由设备。
    const before = vps.frames.filter((f) => f.t === "route").length;
    await world.say(OWNER, "精确回", a.messageId);
    expect(mac.frames.filter((f) => f.t === "message")).toHaveLength(1);
    expect(vps.frames.filter((f) => f.t === "route")).toHaveLength(before);

    // 候选过期后不再交给路由设备，路由设备下线时退回最近设备。
    world.clock += CANDIDATE_TTL_MS + 1;
    await world.say(OWNER, "太久了");
    expect(vps.frames.filter((f) => f.t === "route")).toHaveLength(before);
    world.ports.routerDeviceId = "device-gone-9999";
    const c = (await world.request(mac, { op: "send", text: "✅ 新的", push: true })).result as { messageId: number };
    void c;
    await world.say(OWNER, "回最近");
    expect(mac.frames.filter((f) => f.t === "message")).toHaveLength(2);
  });

  it("设备不在线、未知消息、太久以前的最近设备都不转发，并告诉用户", async () => {
    const world = new World();
    const mac = await world.connect("device-mac-0001", "MacBook");
    await world.bind(mac);
    const pushed = (await world.request(mac, { op: "send", text: "✅ done", push: true })).result as { messageId: number };

    world.drop("device-mac-0001");
    await world.say(OWNER, "在吗", pushed.messageId);
    expect(world.sent().at(-1)?.text).toContain("「MacBook」现在不在线");

    const back = await world.connect("device-mac-0001", "MacBook");
    await world.say(OWNER, "随便回", 12345);
    expect(world.sent().at(-1)?.text).toContain("不是可回复的提醒");

    world.clock += RECENT_DEVICE_TTL_MS + 1;
    await world.say(OWNER, "很久以后");
    expect(world.sent().at(-1)?.text).toContain("在线的设备");
    expect(back.frames.filter((f) => f.t === "message")).toHaveLength(0);
  });

  it("命令由中转回答；非推送的回复不登记路由；未绑定不能发", async () => {
    const world = new World();
    const mac = await world.connect("device-mac-0001", "MacBook");
    const early = await world.request(mac, { op: "send", text: "x" });
    expect(early).toMatchObject({ ok: false, error: "还没有绑定 Telegram" });

    await world.bind(mac);
    await world.say(OWNER, "/devices");
    expect(world.sent().at(-1)?.text).toContain("· MacBook");

    const ack = (await world.request(mac, { op: "send", text: "✓ 已发送", replyTo: 3 })).result as { messageId: number };
    expect(world.sent().at(-1)?.reply_parameters).toEqual({ message_id: 3, allow_sending_without_reply: true });
    // 单台设备：推送不加设备名。
    await world.request(mac, { op: "send", text: "⏳ a", push: true });
    expect(world.sent().at(-1)?.text).toBe("⏳ a");
    await world.say(OWNER, "回复确认消息", ack.messageId);
    expect(world.sent().at(-1)?.text).toContain("不是可回复的提醒");
  });

  it("解绑清掉私聊和路由；webhook 只在地址变化时设置", async () => {
    const world = new World();
    const mac = await world.connect("device-mac-0001", "MacBook");
    await world.bind(mac);
    await world.request(mac, { op: "unbind" });
    expect(mac.frames.filter((f) => f.t === "state").at(-1)?.bound).toBeNull();
    await world.say(OWNER, "hi");
    expect(mac.frames.filter((f) => f.t === "message")).toHaveLength(0);

    await world.core.ensureWebhook("https://r.example/telegram", "s");
    await world.core.ensureWebhook("https://r.example/telegram", "s");
    await world.core.ensureWebhook("https://r2.example/telegram", "s");
    const hooks = world.calls.filter((call) => call.method === "setWebhook");
    expect(hooks.map((call) => call.params.url)).toEqual(["https://r.example/telegram", "https://r2.example/telegram"]);
    expect(hooks[0]!.params.secret_token).toBe("s");
  });

  it("webhook 已指向别处就重新注册，storage 里的旧标记不算数", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let current = "https://old.example/telegram";
    // 旧实现会把「77|目标 url」当成已经设过，从而跳过 setWebhook。
    const store = new Map<string, unknown>([["webhook", "77|https://new.example/telegram"]]);
    const puts: string[] = [];
    const core = new RelayCore({
      storage: {
        get: async <T>(key: string) => structuredClone(store.get(key)) as T | undefined,
        put: async (key, value) => {
          puts.push(key);
          store.set(key, structuredClone(value));
        },
        delete: async (key) => store.delete(key),
      },
      sockets: () => [],
      telegram: async <T>(method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "getMe") return { id: 77, username: "ub_bot", first_name: "UB" } as T;
        if (method === "getWebhookInfo") return { url: current } as T;
        if (method === "setWebhook") {
          current = String(params.url ?? "");
          return true as T;
        }
        return true as T;
      },
      now: () => 1_000,
      randomInt: () => 0,
    });
    await core.ensureWebhook("https://new.example/telegram", "secret");
    const hooks = calls.filter((call) => call.method === "setWebhook");
    expect(hooks.map((call) => call.params.url)).toEqual(["https://new.example/telegram"]);
    expect(hooks[0]!.params.secret_token).toBe("secret");
    expect(puts).not.toContain("webhook");
  });

  it("webhook 已经指向目标时不调 setWebhook，60 秒内不重复查询", async () => {
    const calls: Array<{ method: string }> = [];
    let now = 5_000;
    const core = new RelayCore({
      storage: {
        get: async () => undefined,
        put: async () => undefined,
        delete: async () => undefined,
      },
      sockets: () => [],
      telegram: async <T>(method: string) => {
        calls.push({ method });
        if (method === "getMe") return { id: 77, username: "ub_bot", first_name: "UB" } as T;
        if (method === "getWebhookInfo") return { url: "https://r.example/telegram" } as T;
        return true as T;
      },
      now: () => now,
      randomInt: () => 0,
    });
    await core.ensureWebhook("https://r.example/telegram", "s");
    await core.ensureWebhook("https://r.example/telegram", "s");
    expect(calls.filter((call) => call.method === "setWebhook")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "getWebhookInfo")).toHaveLength(1);
    now += 60_000;
    await core.ensureWebhook("https://r.example/telegram", "s");
    expect(calls.filter((call) => call.method === "getWebhookInfo")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "setWebhook")).toHaveLength(0);
  });

  it("getWebhookInfo 失败时抛错，不调用 setWebhook", async () => {
    const calls: string[] = [];
    const core = new RelayCore({
      storage: {
        get: async () => undefined,
        put: async () => undefined,
        delete: async () => undefined,
      },
      sockets: () => [],
      telegram: async <T>(method: string) => {
        calls.push(method);
        if (method === "getMe") return { id: 77, username: "ub_bot", first_name: "UB" } as T;
        if (method === "getWebhookInfo") throw new Error("Telegram：暂时不可用");
        return true as T;
      },
      now: () => 1_000,
      randomInt: () => 0,
    });
    await expect(core.ensureWebhook("https://r.example/telegram", "s")).rejects.toThrow("暂时不可用");
    expect(calls).not.toContain("setWebhook");
  });
});
