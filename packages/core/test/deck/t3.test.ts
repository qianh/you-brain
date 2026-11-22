import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

import { DeckService } from "../../src/deck/service.js";
import { T3Automation, T3AutomationError } from "../../src/deck/t3/automation.js";
import { DEFAULT_T3_URL, normalizeT3Url } from "../../src/deck/t3/index.js";
import { fakeT3, fakeThread, type FakeProject } from "./t3-mcp-fake.js";
import {
  forwardHeaders,
  prefixSetCookie,
  responseHeaders,
  startT3Proxy,
  stripCookiePrefix,
  t3CookiePrefix,
  type T3Proxy,
} from "../../src/deck/t3/proxy.js";

describe("T3 local server addresses", () => {
  test("normalizes local root addresses", () => {
    expect(normalizeT3Url(" http://127.0.0.1:3773 ")).toBe(DEFAULT_T3_URL);
    expect(normalizeT3Url("http://localhost:3773/")).toBe("http://localhost:3773/");
    expect(normalizeT3Url("https://[::1]:3773")).toBe("https://[::1]:3773/");
  });

  test("rejects remote, non-HTTP, credential and session URLs", () => {
    for (const input of [
      "", "not-a-url", "//localhost:3773", "javascript:alert(1)", "file:///Applications/T3.app",
      "https://example.com/", "http://127.0.0.1.example.com/", "http://192.168.0.1:3773/",
      "http://localhost@evil.test/", "http://user:password@127.0.0.1:3773/",
      "http://localhost:3773/?token=synthetic-pairing-token", "http://localhost:3773/#thread",
      "http://localhost:3773/thread/123", "http://localhost:0/",
    ]) expect(normalizeT3Url(input)).toBeNull();
  });
});

describe("T3 Cookie 隔离纯函数", () => {
  test("t3CookiePrefix 按上游端口生成固定前缀", () => {
    expect(t3CookiePrefix("http://127.0.0.1:3773/")).toBe("ub3773_");
    expect(t3CookiePrefix("http://127.0.0.1/")).toBe("ub80_");
    expect(t3CookiePrefix("https://127.0.0.1/")).toBe("ub443_");
  });

  test("prefixSetCookie：名称加前缀、保留值里的等号与 Path 等属性、大小写不敏感去掉 Domain", () => {
    expect(prefixSetCookie("sid=abc==; Path=/; HttpOnly; SameSite=Lax", "ub3773_"))
      .toBe("ub3773_sid=abc==; Path=/; HttpOnly; SameSite=Lax");
    expect(prefixSetCookie("tok=a=b=c; Domain=127.0.0.1; Path=/api; Secure", "ub3774_"))
      .toBe("ub3774_tok=a=b=c; Path=/api; Secure");
    expect(prefixSetCookie("tok=1; DOMAIN=localhost; domain=.example.com; path=/", "ub3774_"))
      .toBe("ub3774_tok=1; path=/");
    expect(prefixSetCookie("empty=; Max-Age=0", "ub3773_"))
      .toBe("ub3773_empty=; Max-Age=0");
    expect(prefixSetCookie("plain=val", "ub3773_"))
      .toBe("ub3773_plain=val");
  });

  test("prefixSetCookie：丢弃 __Host- / __Secure- 前缀名以及畸形 Set-Cookie", () => {
    expect(prefixSetCookie("__Host-sid=1; Path=/; Secure", "ub3773_")).toBeNull();
    expect(prefixSetCookie("__Secure-sid=1; Path=/; Secure", "ub3773_")).toBeNull();
    expect(prefixSetCookie("__host-sid=1; Path=/", "ub3773_")).toBeNull();
    expect(prefixSetCookie("__SECURE-sid=1; Path=/", "ub3773_")).toBeNull();
    expect(prefixSetCookie("malformed-no-equals", "ub3773_")).toBeNull();
    expect(prefixSetCookie("=noname; Path=/", "ub3773_")).toBeNull();
  });

  test("stripCookiePrefix：仅保留匹配前缀并去前缀，支持多个 Cookie 与含等号的值，丢弃其他项", () => {
    expect(stripCookiePrefix("ub3773_sid=abc==; ub3774_sid=other; legacy=1; ub3773_k=x=y", "ub3773_"))
      .toBe("sid=abc==; k=x=y");
    expect(stripCookiePrefix("ub3774_sid=other; legacy=1", "ub3773_")).toBe("");
    expect(stripCookiePrefix("ub3773_=noval; ub3773_ok=", "ub3773_")).toBe("ok=");
    expect(stripCookiePrefix("", "ub3773_")).toBe("");
  });

  test("forwardHeaders / responseHeaders 带前缀时隔离 Cookie，不带前缀时保持向后兼容", () => {
    const reqHeaders = new Headers({
      cookie: "ub3773_sid=a=b; ub3774_sid=other; raw=1",
      origin: "http://127.0.0.1:13773",
    });
    const isolatedReq = forwardHeaders(reqHeaders, "http://127.0.0.1:13773", "http://127.0.0.1:3773", undefined, "ub3773_");
    expect(isolatedReq.get("cookie")).toBe("sid=a=b");
    const droppedReq = forwardHeaders(
      new Headers({ cookie: "ub3774_sid=other; raw=1" }),
      "http://127.0.0.1:13773",
      "http://127.0.0.1:3773",
      undefined,
      "ub3773_",
    );
    expect(droppedReq.get("cookie")).toBeNull();

    const resHeaders = new Headers();
    resHeaders.append("set-cookie", "sid=a=b; Domain=127.0.0.1; Path=/");
    resHeaders.append("set-cookie", "__Host-secret=1; Path=/; Secure");
    const isolatedRes = responseHeaders(resHeaders, "http://127.0.0.1:13773", "http://127.0.0.1:3773", "ub3773_");
    expect(isolatedRes.getSetCookie()).toEqual(["ub3773_sid=a=b; Path=/"]);
  });
});

