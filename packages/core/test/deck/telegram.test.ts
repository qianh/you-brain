import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { MemorySecretStore } from "../../src/auth/secret-store.js";
import type { SessionNotice, SessionNoticeList } from "../../src/deck/session-notices.js";
import { TelegramBridge, noticeText } from "../../src/deck/telegram/bridge.js";
import type { TelegramUpdate } from "../../src/deck/telegram/api.js";
import type { Tty7Session, Tty7SendInput, Tty7SessionsView } from "../../src/deck/tty7.js";

const TOKEN = "123456789:AAbbccddeeffgghhiijjkkllmmnnooppqq";
const OWNER = 1001;
const STRANGER = 2002;

/** 假的 Telegram：记下发出的消息，按 offset 发放排队的更新。 */
class FakeTelegram {
  updates: TelegramUpdate[] = [];
  sent: Array<{ chat_id: number; text: string; reply_parameters?: { message_id: number } }> = [];
  nextId = 1;
  nextUpdate = 1;
  getMeStatus = 200;
  offsets: number[] = [];

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    expect(url).toContain(TOKEN);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const params = JSON.parse(String(init.body)) as Record<string, unknown>;
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (method === "getMe") {
      if (this.getMeStatus !== 200) {
        return new Response(JSON.stringify({ ok: false, error_code: this.getMeStatus, description: "Unauthorized" }));
      }
      return ok({ id: 77, is_bot: true, first_name: "UB", username: "ub_test_bot" });
    }
    if (method === "getUpdates") {
      const offset = params.offset as number;
      this.offsets.push(offset);
      const ready = this.updates.filter((update) => update.update_id >= offset);
      if (ready.length > 0) return ok(ready);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return ok([]);
    }
    if (method === "sendMessage") {
      this.sent.push(params as never);
      return ok({ message_id: 500 + this.nextId++, date: 0, chat: { id: params.chat_id, type: "private" } });
    }
    throw new Error(`unexpected ${method}`);
  };

  say(chatId: number, text: string, replyTo?: number): void {
    this.updates.push({
      update_id: this.nextUpdate++,
      message: {
        message_id: this.nextId++,
        date: 0,
        chat: { id: chatId, type: "private" },
        from: { id: chatId, first_name: "Me", username: chatId === OWNER ? "owner" : "someone" },
        text,
        ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }),
      },
    });
  }
}

function session(pane: number, status: Tty7Session["status"], cwd = `/w/${pane}`): Tty7Session {
  return {
    pane,
    workspaceId: "ws",
    workspaceName: "ws",
    tabId: `t${pane}`,
    tabLabel: null,
    agent: "Claude",
    cwd,
    hibernated: false,
    status,
    statusMessage: null,
    model: null,
  };
}

