import type { Server, ServerWebSocket } from "bun";

import { isImmutableT3AssetPath, type T3AssetCache } from "./asset-cache.js";
import { T3_INJECT_PATH, T3_INJECT_SCRIPT } from "./inject.js";

/**
 * T3 本机转发：指挥台的 T3 iframe 改为加载这里，daemon 原样转发 HTTP 与 WebSocket 到用户自己的 T3 服务，
 * 只在首页 HTML 里插入一段 U-Brain 脚本（多巴胺底色、输入框里的 @ 引用）。
 *
 * - 只监听 127.0.0.1；不读写 T3 的数据库，不保存、不打印 T3 的 Cookie 或令牌。
 * - 自动配对（可选）：浏览器导航到首页而 T3 还没登录时，转发向 `pairCredential` 要一次性凭据，
 *   立刻去 T3 换登录 Cookie 并直接写回浏览器（带前缀）；凭据与 Cookie 只在这一次请求里经手。
 * - 浏览器不按端口区分 Cookie，同一 127.0.0.1 上多个 T3 会互相覆盖同名登录 Cookie；
 *   每个转发用 `ub<上游端口>_` 前缀隔离各自 Cookie：响应 Set-Cookie 加前缀并去 Domain，
 *   请求 Cookie 只转发带本转发前缀的项并去前缀，其余丢弃。
 * - 端口优先用「T3 端口 + 10000」，让 T3 存在 localStorage 里的设置在 daemon 重启后还在；被占时随机。
 */
export interface T3Proxy {
  /** 转发服务根地址，形如 http://127.0.0.1:13773/。 */
  readonly url: string;
  readonly upstream: string;
  /** 后台拉取首页并预热不可变构建产物缓存（仅对走隧道且配置了 assetCache 的远端转发有效）。 */
  warm?(): void;
  stop(): void;
}

interface SocketData {
  target: string;
  headers: Record<string, string>;
  upstream: WebSocket | TransportSocket | null;
  pending: Array<string | ArrayBuffer | Uint8Array>;
}

/** 转发请求时不原样带过去的头：逐跳头、Host，以及让上游返回压缩体（Bun 的 fetch 会自动解压）。 */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "accept-encoding",
  "content-length",
]);
const WS_SKIP_HEADERS = new Set([
  ...HOP_HEADERS,
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
]);

export function preferredProxyPort(upstream: string): number {
  const port = Number(new URL(upstream).port || (upstream.startsWith("https:") ? 443 : 80));
  const preferred = port + 10_000;
  return preferred <= 65_535 ? preferred : 0;
}

/** 每个上游转发对应的 Cookie 隔离前缀：`ub<上游端口>_`。 */
export function t3CookiePrefix(upstream: string): string {
  const parsed = new URL(upstream);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `ub${port}_`;
}

/**
 * 为上游返回的 Set-Cookie 名称加上端点前缀，并去掉 Domain 属性（Path 与其余属性原样保留）。
 *
 * 注意：`__Host-` 与 `__Secure-` 依赖 Cookie 名前缀本身的浏览器语义，加上端点前缀后会破坏这些约束，
 * 因此对这类 Cookie 不加前缀也不转发，直接丢弃返回 null。
 */
export function prefixSetCookie(setCookie: string, prefix: string): string | null {
  const parts = setCookie.split(";");
  const first = parts[0];
  if (first === undefined) return null;
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  if (name === "") return null;
  if (/^__(?:host|secure)-/iu.test(name)) return null;
  const value = first.slice(eq + 1);
  const attrs: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index]?.trim() ?? "";
    if (part === "") continue;
    const attrEq = part.indexOf("=");
    const attrName = (attrEq === -1 ? part : part.slice(0, attrEq)).trim().toLowerCase();
    if (attrName === "domain") continue;
    attrs.push(part);
  }
  const head = `${prefix}${name}=${value}`;
  return attrs.length === 0 ? head : `${head}; ${attrs.join("; ")}`;
}

