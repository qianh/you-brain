import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";

import { T3_INJECT_PATH } from "../../src/deck/t3/inject.js";
import { forwardHeaders, injectT3Html, preferredProxyPort, responseHeaders, startT3Proxy, stripFrameAncestors, type T3Proxy } from "../../src/deck/t3/proxy.js";

describe("T3 转发的纯函数", () => {
  it("优先端口 = T3 端口 + 10000，超出范围时随机", () => {
    expect(preferredProxyPort("http://127.0.0.1:3773/")).toBe(13773);
    expect(preferredProxyPort("http://127.0.0.1:60000/")).toBe(0);
  });

  it("脚本插在 </head> 前；没有 head 时插在最前", () => {
    expect(injectT3Html("<html><head><title>T3</title></head><body></body></html>")).toBe(
      `<html><head><title>T3</title><script src="${T3_INJECT_PATH}"></script></head><body></body></html>`,
    );
    expect(injectT3Html("<p>x</p>")).toBe(`<script src="${T3_INJECT_PATH}"></script><p>x</p>`);
  });

  it("请求头：Origin/Referer 换回 T3 地址，去掉 Host 与压缩协商，Cookie 原样带上", () => {
    const out = forwardHeaders(
      new Headers({
        origin: "http://127.0.0.1:13773",
        referer: "http://127.0.0.1:13773/thread/a",
        host: "127.0.0.1:13773",
        "accept-encoding": "gzip",
        cookie: "t3_session_x=abc",
      }),
      "http://127.0.0.1:13773",
      "http://127.0.0.1:3773",
    );
    expect(out.get("origin")).toBe("http://127.0.0.1:3773");
    expect(out.get("referer")).toBe("http://127.0.0.1:3773/thread/a");
    expect(out.get("host")).toBeNull();
    expect(out.get("accept-encoding")).toBeNull();
    expect(out.get("cookie")).toBe("t3_session_x=abc");
  });

  it("响应头：跳转到 T3 的地址换成转发地址，多条 Set-Cookie 都保留，去掉 Content-Encoding", () => {
    const source = new Headers({ location: "http://127.0.0.1:3773/login", "content-encoding": "gzip" });
    source.append("set-cookie", "a=1; Path=/");
    source.append("set-cookie", "b=2; Path=/");
    const out = responseHeaders(source, "http://127.0.0.1:13773", "http://127.0.0.1:3773");
    expect(out.get("location")).toBe("http://127.0.0.1:13773/login");
    expect(out.get("content-encoding")).toBeNull();
    expect(out.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});

describe("防嵌入头", () => {
  it("响应头：去掉 X-Frame-Options 和 CSP 里的 frame-ancestors，其他指令保留", () => {
    const source = new Headers({
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    const out = responseHeaders(source, "http://127.0.0.1:13773", "http://127.0.0.1:3773");
    expect(out.get("x-frame-options")).toBeNull();
    expect(out.get("content-security-policy")).toBe("default-src 'none'; base-uri 'none'");
  });

  it("CSP 只剩 frame-ancestors 时整条去掉", () => {
    expect(stripFrameAncestors("frame-ancestors 'none'")).toBeNull();
    const out = responseHeaders(new Headers({ "content-security-policy": "frame-ancestors 'none'" }), "http://a", "http://b");
    expect(out.get("content-security-policy")).toBeNull();
  });
});

describe("startT3Proxy（假的 T3 上游）", () => {
  let upstream: Server<{ cookie: string }> | null = null;
  let proxy: T3Proxy | null = null;
  afterEach(() => {
    proxy?.stop();
    upstream?.stop(true);
    proxy = null;
    upstream = null;
  });

  function startUpstream(): Server<{ cookie: string }> {
    return Bun.serve<{ cookie: string }, never>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url);
        const cookie = request.headers.get("cookie") ?? "";
        if (url.pathname === "/ws") {
          // 和真 T3 一样：没登录不给升级。
          if (!cookie.includes("t3_session=ok")) return new Response("unauthorized", { status: 401 });
          return server.upgrade(request, { data: { cookie } }) ? undefined : new Response("bad", { status: 400 });
        }
        if (url.pathname === "/") {
          return new Response("<!doctype html><html><head><title>T3 Code</title></head><body></body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/api/echo") {
          return Response.json({
            method: request.method,
            cookie,
            origin: request.headers.get("origin"),
          });
        }
        return new Response("nf", { status: 404 });
      },
      websocket: {
        message(socket, message) {
          socket.send(`echo:${String(message)}`);
        },
      },
    });
  }

  it("首页插入脚本、脚本可取到、接口带前缀 Cookie 去前缀后转发", async () => {
    upstream = startUpstream();
    proxy = startT3Proxy(`http://127.0.0.1:${upstream.port}/`);
    const html = await (await fetch(proxy.url)).text();
    expect(html).toContain(`<script src="${T3_INJECT_PATH}"></script></head>`);
    const script = await fetch(new URL(T3_INJECT_PATH, proxy.url));
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).toContain("u-brain:t3-ref:open");

    const proxyOrigin = proxy.url.slice(0, -1);
    const echo = (await (
      await fetch(new URL("/api/echo", proxy.url), {
        method: "POST",
        body: "{}",
        headers: { cookie: `ub${upstream.port}_t3_session=ok`, origin: proxyOrigin },
      })
    ).json()) as { method: string; cookie: string; origin: string };
    expect(echo).toEqual({ method: "POST", cookie: "t3_session=ok", origin: `http://127.0.0.1:${upstream.port}` });
  });

  it("WebSocket：带上 Cookie 升级，消息双向转发", async () => {
    upstream = startUpstream();
    proxy = startT3Proxy(`http://127.0.0.1:${upstream.port}/`);
    const socket = new WebSocket(`${proxy.url.replace("http", "ws")}ws`, { headers: { cookie: `ub${upstream.port}_t3_session=ok` } } as unknown as string[]);
    const reply = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send("hi");
      socket.onmessage = (event) => resolve(String(event.data));
      socket.onclose = (event) => reject(new Error(`closed ${event.code}`));
      setTimeout(() => reject(new Error("timeout")), 3_000);
    });
    socket.close();
    expect(reply).toBe("echo:hi");
  });

  it("WebSocket：没登录时上游拒绝，转发这边也关掉", async () => {
    upstream = startUpstream();
    proxy = startT3Proxy(`http://127.0.0.1:${upstream.port}/`);
    const socket = new WebSocket(`${proxy.url.replace("http", "ws")}ws`);
    const code = await new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
      setTimeout(() => resolve(-1), 3_000);
    });
    expect(code).not.toBe(-1);
  });

  it("自动配对：没登录的页面导航换到登录 Cookie 写回浏览器；已登录、接口请求、失败后限频都不再配", async () => {
    const credentials: string[] = [];
    let sessions = 0;
    upstream = Bun.serve<{ cookie: string }, never>({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const cookie = request.headers.get("cookie") ?? "";
        if (url.pathname === "/api/auth/session") {
          sessions += 1;
          return Response.json({ authenticated: cookie.includes("t3_session=ok") });
        }
        if (url.pathname === "/api/auth/browser-session") {
          const body = (await request.json()) as { credential?: string };
          credentials.push(body.credential ?? "");
          if (body.credential !== "once") return new Response("no", { status: 401 });
          return new Response("{}", { headers: { "set-cookie": "t3_session=ok; Path=/; HttpOnly; SameSite=Lax" } });
        }
        return new Response("<!doctype html><html><head></head><body></body></html>", { headers: { "content-type": "text/html" } });
      },
    });
    let next: string | null = "once";
    let minted = 0;
    proxy = startT3Proxy(`http://127.0.0.1:${upstream.port}/`, {
      pairCredential: async () => {
        minted += 1;
        return next;
      },
    });
    const navigate = (cookie?: string) =>
      fetch(proxy!.url, { headers: { "sec-fetch-dest": "iframe", ...(cookie ? { cookie } : {}) } });

    const first = await navigate();
    expect(first.headers.getSetCookie()).toEqual([`ub${upstream.port}_t3_session=ok; Path=/; HttpOnly; SameSite=Lax`]);
    expect(credentials).toEqual(["once"]);

    const logged = await navigate(`ub${upstream.port}_t3_session=ok`);
    expect(logged.headers.getSetCookie()).toEqual([]);
    expect(minted).toBe(1);

    await fetch(new URL("/api/echo", proxy.url), { headers: { "sec-fetch-dest": "empty" } });
    expect(minted).toBe(1);

    next = "bad";
    expect((await navigate()).headers.getSetCookie()).toEqual([]);
    expect(minted).toBe(2);
    next = "once";
    expect((await navigate()).headers.getSetCookie()).toEqual([]);
    expect(minted).toBe(2);
    expect(sessions).toBeGreaterThanOrEqual(3);
  });
});
