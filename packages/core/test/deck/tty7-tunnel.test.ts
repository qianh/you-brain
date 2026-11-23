import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";

import { generateKeyPair, signTunnelTranscript, type CmdFrame } from "@you-brain/protocol";

import {
  createTty7TunnelHostHandler,
  openRemoteTty7Terminal,
  remoteTty7Json,
  remoteTty7PasteImage,
  type Tty7HostPort,
} from "../../src/deck/tty7-tunnel.js";
import type { TerminalSize, Tty7TerminalEvents } from "../../src/deck/tty7-terminal.js";
import { PeerPins, TUNNEL_TTY7_HEADER, TunnelClient, TunnelHost } from "../../src/dispatch/tunnel.js";
import type { DeckTty7SessionsResponse } from "../../src/http/types.js";

const A = "device-a";
const B = "device-b";
const SIZE: TerminalSize = { cols: 100, rows: 30, cell_w: 9, cell_h: 18 };

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("test timed out");
    await Bun.sleep(5);
  }
}

describe("跨设备 tty7 隧道（HTTP 白名单 + 实时终端 + 旧版本兼容）", () => {
  let t3: Server<undefined> | null = null;
  let dir = "";

  afterEach(async () => {
    t3?.stop(true);
    t3 = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  async function setup(options: { legacyHost?: boolean; syncError?: string } = {}) {
    dir = await mkdtemp(join(tmpdir(), "ub-tty7-tunnel-"));
    t3 = Bun.serve<undefined, never>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        return new Response(`t3:${url.pathname}`, { status: 200 });
      },
    });

    const calls: Array<{ op: string; args: unknown }> = [];
    const terminalInputs: Buffer[] = [];
    const terminalSizes: TerminalSize[] = [];
    const flow = { pauses: 0, resumes: 0, closes: 0 };
    let hostEvents: Tty7TerminalEvents | null = null;

    const port: Tty7HostPort = {
      async tty7Sessions() {
        calls.push({ op: "sessions", args: null });
        return {
          available: true,
          detail: "",
          sessions: [
            {
              pane: 3,
              workspaceId: "ws-1",
              workspaceName: "main",
              tabId: "tab-1",
              tabLabel: "远端会话",
              tabNamed: false,
              cwd: "/srv/app",
              agent: "claude",
              status: "working",
              statusMessage: null,
              model: null,
              task: "修复部署",
              hibernated: false,
            },
          ],
          workspaces: [{ id: "ws-1", name: "main", attached: true }],
          harnesses: [{ id: "claude", label: "Claude Code" }],
          appearance: { fontFamily: "Menlo", fontSize: 13, lineHeight: 1.2 },
        };
      },
      async tty7Delete(pane) {
        calls.push({ op: "delete", args: pane });
        return { ok: true };
      },
      async tty7Rename(body) {
        calls.push({ op: "rename", args: body });
        return { ok: true };
      },
      async tty7Viewing(body) {
        calls.push({ op: "viewing", args: body });
        return { ok: true };
      },
      async tty7Screen(pane, lines) {
        calls.push({ op: "screen", args: { pane, lines } });
        return { pane, text: "screen-output" };
      },
      async tty7Send(body) {
        calls.push({ op: "send", args: body });
        return { ok: true };
      },
      async tty7Start(body) {
        calls.push({ op: "start", args: body });
        return { pane: 9, workspaceId: "ws-1", tabId: "tab-9" };
      },
      async tty7PasteImage(data, contentType) {
        calls.push({ op: "pasteImage", args: { size: data.byteLength, contentType } });
        return { path: "/tmp/remote-img.png" };
      },
      tty7Terminal(pane, size, events) {
        calls.push({ op: "terminal", args: { pane, size } });
        terminalSizes.push(size);
        hostEvents = events;
        if (options.syncError) {
          events.error(options.syncError);
          events.close();
          return {
            input() {},
            resize() {},
            close() { flow.closes++; },
            pause() { flow.pauses++; },
            resume() { flow.resumes++; },
          };
        }
        queueMicrotask(() => {
          events.ready();
          events.size(size);
          events.output(Buffer.from("\x1b[?1049h远端回放"));
          events.live();
        });
        return {
          input(bytes) {
            terminalInputs.push(Buffer.from(bytes));
            events.output(bytes);
          },
          resize(next) {
            terminalSizes.push(next);
            events.size(next);
          },
          close() {
            flow.closes++;
          },
          pause() {
            flow.pauses++;
          },
          resume() {
            flow.resumes++;
          },
        };
      },
    };

    const bKey = generateKeyPair();
    const sender = { deviceId: A, name: "A", publicKey: "unused" };
    let host!: TunnelHost;
    let client!: TunnelClient;
    host = new TunnelHost({
      deviceId: B,
      authorize: async () => ({ ok: true, sender }),
      signTranscript: async (transcript) => signTunnelTranscript(bKey.privateKey, transcript),
      localUrl: async () => `http://127.0.0.1:${t3!.port}/`,
      pairCredential: async () => null,
      ...(options.legacyHost ? {} : { tty7: createTty7TunnelHostHandler(() => port) }),
      send: async (_to, sid, data) => {
        queueMicrotask(() => client.onFrame(B, sid, data));
      },
    });
    client = new TunnelClient({
      deviceId: A,
      dispatch: async (to, kind, args) => {
        const frame = { t: "cmd", cmdId: "c", from: A, to, cmd: { kind, args }, ts: 0, nonce: "n", sig: "s" } as CmdFrame;
        return host.open(frame);
      },
      send: async (_to, sid, data) => {
        queueMicrotask(() => host.onFrame(A, sid, data));
      },
      peerKey: () => bKey.publicKey,
      pins: new PeerPins(dir),
    });
    return { client, host, calls, terminalInputs, terminalSizes, flow, hostEvents: () => hostEvents };
  }

  it("所有 tty7 HTTP 接口按白名单路由并附带标识头；非白名单路径一律返回 404", async () => {
    const { client, calls } = await setup();
    const getSession = () => client.session(B);

    const sessions = await remoteTty7Json<DeckTty7SessionsResponse>(getSession, "GET", "/api/deck/tty7/sessions");
    expect(sessions.available).toBe(true);
    expect(sessions.sessions[0]?.tabLabel).toBe("远端会话");

    expect(await remoteTty7Json(getSession, "POST", "/api/deck/tty7/start", { cwd: "/srv/app", harness: "claude" })).toEqual({ pane: 9, workspaceId: "ws-1", tabId: "tab-9" });
    expect(await remoteTty7Json(getSession, "POST", "/api/deck/tty7/rename", { pane: 3, name: "新名字" })).toEqual({ ok: true });
    expect(await remoteTty7Json(getSession, "POST", "/api/deck/tty7/viewing", { pane: 3 })).toEqual({ ok: true });
    expect(await remoteTty7Json(getSession, "GET", "/api/deck/tty7/screen?pane=3&lines=50")).toEqual({ pane: 3, text: "screen-output" });
    expect(await remoteTty7Json(getSession, "POST", "/api/deck/tty7/send", { pane: 3, text: "ls", enter: true })).toEqual({ ok: true });
    expect(await remoteTty7Json(getSession, "POST", "/api/deck/tty7/delete", { pane: 3 })).toEqual({ ok: true });

    const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await remoteTty7PasteImage(getSession, img, "image/png")).toEqual({ path: "/tmp/remote-img.png" });

    expect(calls.map((c) => c.op)).toEqual([
      "sessions", "start", "rename", "viewing", "screen", "send", "delete", "pasteImage",
    ]);

    const session = await getSession();
    // 尝试访问非 tty7 路径必须被目标端严格拦截，且不能转发到 T3。
    const blocked = await session.fetch("/api/status", { method: "GET", headers: [], target: "tty7" });
    expect(blocked.status).toBe(404);
    expect(blocked.headers.get(TUNNEL_TTY7_HEADER)).toBe("1");

    // 同一隧道上的 T3 HTTP 请求完全不受影响。
    const t3Resp = await session.fetch("/api/t3-ping", { method: "GET", headers: [] });
    expect(await t3Resp.text()).toBe("t3:/api/t3-ping");
  });

  it("未提供 tty7 或旧版本对端不破坏 T3，并返回清晰提示", async () => {
    const { client } = await setup({ legacyHost: true });
    const getSession = () => client.session(B);
    const session = await getSession();

    const t3Resp = await session.fetch("/hello", { method: "GET", headers: [] });
    expect(await t3Resp.text()).toBe("t3:/hello");

    await expect(remoteTty7Json(getSession, "GET", "/api/deck/tty7/sessions")).rejects.toThrow("对端没有提供终端会话服务");
    await expect(remoteTty7PasteImage(getSession, new Uint8Array([1, 2, 3]), "image/png")).rejects.toThrow("对端没有提供终端会话服务");

    // 模拟真正旧版本对端：忽略 target="tty7"，把请求直接转给了对端 T3（响应缺少 x-ubrain-tty7 头）。
    const oldPeerSession = {
      fetch: async () => new Response("<!doctype html><title>T3</title>", { status: 200, headers: { "content-type": "text/html" } }),
    } as unknown as Awaited<ReturnType<typeof getSession>>;
    await expect(remoteTty7Json(async () => oldPeerSession, "GET", "/api/deck/tty7/sessions")).rejects.toThrow("对端设备版本较旧");
    await expect(remoteTty7PasteImage(async () => oldPeerSession, new Uint8Array([1, 2, 3]), "image/png")).rejects.toThrow("对端设备版本较旧");

    const errors: string[] = [];
    let closed = false;
    openRemoteTty7Terminal(getSession, 1, SIZE, {
      ready() {},
      live() {},
      output() {},
      size() {},
      warning() {},
      lease() {},
      exit() {},
      error(msg) { errors.push(msg); },
      close() { closed = true; },
    });
    await until(() => closed);
    expect(errors.some((e) => e.includes("对端没有提供实时终端服务"))).toBe(true);
  });

  it("实时终端支持双向原始字节、>48KB 大分块、resize、流控与控制事件", async () => {
    const { client, terminalInputs, terminalSizes, flow, hostEvents } = await setup();
    const getSession = () => client.session(B);

    const received: Buffer[] = [];
    const events: string[] = [];
    let closed = false;
    const conn = openRemoteTty7Terminal(getSession, 3, SIZE, {
      ready() { events.push("ready"); },
      live() { events.push("live"); },
      output(bytes) { received.push(Buffer.from(bytes)); },
      size(next) { events.push(`size:${next.cols}x${next.rows}`); },
      warning(msg) { events.push(`warn:${msg}`); },
      lease(by) { events.push(`lease:${String(by)}`); },
      exit() { events.push("exit"); },
      error(msg) { events.push(`error:${msg}`); },
      close() { closed = true; },
    });

    await until(() => events.includes("live"));
    expect(events).toContain("ready");
    expect(events).toContain("size:100x30");
    expect(Buffer.concat(received).toString("utf8")).toBe("\x1b[?1049h远端回放");

    // 发送包含控制字节和 >48KB 的大数据块，确认两端自动分块并保序到达。
    received.length = 0;
    const largeInput = new Uint8Array(110_000);
    for (let i = 0; i < largeInput.length; i++) largeInput[i] = i & 0xff;
    conn.input(largeInput);
    conn.resize({ ...SIZE, cols: 132, rows: 42 });
    conn.pause();
    conn.resume();

    await until(() => Buffer.concat(received).length === largeInput.length && events.includes("size:132x42"));
    expect(Buffer.concat(terminalInputs)).toEqual(Buffer.from(largeInput));
    expect(Buffer.concat(received)).toEqual(Buffer.from(largeInput));
    expect(terminalSizes.at(-1)).toEqual({ ...SIZE, cols: 132, rows: 42 });
    await until(() => flow.pauses >= 1 && flow.resumes >= 1);

    hostEvents()!.warning("注意");
    hostEvents()!.lease("tty7");
    hostEvents()!.exit(0);
    await until(() => events.includes("exit"));
    expect(events).toContain("warn:注意");
    expect(events).toContain("lease:tty7");

    conn.close();
    await until(() => flow.closes >= 1);
    expect(closed).toBe(true);
  });

  it("目标端同步报错后立刻关闭时，错误帧仍先于关闭送达发起端", async () => {
    const { client } = await setup({ syncError: "pane 不存在" });
    const getSession = () => client.session(B);

    const events: string[] = [];
    let closed = false;
    openRemoteTty7Terminal(getSession, 99, SIZE, {
      ready() { events.push("ready"); },
      live() {},
      output() {},
      size() {},
      warning() {},
      lease() {},
      exit() {},
      error(msg) { events.push(`error:${msg}`); },
      close() { closed = true; },
    });
    await until(() => closed);
    expect(events).toEqual(["error:pane 不存在"]);
  });
});