describe("startT3Proxy Cookie 隔离集成测试", () => {
  const servers: Array<Server<unknown>> = [];
  const proxies: T3Proxy[] = [];

  afterEach(() => {
    for (const proxy of proxies.splice(0)) proxy.stop();
    for (const server of servers.splice(0)) server.stop(true);
  });

  function fakeUpstream(tag: string): Server<{ cookie: string }> {
    const server = Bun.serve<{ cookie: string }, never>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, srv) {
        const url = new URL(request.url);
        const cookie = request.headers.get("cookie") ?? "";
        if (url.pathname === "/login") {
          const headers = new Headers({ "content-type": "text/plain" });
          headers.append("set-cookie", `t3_session=${tag}==; Domain=127.0.0.1; Path=/; HttpOnly`);
          headers.append("set-cookie", "__Host-skip=nope; Path=/; Secure");
          return new Response("ok", { headers });
        }
        if (url.pathname === "/whoami") {
          return Response.json({ tag, cookie });
        }
        if (url.pathname === "/ws") {
          if (cookie !== `t3_session=${tag}==`) return new Response("unauthorized", { status: 401 });
          return srv.upgrade(request, { data: { cookie } }) ? undefined : new Response("bad", { status: 400 });
        }
        return new Response("nf", { status: 404 });
      },
      websocket: {
        message(socket, message) {
          socket.send(`${tag}:${socket.data.cookie}:${String(message)}`);
        },
      },
    });
    servers.push(server);
    return server;
  }

  test("单转发：Set-Cookie 加前缀去 Domain，HTTP 与 WebSocket 请求只转发本端点去前缀 Cookie", async () => {
    const upstream = fakeUpstream("alpha");
    const proxy = startT3Proxy(`http://127.0.0.1:${upstream.port}/`);
    proxies.push(proxy);
    const prefix = t3CookiePrefix(`http://127.0.0.1:${upstream.port}/`);

    const loginRes = await fetch(new URL("/login", proxy.url));
    expect(loginRes.headers.getSetCookie()).toEqual([`${prefix}t3_session=alpha==; Path=/; HttpOnly`]);

    const who = (await (
      await fetch(new URL("/whoami", proxy.url), {
        headers: { cookie: `${prefix}t3_session=alpha==; ub9999_t3_session=other; t3_session=unprefixed` },
      })
    ).json()) as { tag: string; cookie: string };
    expect(who).toEqual({ tag: "alpha", cookie: "t3_session=alpha==" });

    const ws = new WebSocket(`${proxy.url.replace("http", "ws")}ws`, {
      headers: { cookie: `${prefix}t3_session=alpha==; ub9999_t3_session=other` },
    } as unknown as string[]);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send("ping");
      ws.onmessage = (event) => resolve(String(event.data));
      ws.onclose = (event) => reject(new Error(`closed ${event.code}`));
      setTimeout(() => reject(new Error("timeout")), 3_000);
    });
    ws.close();
    expect(reply).toBe("alpha:t3_session=alpha==:ping");
  });

  test("双转发：同一浏览器 Cookie 池里共存两个端点 Cookie，互不串台", async () => {
    const upstreamA = fakeUpstream("A");
    const upstreamB = fakeUpstream("B");
    const proxyA = startT3Proxy(`http://127.0.0.1:${upstreamA.port}/`);
    const proxyB = startT3Proxy(`http://127.0.0.1:${upstreamB.port}/`);
    proxies.push(proxyA, proxyB);

    const setA = (await fetch(new URL("/login", proxyA.url))).headers.getSetCookie()[0]!;
    const setB = (await fetch(new URL("/login", proxyB.url))).headers.getSetCookie()[0]!;
    const pairA = setA.split(";")[0]!;
    const pairB = setB.split(";")[0]!;
    expect(pairA).not.toBe(pairB);

    // 模拟浏览器在 127.0.0.1 上同时带着两个端点写下的 Cookie 以及一个无前缀旧 Cookie。
    const sharedJar = `${pairA}; ${pairB}; t3_session=stale`;
    const whoA = (await (await fetch(new URL("/whoami", proxyA.url), { headers: { cookie: sharedJar } })).json()) as { tag: string; cookie: string };
    const whoB = (await (await fetch(new URL("/whoami", proxyB.url), { headers: { cookie: sharedJar } })).json()) as { tag: string; cookie: string };
    expect(whoA).toEqual({ tag: "A", cookie: "t3_session=A==" });
    expect(whoB).toEqual({ tag: "B", cookie: "t3_session=B==" });
  });
});

