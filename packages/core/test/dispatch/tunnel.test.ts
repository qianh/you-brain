import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";

import { TUNNEL_RELAY_FRAME_MAX, TUNNEL_RESET_FRAME, generateKeyPair, signTunnelTranscript, type CmdFrame } from "@you-brain/protocol";

import { PeerPins, TUNNEL_VIRTUAL_ORIGIN, TunnelClient, TunnelHost } from "../../src/dispatch/tunnel.js";

const A = "device-a";
const B = "device-b";

describe("T3 隧道（内存里的假中转 + 假的本机 T3）", () => {
  let t3: Server<undefined> | null = null;
  let dir = "";
  afterEach(async () => {
    t3?.stop(true);
    t3 = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  async function setup(
    options: {
      allow?: boolean;
      tamper?: boolean;
      bKey?: ReturnType<typeof generateKeyPair>;
      offeredKey?: string;
      /** B 收到帧一律不理也不回（模拟不会回 reset 的旧版本对端已丢了会话）。 */
      silentHost?: boolean;
      headTimeoutMs?: number;
    } = {},
  ) {
    dir = await mkdtemp(join(tmpdir(), "ub-tunnel-"));
    const seen: Array<{ method: string; path: string; origin: string | null; cookie: string | null; body: string }> = [];
    t3 = Bun.serve<undefined, never>({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/ws") return server.upgrade(request) ? undefined : new Response("bad", { status: 400 });
        const body = await request.text();
        seen.push({ method: request.method, path: url.pathname + url.search, origin: request.headers.get("origin"), cookie: request.headers.get("cookie"), body });
        if (url.pathname === "/slow") await Bun.sleep(400);
        if (url.pathname === "/big") return new Response(new Uint8Array(300_000).fill(7), { headers: { "content-type": "application/octet-stream" } });
        if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `${url.origin}/next` } });
        if (url.pathname === "/cookie") return new Response("ok", { headers: { "set-cookie": "t3_session=abc; Path=/; HttpOnly" } });
        return new Response(`echo:${request.method}:${body}`);
      },
      websocket: {
        message(socket, message) {
          socket.send(typeof message === "string" ? `ws:${message}` : message);
        },
      },
    });
    const bKey = options.bKey ?? generateKeyPair();
    const sender = { deviceId: A, name: "A", publicKey: "unused" };
    let host!: TunnelHost;
    let client!: TunnelClient;
    const frames: string[] = [];
    host = new TunnelHost({
      deviceId: B,
      authorize: async () => (options.allow === false ? { ok: false, error: "本机没有开放 T3 查看" } : { ok: true, sender }),
      signTranscript: async (transcript) => signTunnelTranscript(bKey.privateKey, transcript),
      localUrl: async () => `http://127.0.0.1:${t3!.port}/`,
      // Bun 在同一进程里「大响应后紧跟大请求体」的 fetch 会偶发卡住（真实 T3 在另一个进程里不受影响），
      // 大请求体的用例直接在这里应答，仍然检查到达目标的字节数。
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/up")) {
          const body = Buffer.from(init?.body as Uint8Array);
          seen.push({ method: String(init?.method), path: "/up", origin: null, cookie: null, body: body.toString() });
          return new Response(`echo:${String(init?.method)}:${body.toString()}`);
        }
        return fetch(input, init);
      }) as typeof fetch,
      pairCredential: async () => "one-time-credential",
      // 和 hub 一样：收方两边都不认识这条会话、且不是 reset 本身时回 reset。
      send: async (_to, sid, data) => {
        queueMicrotask(() => {
          const known = client.onFrame(B, sid, options.tamper ? `${data.slice(0, -2)}AA` : data);
          if (!known && data !== TUNNEL_RESET_FRAME) host.onFrame(A, sid, TUNNEL_RESET_FRAME);
        });
      },
    });
    client = new TunnelClient({
      deviceId: A,
      dispatch: async (to, kind, args) => {
        const frame = { t: "cmd", cmdId: "c", from: A, to, cmd: { kind, args }, ts: 0, nonce: "n", sig: "s" } as CmdFrame;
        return host.open(frame);
      },
      send: async (_to, sid, data) => {
        frames.push(data);
        if (options.silentHost) return;
        queueMicrotask(() => {
          const known = host.onFrame(A, sid, data);
          if (!known && data !== TUNNEL_RESET_FRAME) client.onFrame(B, sid, TUNNEL_RESET_FRAME);
        });
      },
      peerKey: () => options.offeredKey ?? bKey.publicKey,
      pins: new PeerPins(dir),
      ...(options.headTimeoutMs !== undefined ? { headTimeoutMs: options.headTimeoutMs } : {}),
    });
    return { host, client, seen, frames, bKey };
  }

  it("HTTP：路径与头原样到本机 T3，Origin 换回本机地址，Location 换成虚拟源，Set-Cookie 带回", async () => {
    const { client, seen } = await setup();
    const session = await client.session(B);
    const echo = await session.fetch("/api/x?y=1", {
      method: "POST",
      headers: [["origin", TUNNEL_VIRTUAL_ORIGIN], ["cookie", "t3_session=old"], ["host", "evil"]],
      body: new TextEncoder().encode("你好"),
    });
    expect(await echo.text()).toBe("echo:POST:你好");
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/x?y=1", origin: `http://127.0.0.1:${t3!.port}`, cookie: "t3_session=old" });

    const redirect = await session.fetch("/redirect", { method: "GET", headers: [] });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(`${TUNNEL_VIRTUAL_ORIGIN}/next`);

    const cookie = await session.fetch("/cookie", { method: "GET", headers: [] });
    expect(cookie.headers.getSetCookie()).toEqual(["t3_session=abc; Path=/; HttpOnly"]);
  });

  it("大响应分块传回、内容完整；大请求体分块送到", async () => {
    const { client, seen } = await setup();
    const session = await client.session(B);
    const big = new Uint8Array(await (await session.fetch("/big", { method: "GET", headers: [] })).arrayBuffer());
    expect(big.length).toBe(300_000);
    expect(big.every((byte) => byte === 7)).toBe(true);
    const payload = "x".repeat(250_000);
    const echoed = await (await session.fetch("/up", { method: "PUT", headers: [], body: new TextEncoder().encode(payload) })).text();
    expect(echoed).toBe(`echo:PUT:${payload}`);
    expect(seen.at(-1)?.body.length).toBe(250_000);
  });

  it("WebSocket 双向、配对凭据由对端签发；路径不合法被拒", async () => {
    const { client } = await setup();
    const session = await client.session(B);
    const socket = session.socket("/ws", []);
    const events: string[] = [];
    socket.addEventListener("open", () => {
      events.push("open");
      socket.send("hi");
    });
    socket.addEventListener("message", ((event: { data: unknown }) => {
      events.push(String(event.data));
      socket.close(1000, "done");
    }) as (event: never) => void);
    await Bun.sleep(300);
    expect(events).toEqual(["open", "ws:hi"]);
    expect(await session.pair()).toBe("one-time-credential");
    await expect(session.fetch("//evil.example/x", { method: "GET", headers: [] })).rejects.toThrow("路径不合法");
  });

  it("目标没开放时握手失败；对端公钥被换、握手签名不对都拒绝；帧被改动后会话关闭", async () => {
    await expect((await setup({ allow: false })).client.session(B)).rejects.toThrow("本机没有开放 T3 查看");
    const wrongSig = await setup({ offeredKey: generateKeyPair().publicKey });
    await expect(wrongSig.client.session(B)).rejects.toThrow("握手签名不对");

    const pinned = await setup();
    await pinned.client.session(B);
    const swapped = new TunnelClient({
      deviceId: A,
      dispatch: async () => ({ ok: true, result: { epk: "x", sig: "y" } }),
      send: async () => undefined,
      peerKey: () => generateKeyPair().publicKey,
      pins: new PeerPins(dir),
    });
    await expect(swapped.session(B)).rejects.toThrow("身份密钥变了");

    const tampered = await setup({ tamper: true });
    const session = await tampered.client.session(B);
    await expect(session.fetch("/x", { method: "GET", headers: [] })).rejects.toThrow();
    expect(session.closed).toBe(true);
  });

  it("WebSocket 大消息自动经 ws-gzip 压缩与分片重组，不触发中转帧长上限", async () => {
    const { client, frames } = await setup();
    const session = await client.session(B);
    const socket = session.socket("/ws", []);
    // 构造一段超过单帧 160 KB 上限且低压缩率的随机 Base64 文本（约 220 KB），同时验证 ws-gzip 与分片 more 重组。
    const randomPart = Buffer.from(crypto.getRandomValues(new Uint8Array(135_000))).toString("base64");
    const bigSnapshot = JSON.stringify({ method: "orchestration.snapshot", threads: [randomPart, "重复文本".repeat(8_000)] });
    let reply = "";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ws big message timeout")), 3_000);
      socket.addEventListener("open", () => {
        socket.send(bigSnapshot);
      });
      socket.addEventListener("message", ((event: { data: unknown }) => {
        reply = String(event.data);
        clearTimeout(timeout);
        socket.close(1000, "done");
        resolve();
      }) as (event: never) => void);
    });
    expect(reply).toBe(`ws:${bigSnapshot}`);
    expect(frames.length).toBeGreaterThan(2);
    expect(frames.every((frame) => frame.length <= TUNNEL_RELAY_FRAME_MAX)).toBe(true);
  });

  it("对端重启丢了会话：本端发帧后收到 reset 立即关闭会话，下次重新握手且请求恢复", async () => {
    const { host, client } = await setup();
    const session = await client.session(B);
    expect(await (await session.fetch("/a", { method: "GET", headers: [] })).text()).toBe("echo:GET:");

    host.closeAll(); // B 重启：会话表清空，不发 bye
    const started = Date.now();
    await expect(session.fetch("/b", { method: "GET", headers: [] })).rejects.toThrow("隧道已关闭");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(session.closed).toBe(true);

    const fresh = await client.session(B);
    expect(fresh).not.toBe(session);
    expect(await (await fresh.fetch("/c", { method: "GET", headers: [] })).text()).toBe("echo:GET:");
  });

  it("对端一帧都不回（旧版本不会回 reset）：请求超时后关闭会话，下次重新握手", async () => {
    const { client } = await setup({ silentHost: true, headTimeoutMs: 100 });
    const session = await client.session(B);
    await expect(session.fetch("/x", { method: "GET", headers: [] })).rejects.toThrow("对端 T3 响应超时");
    expect(session.closed).toBe(true);
    const fresh = await client.session(B);
    expect(fresh).not.toBe(session);
  });

  it("对端只是慢（超时期间收到过帧）：请求超时但会话保留", async () => {
    const { client } = await setup({ headTimeoutMs: 100 });
    const session = await client.session(B);
    // 一条慢请求与一条快请求并发：快请求的响应帧证明对端还认这条会话。
    const slow = session.fetch("/slow", { method: "GET", headers: [] }).catch((error: Error) => error.message);
    expect(await (await session.fetch("/fast", { method: "GET", headers: [] })).text()).toBe("echo:GET:");
    expect(await slow).toBe("对端 T3 响应超时");
    expect(session.closed).toBe(false);
    expect(await client.session(B)).toBe(session);
  });

  it("peers.json 损坏当作没记录", async () => {
    dir = await mkdtemp(join(tmpdir(), "ub-pins-"));
    await Bun.$`mkdir -p ${join(dir, "dispatch")}`;
    await writeFile(join(dir, "dispatch", "peers.json"), "not json");
    expect(await new PeerPins(dir).resolve("d", "k1")).toBe("k1");
    expect(await new PeerPins(dir).resolve("d", undefined)).toBe("k1");
  });
});