/**
 * 过滤请求 Cookie 头：只保留带本转发前缀的项并去掉前缀，其余（其他端点写入或无前缀旧 Cookie）一律丢弃。
 */
export function stripCookiePrefix(cookieHeader: string, prefix: string): string {
  const kept: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!name.startsWith(prefix)) continue;
    const rawName = name.slice(prefix.length);
    if (rawName === "") continue;
    const value = trimmed.slice(eq + 1);
    kept.push(`${rawName}=${value}`);
  }
  return kept.join("; ");
}

/** 在 HTML 的 </head> 前插入 U-Brain 脚本；没有 </head> 时插在最前。 */
export function injectT3Html(html: string): string {
  const tag = `<script src="${T3_INJECT_PATH}"></script>`;
  const index = html.search(/<\/head>/iu);
  return index === -1 ? `${tag}${html}` : `${html.slice(0, index)}${tag}${html.slice(index)}`;
}

/** 请求头：去掉逐跳头；Origin / Referer 里的转发地址换回 T3 地址，避免上游的同源校验把请求拒掉。 */
export function forwardHeaders(
  source: Headers,
  proxyOrigin: string,
  upstreamOrigin: string,
  skip = HOP_HEADERS,
  cookiePrefix?: string,
): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (skip.has(lower)) return;
    if (lower === "cookie" && cookiePrefix !== undefined) {
      const stripped = stripCookiePrefix(value, cookiePrefix);
      if (stripped !== "") {
        const existing = out.get(key);
        out.set(key, existing ? `${existing}; ${stripped}` : stripped);
      }
      return;
    }
    if ((lower === "origin" || lower === "referer") && value.startsWith(proxyOrigin)) {
      out.set(key, upstreamOrigin + value.slice(proxyOrigin.length));
      return;
    }
    out.append(key, value);
  });
  return out;
}

/** 去掉 CSP 里的 frame-ancestors 指令（T3 0.1.11 起写死 'none'），其余指令保留；剩不下指令时返回 null。 */
export function stripFrameAncestors(csp: string): string | null {
  const rest = csp.split(";").map((part) => part.trim()).filter((part) => part !== "" && !/^frame-ancestors(?:\s|$)/iu.test(part));
  return rest.length === 0 ? null : rest.join("; ");
}

/**
 * 响应头：去掉逐跳头和编码相关头（正文已解压、可能被改写）；跳转到 T3 本身的地址换回转发地址。
 * T3 0.1.11 起带 X-Frame-Options: DENY 与 frame-ancestors 'none'，转发要去掉，指挥台的 iframe 才能加载。
 */
export function responseHeaders(
  source: Headers,
  proxyOrigin: string,
  upstreamOrigin: string,
  cookiePrefix?: string,
): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower === "content-encoding" || lower === "set-cookie" || lower === "x-frame-options") return;
    if (lower === "content-security-policy") {
      const stripped = stripFrameAncestors(value);
      if (stripped !== null) out.append(key, stripped);
      return;
    }
    if (lower === "location" && value.startsWith(upstreamOrigin)) {
      out.set(key, proxyOrigin + value.slice(upstreamOrigin.length));
      return;
    }
    out.append(key, value);
  });
  for (const cookie of source.getSetCookie()) {
    if (cookiePrefix === undefined) {
      out.append("set-cookie", cookie);
    } else {
      const rewritten = prefixSetCookie(cookie, cookiePrefix);
      if (rewritten !== null) out.append("set-cookie", rewritten);
    }
  }
  return out;
}

/** 非本机 T3 的传输：请求经设备间隧道发到对端的 T3，而不是直连 `upstreamUrl`（那时它只是个虚拟源）。 */
export interface T3Transport {
  fetch(path: string, init: { method: string; headers: Array<[string, string]>; body?: Uint8Array }): Promise<Response>;
  openSocket(path: string, headers: Array<[string, string]>): Promise<TransportSocket>;
}