describe("DeckService.t3Frame 多转发池", () => {
  const dirs: string[] = [];
  const services: DeckService[] = [];
  const upstreams: Array<Server<unknown>> = [];

  afterEach(async () => {
    for (const service of services.splice(0)) service.stop();
    for (const server of upstreams.splice(0)) server.stop(true);
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function makeService(): Promise<DeckService> {
    const dir = await mkdtemp(join(tmpdir(), "deck-t3-multi-"));
    dirs.push(dir);
    const service = new DeckService({ dataDir: dir, homeDir: dir, warmDsh: false });
    services.push(service);
    return service;
  }

  function makeUpstream(label: string): string {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(label),
    });
    upstreams.push(server);
    return `http://127.0.0.1:${server.port}/`;
  }

  async function isReachable(url: string): Promise<string | null> {
    try {
      const res = await fetch(url);
      return await res.text();
    } catch {
      return null;
    }
  }

  test("同一 upstream 复用，不同 upstream 共存，t3Retain 清理多余转发，stop 全部停止", async () => {
    const service = await makeService();
    const u1 = makeUpstream("one");
    const u2 = makeUpstream("two");

    const f1a = service.t3Frame(u1);
    const f1b = service.t3Frame(u1);
    const f2 = service.t3Frame(u2);
    expect(f1a).not.toBeNull();
    expect(f1b).toBe(f1a);
    expect(f2).not.toBeNull();
    expect(f2).not.toBe(f1a);

    expect(await isReachable(f1a!)).toBe("one");
    expect(await isReachable(f2!)).toBe("two");

    // 只保留 u2，u1 的转发应被停掉。
    service.t3Retain([u2]);
    expect(await isReachable(f1a!)).toBeNull();
    expect(await isReachable(f2!)).toBe("two");

    // stop 后全部停止，再请求返回 null。
    service.stop();
    expect(await isReachable(f2!)).toBeNull();
    expect(service.t3Frame(u1)).toBeNull();
  });

  test("超过 8 个转发时淘汰最久未使用的", async () => {
    const service = await makeService();
    const urls = Array.from({ length: 9 }, (_, index) => makeUpstream(`u${index}`));
    const frames: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const frame = service.t3Frame(urls[index]!);
      expect(frame).not.toBeNull();
      frames.push(frame!);
    }

    // 再次访问第 0 个，使第 1 个成为最久未使用的。
    expect(service.t3Frame(urls[0]!)).toBe(frames[0]!);

    // 第 9 个进入时应淘汰第 1 个，第 0 个和第 8 个都存活。
    const frame8 = service.t3Frame(urls[8]!);
    expect(frame8).not.toBeNull();
    expect(await isReachable(frames[1]!)).toBeNull();
    expect(await isReachable(frames[0]!)).toBe("u0");
    expect(await isReachable(frame8!)).toBe("u8");
  });
});

