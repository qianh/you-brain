import { createECDH } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { MuseDeckRuntime, type MuseClientLike } from "../../src/deck/muse/runtime.js";
import {
  CipherState,
  MuseTurn,
  NoiseInitiator,
  PacketAssembler,
  PairingSession,
  encodePackets,
  identityFromMac,
  type ChatEvent,
} from "../../src/deck/muse/sdk/index.js";
import { MAIN_MUSE_SESSION_ID, MuseChatStore } from "../../src/deck/muse/store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "you-brain-muse-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("Muse SDK protocol primitives", () => {
  it("CipherState encrypts and decrypts AES-256-GCM frames and rejects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const sender = new CipherState(key);
    const receiver = new CipherState(key);
    const ct = sender.encrypt(Buffer.from("hello muse"), Buffer.from("aad"));
    expect(receiver.decrypt(ct, Buffer.from("aad")).toString("utf8")).toBe("hello muse");

    const tampered = Buffer.from(ct);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    expect(() => receiver.decrypt(tampered, Buffer.from("aad"))).toThrow();
  });

  it("NoiseInitiator rejects truncated handshake message2", () => {
    const initiator = new NoiseInitiator();
    const m1 = initiator.message1();
    expect(m1.length).toBe(32);
    expect(() => initiator.receiveMessage2(Buffer.alloc(32))).toThrow();
  });

  it("PairingSession v5 completes mobile ECDH handshake and BLE packet reassembly", () => {
    const identity = identityFromMac("02:11:22:33:44:55");
    expect(identity.name).toBe("MuseGadget334455");
    expect(identity.nodeId).toBe("homelink-334455");

    const mobile = createECDH("prime256v1");
    mobile.generateKeys();
    const session = new PairingSession(identity);
    const ready = session.hello({
      version: 5,
      pairing_auth: "none",
      pairing_policy: "confirm_app",
      mobile_pub: mobile.getPublicKey().toString("base64url"),
      mobile_nonce: Buffer.alloc(16, 9).toString("base64url"),
    });
    expect(ready.type).toBe("pairing_ready");
    expect(ready.node_id).toBe("homelink-334455");

    const payload = Buffer.from(JSON.stringify(ready));
    const packets = encodePackets(payload);
    expect(packets.length).toBeGreaterThan(1);
    const assembler = new PacketAssembler();
    let reassembled: Buffer | undefined;
    for (const pkt of packets) {
      reassembled = assembler.feed(pkt);
    }
    expect(reassembled?.equals(payload)).toBe(true);
  });
});

describe("MuseChatStore", () => {
  it("keeps main session pinned, auto-titles new side sessions, and persists across reloads", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "chats.json");
    const store = new MuseChatStore(file, () => new Date("2026-11-18T10:00:00.000Z"));

    const initial = await store.listSessions();
    expect(initial.map((s) => s.id)).toEqual([MAIN_MUSE_SESSION_ID]);

    const side = await store.createSideSession();
    expect(side.kind).toBe("side");
    expect(side.initializedOnServer).toBe(false);

    await store.upsertMessage(side.id, {
      id: "m1",
      role: "user",
      text: "帮我整理今天下午的会议纪要",
      createdAt: "2026-11-18T10:01:00.000Z",
      done: true,
    });

    const reloaded = new MuseChatStore(file);
    const after = await reloaded.getSession(side.id);
    expect(after?.title).toBe("帮我整理今天下午的会议纪要");
    expect(after?.messages.length).toBe(1);
  });
});