/** 转发用到的 WebSocket 最小接口（TunnelSocket 满足）。 */
export interface TransportSocket {
  readyState: number;
  binaryType: "arraybuffer" | "blob";
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: never) => void): void;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface T3ProxyOptions {
  /** 返回一次性配对凭据；该上游不能自动配对（不是本机 T3、CLI 不可用）时返回 null。 */
  pairCredential?: () => Promise<string | null>;
  /** 走隧道的上游（另一台设备的 T3）。 */
  transport?: T3Transport;
  /** 跨设备共享的不可变构建产物缓存（仅对走隧道的转发启用）。 */
  assetCache?: T3AssetCache;
  /** Cookie 隔离前缀；走隧道时必须给（按设备区分），缺省按上游端口。 */
  cookiePrefix?: string;
  /** 转发服务端口；缺省取「上游端口 + 10000」。 */
  port?: number;
}

/** 请求是不是浏览器打开页面（而不是接口、脚本、WebSocket）。 */
function isNavigation(request: Request): boolean {
  if (request.method !== "GET") return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null) return dest === "document" || dest === "iframe";
  return request.headers.get("accept")?.includes("text/html") === true;
}

/** 自动配对失败后多久内不再试，避免 T3 没起来或 CLI 不可用时每次导航都起子进程。 */
const PAIR_RETRY_MS = 30_000;

