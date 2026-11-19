import type { Server, ServerWebSocket } from "bun";

import { T3_INJECT_PATH, T3_INJECT_SCRIPT } from "./inject.js";

/**
 * T3 本机转发：指挥台的 T3 iframe 改为加载这里，daemon 原样转发 HTTP 与 WebSocket 到用户自己的 T3 服务，
 * 只在首页 HTML 里插入一段 U-Brain 脚本（多巴胺底色、输入框里的 @ 引用）。
 *
 * - 只监听 127.0.0.1；不读写 T3 的数据库，不保存、不打印 T3 的 Cookie 或令牌。
 * - T3 的登录 Cookie 绑在 127.0.0.1 主机上（浏览器不按端口区分 Cookie），转发后沿用同一登录状态。
 * - 端口优先用「T3 端口 + 10000」，让 T3 存在 localStorage 里的设置在 daemon 重启后还在；被占时随机。
 */
export interface T3Proxy {
  /** 转发服务根地址，形如 http://127.0.0.1:13773/。 */
  readonly url: string;
  readonly upstream: string;
  stop(): void;
}

interface SocketData {
  target: string;
  headers: Record<string, string>;
  upstream: WebSocket | null;
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

/** 在 HTML 的 </head> 前插入 U-Brain 脚本；没有 </head> 时插在最前。 */
export function injectT3Html(html: string): string {
  const tag = `<script src="${T3_INJECT_PATH}"></script>`;
  const index = html.search(/<\/head>/iu);
  return index === -1 ? `${tag}${html}` : `${html.slice(0, index)}${tag}${html.slice(index)}`;
}

/** 请求头：去掉逐跳头；Origin / Referer 里的转发地址换回 T3 地址，避免上游的同源校验把请求拒掉。 */
export function forwardHeaders(source: Headers, proxyOrigin: string, upstreamOrigin: string, skip = HOP_HEADERS): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (skip.has(key.toLowerCase())) return;
    if ((key.toLowerCase() === "origin" || key.toLowerCase() === "referer") && value.startsWith(proxyOrigin)) {
      out.set(key, upstreamOrigin + value.slice(proxyOrigin.length));
      return;
    }
    out.append(key, value);
  });
  return out;
}

/** 响应头：去掉逐跳头和编码相关头（正文已解压、可能被改写）；跳转到 T3 本身的地址换回转发地址。 */
export function responseHeaders(source: Headers, proxyOrigin: string, upstreamOrigin: string): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower === "content-encoding" || lower === "set-cookie") return;
    if (lower === "location" && value.startsWith(upstreamOrigin)) {
      out.set(key, proxyOrigin + value.slice(upstreamOrigin.length));
      return;
    }
    out.append(key, value);
  });
  for (const cookie of source.getSetCookie()) out.append("set-cookie", cookie);
  return out;
}

export function startT3Proxy(upstreamUrl: string): T3Proxy {
  const upstream = new URL(upstreamUrl);
  const upstreamOrigin = upstream.origin;
  const wsOrigin = upstreamOrigin.replace(/^http/u, "ws");
  let proxyOrigin = "";

  const handler = {
    hostname: "127.0.0.1",
    async fetch(request: Request, server: Server<SocketData>): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname === T3_INJECT_PATH) {
        return new Response(T3_INJECT_SCRIPT, {
          headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
        });
      }
      const target = `${upstreamOrigin}${url.pathname}${url.search}`;
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const headers: Record<string, string> = {};
        forwardHeaders(request.headers, proxyOrigin, upstreamOrigin, WS_SKIP_HEADERS).forEach((value, key) => {
          headers[key] = value;
        });
        const data: SocketData = { target: `${wsOrigin}${url.pathname}${url.search}`, headers, upstream: null, pending: [] };
        if (server.upgrade(request, { data })) return undefined;
        return new Response("WebSocket 升级失败", { status: 400 });
      }
      let response: Response;
      try {
        response = await fetch(target, {
          method: request.method,
          headers: forwardHeaders(request.headers, proxyOrigin, upstreamOrigin),
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
          redirect: "manual",
        });
      } catch {
        return new Response("T3 服务没有响应", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const headers = responseHeaders(response.headers, proxyOrigin, upstreamOrigin);
      if (response.headers.get("content-type")?.toLowerCase().includes("text/html") && request.method === "GET") {
        const html = injectT3Html(await response.text());
        return new Response(html, { status: response.status, statusText: response.statusText, headers });
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
    websocket: {
      open(socket: ServerWebSocket<SocketData>) {
        const remote = new WebSocket(socket.data.target, { headers: socket.data.headers } as unknown as string[]);
        remote.binaryType = "arraybuffer";
        socket.data.upstream = remote;
        remote.addEventListener("open", () => {
          for (const message of socket.data.pending) remote.send(message);
          socket.data.pending = [];
        });
        remote.addEventListener("message", (event) => {
          socket.send(event.data as string | ArrayBuffer);
        });
        remote.addEventListener("close", (event) => {
          socket.close(event.code === 1005 || event.code === 1006 ? 1011 : event.code, event.reason);
        });
        remote.addEventListener("error", () => socket.close(1011, "T3 连接中断"));
      },
      message(socket: ServerWebSocket<SocketData>, message: string | Buffer) {
        const remote = socket.data.upstream;
        const payload = typeof message === "string" ? message : new Uint8Array(message);
        if (remote?.readyState === WebSocket.OPEN) remote.send(payload);
        else socket.data.pending.push(payload);
      },
      close(socket: ServerWebSocket<SocketData>) {
        const remote = socket.data.upstream;
        if (remote && remote.readyState <= WebSocket.OPEN) remote.close();
      },
    },
  };

  let server: Server<SocketData>;
  const preferred = preferredProxyPort(upstreamUrl);
  try {
    server = Bun.serve<SocketData, never>({ ...handler, port: preferred });
  } catch {
    server = Bun.serve<SocketData, never>({ ...handler, port: 0 });
  }
  proxyOrigin = `http://127.0.0.1:${server.port}`;
  return {
    url: `${proxyOrigin}/`,
    upstream: `${upstreamOrigin}/`,
    stop: () => {
      server.stop(true);
    },
  };
}