const dispatchBaseUrl = "http://127.0.0.1:3773/";
const dispatchSelection = { instanceId: "codex", model: "configured-model" };
const dispatchProject: FakeProject = { id: "project-1", title: "Project", workspaceRoot: "/repo", defaultModelSelection: null };

describe("T3 dispatch launchThread", () => {
  test("launches at the project root with the dispatch request id and the given runtime mode", async () => {
    const t3 = fakeT3({ projects: [{ ...dispatchProject, defaultModelSelection: dispatchSelection }] });
    const client = new T3Automation({ getUrl: async () => dispatchBaseUrl, getToken: async () => t3.token, fetch: t3.fetch });
    const started = await client.launchThread({
      projectId: dispatchProject.id, title: "Remote", prompt: "Do it remotely", requestId: "d-9", runtimeMode: "full-access",
    });
    expect(started).toEqual({
      threadId: "thread-u-brain-dispatch-d-9",
      threadUrl: `${dispatchBaseUrl}local-env/thread-u-brain-dispatch-d-9`,
    });
    const launches = t3.calls.filter((call) => call.name === "t3_thread_launch");
    expect(launches).toHaveLength(1);
    expect(launches[0]?.args).toMatchObject({
      projectId: dispatchProject.id,
      title: "Remote",
      message: "Do it remotely",
      modelSelection: dispatchSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      clientRequestId: "u-brain-dispatch-d-9",
    });
  });

  test("uses the latest project model and does not inherit that thread's runtime mode", async () => {
    const t3 = fakeT3({
      projects: [dispatchProject],
      threads: [fakeThread({ providerInstanceId: "claude", model: "opus", runtimeMode: "full-access" })],
    });
    const client = new T3Automation({ getUrl: async () => dispatchBaseUrl, getToken: async () => t3.token, fetch: t3.fetch });
    await client.launchThread({
      projectId: dispatchProject.id, title: "Remote", prompt: "Do it", requestId: "d-2", runtimeMode: "auto",
    });
    expect(t3.calls.find((call) => call.name === "t3_thread_launch")?.args).toMatchObject({
      modelSelection: { instanceId: "claude", model: "opus" },
      runtimeMode: "auto",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      clientRequestId: "u-brain-dispatch-d-2",
    });
  });

  test("rejects a missing project or a project that has no model", async () => {
    const missingT3 = fakeT3({ projects: [dispatchProject] });
    const missing = new T3Automation({ getUrl: async () => dispatchBaseUrl, getToken: async () => missingT3.token, fetch: missingT3.fetch });
    await expect(missing.launchThread({
      projectId: "gone", title: "Remote", prompt: "Do it", requestId: "d-3", runtimeMode: "auto",
    })).rejects.toMatchObject({ code: "INVALID_INPUT", message: "T3 中已找不到这个项目，请重新选择项目。" });

    const bareT3 = fakeT3({ projects: [dispatchProject] });
    const bare = new T3Automation({ getUrl: async () => dispatchBaseUrl, getToken: async () => bareT3.token, fetch: bareT3.fetch });
    const rejected = bare.launchThread({
      projectId: dispatchProject.id, title: "Remote", prompt: "Do it", requestId: "d-4", runtimeMode: "auto",
    });
    await expect(rejected).rejects.toBeInstanceOf(T3AutomationError);
    await expect(rejected).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "请先在 T3 中为这个项目选择模型或创建一次会话",
    });
  });
});