describe("MuseDeckRuntime", () => {
  async function writeDummyCredentials(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "identity.json"), JSON.stringify({ mac: "02:aa:bb:cc:dd:ee" }));
    await writeFile(
      join(dir, "pairing.json"),
      JSON.stringify({
        access_token: "acc_test",
        refresh_token: "ref_test",
        token_type: "device",
        sdk_token_hint: "mgst_1234567",
      }),
    );
  }

  it("imports external pairing, creates a side chat (sendMessage before subscribe on first turn), and syncs phone app messages on Main Chat", async () => {
    const dir = await makeTempDir();
    const externalDir = join(dir, "external-pair");
    await writeDummyCredentials(externalDir);

    const callOrder: string[] = [];
    const mainSubscribers = new Set<(ev: ChatEvent) => void>();

    const fakeClient: MuseClientLike = {
      closed: false,
      vm: { id: "vm-1", name: "My Muse VM", url: "wss://hatch.metaaivm.com", isDefault: true },
      vms: [{ id: "vm-1", name: "My Muse VM", url: "wss://hatch.metaaivm.com", isDefault: true }],
      onDisconnect: () => () => {},
      close: () => {},
      sendMessage: async (message, options) => {
        callOrder.push(`send:${options?.sessionId ?? "main"}:${message}`);
        return {
          messageId: "u-ack-1",
          raw: {
            result: {
              message_id: "u-ack-1",
              ...(options?.sessionId ? { session_id: options.sessionId, is_thread: true } : {}),
            },
          },
        };
      },
      subscribe: async (options) => {
        callOrder.push(`subscribe:${options?.sessionId ?? "main"}`);
        if (options?.sessionId) {
          // Side chat first turn subscription yields assistant reply then task completed.
          const sideId = options.sessionId;
          return {
            close: () => {},
            async *[Symbol.asyncIterator]() {
              yield {
                type: "event",
                event: "delta.text_append",
                seq: 1,
                payload: { session_id: sideId, message_id: "a-side-1", text: "你好，这是子会话回复" },
                raw: {},
              };
              yield {
                type: "event",
                event: "delta.message_done",
                seq: 2,
                payload: {
                  session_id: sideId,
                  message_id: "a-side-1",
                  display_text: "你好，这是子会话回复！",
                },
                raw: {},
              };
              yield {
                type: "event",
                event: "task.status",
                seq: 3,
                payload: { session_id: sideId, task_id: "t-1", status: "completed", reply_to_message_id: "u-ack-1" },
                raw: {},
              };
            },
          };
        }
        // Main chat background subscription stays open to receive phone Muse App events.
        const queue: ChatEvent[] = [];
        let wake: (() => void) | undefined;
        let closed = false;
        const push = (ev: ChatEvent): void => {
          queue.push(ev);
          wake?.();
        };
        mainSubscribers.add(push);
        options?.signal?.addEventListener("abort", () => {
          closed = true;
          mainSubscribers.delete(push);
          wake?.();
        });
        return {
          close: () => {
            closed = true;
            mainSubscribers.delete(push);
            wake?.();
          },
          async *[Symbol.asyncIterator]() {
            while (!closed) {
              const item = queue.shift();
              if (item) yield item;
              else await new Promise<void>((r) => { wake = r; });
            }
          },
        };
      },
      chat: async function* (_message, options) {
        callOrder.push(`chat:${options?.sessionId ?? "main"}`);
        yield {
          type: "reply",
          messageId: "a-side-2",
          text: "第二轮回复",
          streamed: "第二轮回复",
          done: true,
          bound: true,
        };
        yield { type: "task-finished" };
      },
    };

    const runtime = new MuseDeckRuntime({
      dataDir: dir,
      homeDir: dir,
      platform: "darwin",
      externalDir,
      connectClient: async () => fakeClient,
    });

    try {
      const before = await runtime.overview();
      expect(before.paired).toBe(false);
      expect(before.hasExternalPairing).toBe(true);

      const imported = await runtime.action({ action: "pair-import" });
      expect(imported.overview.paired).toBe(true);
      expect(imported.overview.connection).toBe("connected");

      // Create a side chat and send first message: must call sendMessage BEFORE subscribe(sideId)!
      const created = await runtime.action({ action: "session-create" });
      const sideId = created.createdSessionId!;
      expect(sideId).toBeTruthy();

      await runtime.send({ sessionId: sideId, text: "第一句话" });
      // Wait for async turn to settle
      for (let i = 0; i < 40; i++) {
        const s = await runtime.session(sideId);
        if (!s?.busy) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      const sideSendIdx = callOrder.indexOf(`send:${sideId}:第一句话`);
      const sideSubIdx = callOrder.indexOf(`subscribe:${sideId}`);
      expect(sideSendIdx).toBeGreaterThanOrEqual(0);
      expect(sideSubIdx).toBeGreaterThan(sideSendIdx);

      const afterFirst = await runtime.session(sideId);
      expect(afterFirst?.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
        "user:第一句话",
        "assistant:你好，这是子会话回复！",
      ]);

      // Second message on the same side chat uses `chat()` with ownsChat!
      await runtime.send({ sessionId: sideId, text: "第二句话" });
      for (let i = 0; i < 40; i++) {
        const s = await runtime.session(sideId);
        if (!s?.busy) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(callOrder).toContain(`chat:${sideId}`);
      const afterSecond = await runtime.session(sideId);
      expect(afterSecond?.messages.length).toBe(4);

      // Simulate a message typed on the user's phone Muse App arriving on Main Chat!
      for (const sub of mainSubscribers) {
        sub({
          type: "event",
          event: "message.user",
          seq: 10,
          payload: { message_id: "phone-u-1", role: "user", display_text: "手机上发的消息" },
          raw: {},
        });
        sub({
          type: "event",
          event: "message.assistant",
          seq: 11,
          payload: { message_id: "phone-a-1", role: "assistant", display_text: "同步到电脑的 Muse 回复" },
          raw: {},
        });
      }
      await new Promise((r) => setTimeout(r, 40));

      const mainDetail = await runtime.session(MAIN_MUSE_SESSION_ID);
      expect(mainDetail?.messages.map((m) => `${m.role}(${m.origin}):${m.text}`)).toEqual([
        "user(app):手机上发的消息",
        "assistant(app):同步到电脑的 Muse 回复",
      ]);
      expect(MuseTurn).toBeDefined();
    } finally {
      runtime.stop();
    }
  });

  it("handles Main Chat parentless replies with real UUID session_id (is_thread: false) and backfills /chat/history", async () => {
    const dir = await makeTempDir();
    const museDir = join(dir, "deck", "muse");
    await writeDummyCredentials(museDir);

    const MAIN_UUID = "c6f7534f-12cc-4b6b-8c90-8ab3a5212a29";
    const subscribers = new Set<(ev: ChatEvent) => void>();

    const fakeClient: MuseClientLike = {
      closed: false,
      vm: { id: "vm-1", name: "My Muse VM", url: "wss://hatch.metaaivm.com", isDefault: true },
      vms: [{ id: "vm-1", name: "My Muse VM", url: "wss://hatch.metaaivm.com", isDefault: true }],
      onDisconnect: () => () => {},
      close: () => {},
      fetchHistory: async () => [
        {
          messageId: "hist-prev-1",
          role: "assistant",
          text: "较早的提醒通知",
          occurredAtMs: 1_700_000_000_500,
        },
        {
          messageId: "hist-u-1",
          role: "user",
          text: "谈谈你对我的了解",
          occurredAtMs: 1_700_000_001_000,
        },
        {
          messageId: "hist-a-1",
          role: "assistant",
          text: "这是历史回复正文",
          occurredAtMs: 1_700_000_002_000,
        },
      ],
      sendMessage: async () => {
        setTimeout(() => {
          for (const push of subscribers) {
            push({
              type: "event",
              event: "message.assistant",
              seq: 20,
              payload: {
                session_id: MAIN_UUID,
                is_thread: false,
                visibility: "public",
                role: "assistant",
                message_id: "assistant-msg-live-1",
                display_text: "这是主对话无父 ID 的实时回复！",
                display_text_ready: true,
              },
              raw: {},
            });
            push({
              type: "event",
              event: "task.status",
              seq: 21,
              payload: {
                session_id: MAIN_UUID,
                is_thread: false,
                task_id: "task-main-1",
                status: "completed",
              },
              raw: {},
            });
          }
        }, 10);
        return {
          messageId: "user-msg-live-1",
          raw: { result: { message_id: "user-msg-live-1", session_id: MAIN_UUID, is_thread: false } },
        };
      },
      subscribe: async (options) => {
        const queue: ChatEvent[] = [];
        let wake: (() => void) | undefined;
        let closed = false;
        const push = (ev: ChatEvent): void => {
          queue.push(ev);
          wake?.();
        };
        subscribers.add(push);
        options?.signal?.addEventListener("abort", () => {
          closed = true;
          subscribers.delete(push);
          wake?.();
        });
        return {
          close: () => {
            closed = true;
            subscribers.delete(push);
            wake?.();
          },
          async *[Symbol.asyncIterator]() {
            while (!closed) {
              const item = queue.shift();
              if (item) yield item;
              else await new Promise<void>((r) => { wake = r; });
            }
          },
        };
      },
      chat: async function* () {},
    };

    const runtime = new MuseDeckRuntime({
      dataDir: dir,
      homeDir: dir,
      platform: "darwin",
      connectClient: async () => fakeClient,
    });

    try {
      await runtime.action({ action: "reconnect" });

      const afterHistory = await runtime.session(MAIN_MUSE_SESSION_ID);
      expect(afterHistory?.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
        "assistant:较早的提醒通知",
        "user:谈谈你对我的了解",
        "assistant:这是历史回复正文",
      ]);

      await runtime.send({ sessionId: MAIN_MUSE_SESSION_ID, text: "现在再回复我一句" });
      for (let i = 0; i < 40; i++) {
        const s = await runtime.session(MAIN_MUSE_SESSION_ID);
        if (!s?.busy) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      const finalMain = await runtime.session(MAIN_MUSE_SESSION_ID);
      expect(finalMain?.busy).toBe(false);
      expect(finalMain?.messages.at(-1)?.text).toBe("这是主对话无父 ID 的实时回复！");
    } finally {
      runtime.stop();
    }
  });
});