function notice(seq: number, pane: number, extra: Partial<SessionNotice> = {}): SessionNotice {
  return {
    seq,
    pane,
    kind: "waiting",
    status: "open",
    sessionName: `dir${pane}`,
    agent: "Claude",
    cwd: `/w/${pane}`,
    title: `dir${pane} 在等你回复`,
    body: "要不要继续？",
    at: "2026-11-19T00:00:00.000Z",
    ...extra,
  };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out: ${label}`);
}

async function setup(options: { token?: string | null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ub-telegram-"));
  const telegram = new FakeTelegram();
  const list: SessionNoticeList = { epoch: "e1", latest: 0, notices: [] };
  let sessions: Tty7Session[] = [];
  const sends: Tty7SendInput[] = [];
  const dismissed: number[] = [];
  const store = new MemorySecretStore(options.token === undefined ? null : options.token);
  const clock = { now: Date.parse("2026-11-19T10:00:00Z") };
  const bridge = new TelegramBridge({
    configPath: join(dir, "deck", "telegram.json"),
    token: store,
    notices: () => list,
    sessions: async (): Promise<Tty7SessionsView> => ({
      available: true,
      detail: "",
      workspaces: [],
      sessions,
      harnesses: [],
      appearance: null,
    }),
    send: async (input) => {
      sends.push(input);
    },
    dismiss: (input) => {
      if (input.pane !== undefined) dismissed.push(input.pane);
    },
    fetch: telegram.fetch,
    now: () => clock.now,
    pollTimeoutSec: 0,
    retryMs: [5],
  });
  return {
    clock,
    dir,
    telegram,
    list,
    bridge,
    store,
    sends,
    dismissed,
    setSessions: (next: Tty7Session[]) => {
      sessions = next;
    },
  };
}

/** 配好 Token 并完成绑定。 */
async function paired(notifications = true) {
  const ctx = await setup();
  await ctx.bridge.start();
  await ctx.bridge.action({ action: "set-token", token: TOKEN });
  const status = await ctx.bridge.action({ action: "pair" });
  ctx.telegram.say(OWNER, `/start ${status.pairing!.code}`);
  await until(() => ctx.telegram.sent.some((item) => item.text.includes("已绑定")), "bound");
  if (notifications) await ctx.bridge.action({ action: "set-notifications", enabled: true });
  ctx.telegram.sent = [];
  return ctx;
}

function push(ctx: Awaited<ReturnType<typeof setup>>, item: SessionNotice): void {
  ctx.list.notices.push(item);
  ctx.list.latest = item.seq;
  ctx.bridge.noticesChanged();
}

describe("TelegramBridge", () => {
  it("defaults to off, persists the device switch, and never backfills disabled notices", async () => {
    const ctx = await paired(false);
    const thread = { threadId: "t-1", title: "本轮完成", kind: "done", link: null } as const;
    try {
      expect(ctx.bridge.status().notificationsEnabled).toBe(false);
      expect(ctx.bridge.bound()).toBe(true);
      push(ctx, notice(1, 3));
      ctx.bridge.pushT3(thread);
      await ctx.bridge.flush();
      expect(ctx.telegram.sent).toHaveLength(0);
      await ctx.bridge.action({ action: "test" });
      expect(ctx.telegram.sent[0]?.text).toContain("测试消息");
      ctx.telegram.sent = [];

      expect((await ctx.bridge.action({ action: "set-notifications", enabled: true })).notificationsEnabled).toBe(true);
      ctx.bridge.stop();
      await ctx.bridge.start();
      expect(ctx.bridge.status().notificationsEnabled).toBe(true);
      ctx.bridge.noticesChanged();
      await ctx.bridge.flush();
      expect(ctx.telegram.sent).toHaveLength(0);
      push(ctx, notice(2, 3));
      await ctx.bridge.flush();
      const pushedId = 500 + ctx.telegram.nextId - 1;
      ctx.bridge.pushT3(thread);
      await ctx.bridge.flush();
      expect(ctx.telegram.sent.map((item) => item.chat_id)).toEqual([OWNER, OWNER]);

      ctx.setSessions([session(3, "waiting")]);
      expect((await ctx.bridge.action({ action: "set-notifications", enabled: false })).notificationsEnabled).toBe(false);
      push(ctx, notice(3, 3));
      ctx.bridge.pushT3(thread);
      await ctx.bridge.flush();
      expect(ctx.telegram.sent).toHaveLength(2);
      ctx.telegram.say(OWNER, "继续", pushedId);
      await until(() => ctx.sends.length === 1, "reply still works with notifications off");
      expect(ctx.sends[0]).toEqual({ pane: 3, text: "继续", enter: true });
    } finally {
      ctx.bridge.stop();
    }
  });

  it("does not send an in-flight T3 notice after turning notifications off and on", async () => {
    const ctx = await paired();
    const started = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<string>();
    try {
      ctx.bridge.attachT3({
        send: async () => "started",
        status: () => "completed",
        answer: () => { started.resolve(); return answer.promise; },
      });
      ctx.bridge.pushT3({ threadId: "t-1", title: "本轮完成", kind: "done", link: null });
      await started.promise;
      await ctx.bridge.action({ action: "set-notifications", enabled: false });
      await ctx.bridge.action({ action: "set-notifications", enabled: true });
      answer.resolve("旧通知");
      await ctx.bridge.flush();
      expect(ctx.telegram.sent).toHaveLength(0);
    } finally {
      answer.resolve("");
      ctx.bridge.stop();
    }
  });

  it("rejects a malformed or unknown token and keeps nothing", async () => {
    const ctx = await setup();
    await ctx.bridge.start();
    await expect(ctx.bridge.action({ action: "set-notifications", enabled: true })).rejects.toThrow("还没有绑定 Telegram");
    await expect(ctx.bridge.action({ action: "set-token", token: "nope" })).rejects.toThrow("格式不对");
    ctx.telegram.getMeStatus = 401;
    await expect(ctx.bridge.action({ action: "set-token", token: TOKEN })).rejects.toThrow("不认这个 Bot Token");
    expect(await ctx.store.get()).toBeNull();
    expect(ctx.bridge.status().configured).toBe(false);
    ctx.bridge.stop();
  });

  it("binds only with a valid pairing code and then ignores strangers", async () => {
    const ctx = await setup();
    await ctx.bridge.start();
    await ctx.bridge.action({ action: "set-token", token: TOKEN });
    expect(await ctx.store.get()).toBe(TOKEN);
    const status = await ctx.bridge.action({ action: "pair" });
    expect(status.pairing?.link).toBe(`https://t.me/ub_test_bot?start=${status.pairing?.code}`);

    ctx.telegram.say(STRANGER, "/start WRONGCODE");
    await until(() => ctx.telegram.sent.length === 1, "wrong-code reply");
    expect(ctx.telegram.sent[0]!.text).toContain("绑定码无效");
    expect(ctx.bridge.status().bound).toBeNull();

    ctx.telegram.say(OWNER, `/start ${status.pairing!.code}`);
    await until(() => ctx.bridge.status().bound !== null, "bound");
    expect(ctx.bridge.status().bound).toEqual({ name: "@owner" });
    expect(ctx.bridge.status().pairing).toBeNull();
    const saved = JSON.parse(await readFile(join(ctx.dir, "deck", "telegram.json"), "utf8"));
    expect(saved.chatId).toBe(OWNER);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);

    const before = ctx.telegram.sent.length;
    ctx.telegram.say(STRANGER, "/start anything");
    ctx.telegram.say(STRANGER, "hello");
    await until(() => ctx.telegram.offsets.at(-1)! > ctx.telegram.nextUpdate - 1, "stranger consumed");
    expect(ctx.telegram.sent.length).toBe(before);
    ctx.bridge.stop();
  });

  it("pushes new waiting notices and AI done notices, but not plain-script done", async () => {
    const ctx = await paired();
    push(ctx, notice(1, 3));
    push(ctx, notice(2, 4, { kind: "done", title: "dir4 已完成" }));
    push(ctx, notice(3, 5, { kind: "done", agent: null, title: "dir5 已完成" }));
    await ctx.bridge.flush();
    expect(ctx.telegram.sent.map((item) => item.text)).toEqual([
      noticeText("waiting", "dir3 在等你回复", "要不要继续？"),
      noticeText("done", "dir4 已完成", "要不要继续？"),
    ]);
    expect(ctx.telegram.sent[0]!.chat_id).toBe(OWNER);
    ctx.bridge.noticesChanged();
    await ctx.bridge.flush();
    expect(ctx.telegram.sent).toHaveLength(2);
    ctx.bridge.stop();
  });

  it("still pushes a notice that was born closed because the session is open on the computer", async () => {
    const ctx = await paired();
    push(ctx, notice(1, 3, { status: "closed" }));
    await ctx.bridge.flush();
    expect(ctx.telegram.sent.map((item) => item.text)).toEqual([noticeText("waiting", "dir3 在等你回复", "要不要继续？")]);
    ctx.bridge.stop();
  });

  it("replying to an AI done notice sends the next instruction", async () => {
    const ctx = await paired();
    ctx.setSessions([session(4, "done")]);
    push(ctx, notice(1, 4, { kind: "done", title: "dir4 已完成" }));
    await ctx.bridge.flush();
    const pushedId = 500 + ctx.telegram.nextId - 1;
    ctx.telegram.say(OWNER, "继续做第二步", pushedId);
    await until(() => ctx.sends.length === 1, "sent to tty7");
    expect(ctx.sends[0]).toEqual({ pane: 4, text: "继续做第二步", enter: true });
    expect(ctx.dismissed).toEqual([4]);
    ctx.bridge.stop();
  });

  it("types a reply into the session and closes the notice", async () => {
    const ctx = await paired();
    ctx.setSessions([session(3, "waiting")]);
    push(ctx, notice(1, 3));
    await ctx.bridge.flush();
    const pushedId = 500 + ctx.telegram.nextId - 1;

    ctx.telegram.say(OWNER, "1", pushedId);
    await until(() => ctx.sends.length === 1, "sent to tty7");
    expect(ctx.sends[0]).toEqual({ pane: 3, text: "1", enter: true });
    expect(ctx.dismissed).toEqual([3]);
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("已发送到「dir3」")), "ack");
    ctx.bridge.stop();
  });

  it("refuses to type into a working, closed or reused session", async () => {
    const ctx = await paired();
    push(ctx, notice(1, 3));
    await ctx.bridge.flush();
    const pushedId = 500 + ctx.telegram.nextId - 1;

    ctx.setSessions([session(3, "working")]);
    ctx.telegram.say(OWNER, "go", pushedId);
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("正在执行")), "working");

    ctx.setSessions([session(3, "waiting", "/other")]);
    ctx.telegram.say(OWNER, "go", pushedId);
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("已经关闭")), "reused pane");

    ctx.telegram.say(OWNER, "go", 9999);
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("提醒已失效")), "unknown");

    ctx.telegram.say(OWNER, "/help");
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("dir3 在等你回复")), "help lists waiting");
    expect(ctx.sends).toEqual([]);
    ctx.bridge.stop();
  });

  it("sends a plain message to the most recently pushed session", async () => {
    const ctx = await paired();
    ctx.setSessions([session(3, "done"), session(4, "waiting")]);
    push(ctx, notice(1, 3, { kind: "done", title: "dir3 已完成" }));
    await ctx.bridge.flush();
    const first = 500 + ctx.telegram.nextId - 1;
    push(ctx, notice(2, 4));
    await ctx.bridge.flush();

    ctx.telegram.say(OWNER, "我收到了");
    await until(() => ctx.sends.length === 1, "plain to latest");
    expect(ctx.sends[0]).toEqual({ pane: 4, text: "我收到了", enter: true });

    // 回复了较早的提醒，之后直接发的消息就跟着去那个会话。
    ctx.telegram.say(OWNER, "第一个", first);
    await until(() => ctx.sends.length === 2, "reply to first");
    ctx.telegram.say(OWNER, "接着说", undefined);
    await until(() => ctx.sends.length === 3, "plain follows reply");
    expect(ctx.sends.map((item) => item.pane)).toEqual([4, 3, 3]);
    ctx.bridge.stop();
  });

  it("does not guess a target when nothing was pushed recently", async () => {
    const ctx = await paired();
    ctx.telegram.say(OWNER, "在吗");
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("直接发消息")), "help without recent");

    ctx.setSessions([session(3, "waiting")]);
    push(ctx, notice(1, 3));
    await ctx.bridge.flush();
    ctx.clock.now += 2 * 60 * 60_000 + 1;
    const before = ctx.telegram.sent.length;
    ctx.telegram.say(OWNER, "太晚了");
    await until(() => ctx.telegram.sent.length > before, "help after ttl");
    expect(ctx.telegram.sent.at(-1)!.text).toContain("直接发消息");
    expect(ctx.sends).toEqual([]);
    ctx.bridge.stop();
  });

  it("resumes after the saved offset so old replies are not replayed", async () => {
    const ctx = await paired();
    ctx.telegram.say(OWNER, "/help");
    await until(() => ctx.telegram.sent.length === 1, "help");
    ctx.bridge.stop();
    const saved = JSON.parse(await readFile(join(ctx.dir, "deck", "telegram.json"), "utf8"));
    expect(saved.offset).toBe(ctx.telegram.nextUpdate);

    const again = new TelegramBridge({
      configPath: join(ctx.dir, "deck", "telegram.json"),
      token: ctx.store,
      notices: () => ctx.list,
      sessions: async () => ({ available: true, detail: "", workspaces: [], sessions: [], harnesses: [], appearance: null }),
      send: async () => undefined,
      dismiss: () => undefined,
      fetch: ctx.telegram.fetch,
      pollTimeoutSec: 0,
    });
    ctx.telegram.offsets = [];
    await again.start();
    await until(() => ctx.telegram.offsets.length > 0, "polled");
    expect(ctx.telegram.offsets[0]).toBe(saved.offset);
    expect(again.status().bound).toEqual({ name: "@owner" });
    again.stop();
  });

  it("pushes a finished T3 turn with its answer and sends replies into the thread", async () => {
    const ctx = await paired();
    const sent: Array<{ threadId: string; text: string }> = [];
    let status = "completed";
    let delivery = "started";
    ctx.bridge.attachT3({
      send: async (threadId, text) => {
        sent.push({ threadId, text });
        return delivery;
      },
      status: () => status,
      answer: async () => "改好了，测试全过。",
    });
    expect(ctx.bridge.bound()).toBe(true);
    ctx.bridge.pushT3({ threadId: "t-1", title: "修复登录", kind: "done", link: "https://app.t3.codes/threads/e/t-1" });
    await ctx.bridge.flush();
    expect(ctx.telegram.sent[0]!.text).toContain("✅ T3「修复登录」做完了");
    expect(ctx.telegram.sent[0]!.text).toContain("改好了，测试全过。");
    expect(ctx.telegram.sent[0]!.text).toContain("🔗 https://app.t3.codes/threads/e/t-1");

    ctx.telegram.say(OWNER, "再补一个测试");
    await until(() => sent.length === 1, "plain to t3");
    expect(sent[0]).toEqual({ threadId: "t-1", text: "再补一个测试" });
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("已发送到 T3「修复登录」")), "t3 ack");

    delivery = "queued";
    ctx.telegram.say(OWNER, "顺便更新文档");
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("已排队到 T3")), "queued ack");

    status = "waiting";
    ctx.telegram.say(OWNER, "批准");
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("要到 T3 里操作")), "waiting refused");
    expect(sent).toHaveLength(2);
    expect(ctx.sends).toEqual([]);
    ctx.bridge.stop();
  });

  it("pushDispatch pushes with 🛰 device prefix, respects notificationsEnabled, and does not register reply routing", async () => {
    const ctx = await paired();
    ctx.bridge.pushDispatch({
      deviceName: "Mac Studio",
      title: "排查日志",
      kind: "done",
      body: "已修复并验证通过",
      link: "https://t3.example/t-9",
    });
    ctx.bridge.pushDispatch({
      deviceName: "Mac Studio",
      title: "部署确认",
      kind: "waiting",
    });
    ctx.bridge.pushDispatch({
      deviceName: "Mac Studio",
      title: "跑单测",
      kind: "failed",
      body: "编译失败",
    });
    await ctx.bridge.flush();

    expect(ctx.telegram.sent).toHaveLength(3);
    expect(ctx.telegram.sent[0]!.text).toContain("✅ 🛰 Mac Studio「排查日志」做完了");
    expect(ctx.telegram.sent[0]!.text).toContain("已修复并验证通过");
    expect(ctx.telegram.sent[0]!.text).toContain("🔗 https://t3.example/t-9");
    expect(ctx.telegram.sent[1]!.text).toContain("⏳ 🛰 Mac Studio「部署确认」在等你处理授权或提问");
    expect(ctx.telegram.sent[2]!.text).toContain("❌ 🛰 Mac Studio「跑单测」执行失败");

    // 未登记 #sent 与 #recent：回复它或直接发消息都不会路由到本机会话
    const pushedId = 500 + ctx.telegram.nextId - 1;
    ctx.telegram.say(OWNER, "继续", pushedId);
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("不是可回复的提醒")), "dispatch reply rejected");
    ctx.telegram.say(OWNER, "随便说一句");
    await until(() => ctx.telegram.sent.some((item) => item.text.includes("直接发消息")), "dispatch not set as recent");
    expect(ctx.sends).toEqual([]);

    // 关闭通知开关后不再推送
    await ctx.bridge.action({ action: "set-notifications", enabled: false });
    const countBefore = ctx.telegram.sent.length;
    ctx.bridge.pushDispatch({ deviceName: "Mac Studio", title: "静默", kind: "done", body: "不应推送" });
    await ctx.bridge.flush();
    expect(ctx.telegram.sent.length).toBe(countBefore);
    ctx.bridge.stop();
  });

  it("set-relay uses options.deviceId when no relay.deviceId is stored yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yb-tg-devid-"));
    const relayKey = new MemorySecretStore(null);
    const bridge = new TelegramBridge({
      configPath: join(dir, "deck", "telegram.json"),
      token: new MemorySecretStore(null),
      relayKey,
      deviceId: "stable-dev-id-1234",
      notices: () => ({ epoch: "e1", latest: 0, notices: [] }),
      sessions: async () => ({ available: true, detail: "", workspaces: [], sessions: [], harnesses: [], appearance: null }),
      send: async () => undefined,
      dismiss: () => undefined,
      relayFetch: async () => new Response(JSON.stringify({ ok: true, botConfigured: true }), { status: 200 }),
    });
    try {
      await bridge.action({ action: "set-relay", url: "https://relay.example.com", key: "0123456789abcdef" });
      const saved = JSON.parse(await readFile(join(dir, "deck", "telegram.json"), "utf8")) as {
        relay: { deviceId: string };
      };
      expect(saved.relay.deviceId).toBe("stable-dev-id-1234");
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clear-token forgets the token and the binding", async () => {
    const ctx = await paired();
    const status = await ctx.bridge.action({ action: "clear-token" });
    expect(status).toMatchObject({ configured: false, bound: null, connection: "off" });
    expect(await ctx.store.get()).toBeNull();
    ctx.bridge.stop();
  });
});