export function startT3Proxy(upstreamUrl: string, options: T3ProxyOptions = {}): T3Proxy {
  const upstream = new URL(upstreamUrl);
  const upstreamOrigin = upstream.origin;
  const wsOrigin = upstreamOrigin.replace(/^http/u, "ws");
  const cookiePrefix = options.cookiePrefix ?? t3CookiePrefix(upstreamUrl);
  const transport = options.transport;
  const assetCache = transport ? options.assetCache : undefined;
  let proxyOrigin = "";
  let pairFailedAt = 0;
  let warmed = false;

  /** 向上游发请求：本机 T3 直连，其他设备的 T3 走隧道。path 含查询串。 */
  async function upstreamFetch(path: string, init: { method: string; headers: Headers; body?: ArrayBuffer }): Promise<Response> {
    if (!transport) {
      return fetch(`${upstreamOrigin}${path}`, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
      });
    }
    return transport.fetch(path, {
      method: init.method,
      headers: [...init.headers.entries()],
      ...(init.body === undefined ? {} : { body: new Uint8Array(init.body) }),
    });
  }

  const prefetchAsset = (assetPath: string): Promise<Response> =>
    upstreamFetch(assetPath, { method: "GET", headers: new Headers() });

  /** 没登录时用一次性凭据换 T3 的登录 Cookie；返回要写回浏览器的 Set-Cookie（已加前缀），不需要或失败返回空数组。 */
  async function autoPair(request: Request): Promise<string[]> {
    const pairCredential = options.pairCredential;
    if (!pairCredential || Date.now() - pairFailedAt < PAIR_RETRY_MS) return [];
    const headers = forwardHeaders(request.headers, proxyOrigin, upstreamOrigin, HOP_HEADERS, cookiePrefix);
    try {
      const session = await upstreamFetch("/api/auth/session", { method: "GET", headers });
      if (!session.ok) throw new Error(`会话探测返回 ${session.status}`);
      if ((await session.json() as { authenticated?: unknown }).authenticated === true) return [];
      const credential = await pairCredential();
      if (credential === null) throw new Error("没有拿到配对凭据");
      const paired = await upstreamFetch("/api/auth/browser-session", {
        method: "POST",
        headers: new Headers({ "content-type": "application/json", origin: upstreamOrigin }),
        body: new TextEncoder().encode(JSON.stringify({ credential })).buffer as ArrayBuffer,
      });
      if (!paired.ok) throw new Error(`换取登录失败 ${paired.status}`);
      const cookies: string[] = [];
      for (const cookie of paired.headers.getSetCookie()) {
        const rewritten = prefixSetCookie(cookie, cookiePrefix);
        if (rewritten !== null) cookies.push(rewritten);
      }
      return cookies;
    } catch (error) {
      pairFailedAt = Date.now();
      // 只记原因，不含凭据与 Cookie。
      console.error(`[t3-proxy] 自动登录没成功：${error instanceof Error ? error.message : "未知错误"}`);
      return [];
    }
  }

  const handler = {
    hostname: "127.0.0.1",
    // 经隧道取大文件时两次写之间可能隔好几秒，默认 10 秒空闲超时会把连接直接掐断（浏览器看到的是「Failed to fetch」）。
    idleTimeout: 120,
    async fetch(request: Request, server: Server<SocketData>): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname === T3_INJECT_PATH) {
        return new Response(T3_INJECT_SCRIPT, {
          headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const headers: Record<string, string> = {};
        forwardHeaders(request.headers, proxyOrigin, upstreamOrigin, WS_SKIP_HEADERS, cookiePrefix).forEach((value, key) => {
          headers[key] = value;
        });
        const data: SocketData = { target: transport ? `${url.pathname}${url.search}` : `${wsOrigin}${url.pathname}${url.search}`, headers, upstream: null, pending: [] };
        if (server.upgrade(request, { data })) return undefined;
        return new Response("WebSocket 升级失败", { status: 400 });
      }
      if (assetCache && request.method === "GET" && url.search === "" && isImmutableT3AssetPath(url.pathname)) {
        try {
          const result = await assetCache.getOrFetch(
            url.pathname,
            () =>
              upstreamFetch(url.pathname, {
                method: "GET",
                headers: forwardHeaders(request.headers, proxyOrigin, upstreamOrigin, HOP_HEADERS, cookiePrefix),
              }),
            prefetchAsset,
          );
          if ("cached" in result) {
            return new Response(new Uint8Array(result.cached.body), {
              status: 200,
              headers: {
                "content-type": result.cached.contentType,
                "cache-control": "public, max-age=31536000, immutable",
              },
            });
          }
          const passthroughHeaders = responseHeaders(result.passthrough.headers, proxyOrigin, upstreamOrigin, cookiePrefix);
          return new Response(result.passthrough.body, {
            status: result.passthrough.status,
            statusText: result.passthrough.statusText,
            headers: passthroughHeaders,
          });
        } catch (error) {
          const reason = error instanceof Error ? `：${error.message}` : "";
          return new Response(`对端设备的 T3 没有响应${reason}`, {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      }
      // 浏览器导航打开首页时，把会话检查/自动配对与拉取 HTML 并行跑，省掉隧道上的串行往返。
      const pairTask = options.pairCredential && isNavigation(request) ? autoPair(request) : null;
      let response: Response;
      try {
        response = await upstreamFetch(`${url.pathname}${url.search}`, {
          method: request.method,
          headers: forwardHeaders(request.headers, proxyOrigin, upstreamOrigin, HOP_HEADERS, cookiePrefix),
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
        });
      } catch (error) {
        const reason = transport && error instanceof Error ? `：${error.message}` : "";
        return new Response(`${transport ? "对端设备的 T3 没有响应" : "T3 服务没有响应"}${reason}`, {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (transport && response.status >= 400) console.error(`[t3-proxy] 隧道 HTTP ${response.status} ${request.method} ${url.pathname}`);
      const headers = responseHeaders(response.headers, proxyOrigin, upstreamOrigin, cookiePrefix);
      const isHtml = response.headers.get("content-type")?.toLowerCase().includes("text/html") === true;
      if (pairTask && isHtml) {
        for (const cookie of await pairTask) headers.append("set-cookie", cookie);
      }
      if (isHtml && request.method === "GET") {
        const rawHtml = await response.text();
        if (assetCache && response.status === 200) {
          warmed = true;
          assetCache.prefetchFromText(rawHtml, url.pathname, prefetchAsset);
        }
        const html = injectT3Html(rawHtml);
        return new Response(html, { status: response.status, statusText: response.statusText, headers });
      }
      if (transport && request.method === "GET" && response.status === 200) {
        // T3 的构建产物文件名带内容哈希，却回 Cache-Control: no-cache，每次打开都要为几百个文件各经隧道问一次（约 1 秒一个）。
        if (url.pathname.startsWith("/assets/")) headers.set("cache-control", "public, max-age=31536000, immutable");
        // 脚本和样式整份收完再回：隧道中途断开时返回明确的 502，而不是让 WebKit 把半截脚本当成完整的去执行（Unexpected end of script）。
        const type = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (/^(?:text\/javascript|application\/javascript|text\/css)/u.test(type)) {
          try {
            const body = await response.arrayBuffer();
            return new Response(body, { status: response.status, statusText: response.statusText, headers });
          } catch (error) {
            console.error(`[t3-proxy] 隧道取 ${url.pathname} 中途失败：${error instanceof Error ? error.message : "未知错误"}`);
            return new Response("对端设备的 T3 没有响应", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
          }
        }
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
    websocket: {
      open(socket: ServerWebSocket<SocketData>) {
        const attach = (remote: TransportSocket): void => {
          remote.binaryType = "arraybuffer";
          socket.data.upstream = remote;
          const open = (): void => {
            for (const message of socket.data.pending) remote.send(message);
            socket.data.pending = [];
          };
          remote.addEventListener("open", open);
          remote.addEventListener("message", ((event: { data: string | ArrayBuffer }) => {
            socket.send(event.data);
          }) as (event: never) => void);
          remote.addEventListener("close", ((event: { code: number; reason: string }) => {
            if (transport) console.error(`[t3-proxy] 隧道 WebSocket 关闭 ${socket.data.target.split("?")[0]} code=${event.code} reason=${event.reason}`);
            socket.close(event.code === 1005 || event.code === 1006 ? 1011 : event.code, event.reason);
          }) as (event: never) => void);
          remote.addEventListener("error", (() => socket.close(1011, "T3 连接中断")) as (event: never) => void);
        };
        if (transport) {
          transport
            .openSocket(socket.data.target, Object.entries(socket.data.headers))
            .then(attach, (error: unknown) => {
              console.error(`[t3-proxy] 隧道 WebSocket 打开失败 ${socket.data.target.split("?")[0]}：${error instanceof Error ? error.message : String(error)}`);
              socket.close(1011, "对端设备的 T3 连接失败");
            });
          return;
        }
        attach(new WebSocket(socket.data.target, { headers: socket.data.headers } as unknown as string[]) as unknown as TransportSocket);
      },
      message(socket: ServerWebSocket<SocketData>, message: string | Buffer) {
        const remote = socket.data.upstream;
        const payload = typeof message === "string" ? message : new Uint8Array(message);
        if (remote?.readyState === 1) remote.send(payload);
        else socket.data.pending.push(payload);
      },
      close(socket: ServerWebSocket<SocketData>) {
        const remote = socket.data.upstream;
        if (remote && remote.readyState <= 1) remote.close();
      },
    },
  };

  let server: Server<SocketData>;
  const preferred = options.port ?? preferredProxyPort(upstreamUrl);
  try {
    server = Bun.serve<SocketData, never>({ ...handler, port: preferred });
  } catch {
    server = Bun.serve<SocketData, never>({ ...handler, port: 0 });
  }
  proxyOrigin = `http://127.0.0.1:${server.port}`;
  return {
    url: `${proxyOrigin}/`,
    upstream: `${upstreamOrigin}/`,
    warm: () => {
      if (!assetCache || warmed) return;
      warmed = true;
      void upstreamFetch("/", { method: "GET", headers: new Headers({ accept: "text/html" }) })
        .then(async (response) => {
          if (response.status !== 200) return;
          if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return;
          assetCache.prefetchFromText(await response.text(), "/", prefetchAsset);
        })
        .catch(() => {
          warmed = false;
        });
    },
    stop: () => {
      server.stop(true);
    },
  };
}
