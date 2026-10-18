import { lstat, realpath, rm, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { ulid } from "@you-brain/protocol";

import {
  assertLoopbackPort,
  createDaemonToken,
  readDaemonEndpoint,
  writeDaemonEndpoint,
} from "./daemon-file.js";
import type { HttpDeps } from "./deps.js";
import {
  apiError,
  bearerToken,
  errorResponse,
  handleApi,
  tokensEqual,
  type ApiContext,
} from "./handlers.js";
import { ChangeHub, formatSse } from "./hub.js";
import type { DaemonEvent } from "./types.js";

export interface StartDaemonHttpOptions {
  dataDir: string;
  deps: HttpDeps;
  /** `0` chooses a free port. The bound port is written to daemon.json. */
  port?: number;
  token?: string;
  /** Web UI build directory. `/` falls back to index.html. */
  staticDir?: string;
  createId?: () => string;
  hub?: ChangeHub;
}

export interface DaemonHttpServer {
  port: number;
  hostname: "127.0.0.1";
  token: string;
  pid: number;
  baseUrl: string;
  file: string;
  changes: ChangeHub;
  stop(): Promise<void>;
}

export async function startDaemonHttp(
  options: StartDaemonHttpOptions,
): Promise<DaemonHttpServer> {
  const token = options.token ?? createDaemonToken();
  if (token.length < 16) {
    throw new Error("daemon token 至少 16 个字符");
  }
  const port = assertLoopbackPort(options.port);
  const hub = options.hub ?? new ChangeHub();
  const context: ApiContext = {
    deps: options.deps,
    hub,
    createId: options.createId ?? (() => ulid()),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: (request) => dispatch(request, token, options.staticDir, context),
  });
  const endpoint = {
    port: server.port ?? 0,
    token,
    pid: process.pid,
  };
  let file: string;
  try {
    file = await writeDaemonEndpoint(options.dataDir, endpoint);
  } catch (error) {
    server.stop(true);
    throw error;
  }
  let stopped = false;
  return {
    port: endpoint.port,
    hostname: "127.0.0.1",
    token,
    pid: endpoint.pid,
    baseUrl: `http://127.0.0.1:${endpoint.port}`,
    file,
    changes: hub,
    async stop() {
      if (stopped) return;
      stopped = true;
      hub.shutdown();
      server.stop(true);
      const current = await readDaemonEndpoint(options.dataDir).catch(() => null);
      if (
        current &&
        current.pid === endpoint.pid &&
        current.port === endpoint.port &&
        current.token === token
      ) {
        await rm(file, { force: true });
      }
    },
  };
}

async function dispatch(
  request: Request,
  token: string,
  staticDir: string | undefined,
  context: ApiContext,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith("/api/")) {
      if (!authorized(request, url, token)) {
        return apiError(401, "UNAUTHORIZED", "缺少或无效的访问令牌");
      }
      if (url.pathname === "/api/events") {
        if (request.method !== "GET") {
          return apiError(405, "METHOD_NOT_ALLOWED", "方法不被允许", {
            allow: "GET",
          });
        }
        return eventStream(request, context.hub);
      }
      return await handleApi(request, url, context);
    }
    if (staticDir) return await serveStatic(staticDir, url.pathname, token);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return new Response(missingWebHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return apiError(404, "NOT_FOUND", "找不到页面");
  } catch (error) {
    return errorResponse(error);
  }
}

function authorized(request: Request, url: URL, token: string): boolean {
  const header = bearerToken(request);
  if (header !== null && tokensEqual(header, token)) return true;
  if (url.pathname === "/api/events" && header === null) {
    const query = url.searchParams.get("token");
    if (query !== null && tokensEqual(query, token)) return true;
  }
  return false;
}

function eventStream(request: Request, hub: ChangeHub): Response {
  const encoder = new TextEncoder();
  let unsubscribe = (): void => undefined;
  let removeShutdown = (): void => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        removeShutdown();
        try {
          controller.close();
        } catch {
          // The client already went away.
        }
      };
      const send = (event: DaemonEvent): void => {
        try {
          controller.enqueue(encoder.encode(formatSse(event)));
        } catch {
          finish();
        }
      };
      unsubscribe = hub.subscribe(send);
      removeShutdown = hub.onShutdown(finish);
      const ready: DaemonEvent = {
        id: 0,
        kind: "ready",
        at: new Date().toISOString(),
      };
      send(ready);
      if (request.signal.aborted) {
        finish();
        return;
      }
      request.signal.addEventListener("abort", finish, { once: true });
    },
    cancel() {
      unsubscribe();
      removeShutdown();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function serveStatic(
  staticDir: string,
  pathname: string,
  token: string,
): Promise<Response> {
  let root: string;
  try {
    root = await realpath(staticDir);
  } catch {
    return apiError(404, "NOT_FOUND", "找不到页面");
  }
  const relative = pathname.replace(/^\/+/u, "");
  if (relative === "" || relative.endsWith("/")) return serveIndex(root, token);
  const target = resolve(root, relative);
  if (!isInside(root, target)) return apiError(404, "NOT_FOUND", "找不到页面");
  const linked = await lstat(target).catch(() => null);
  if (!linked) {
    if (extname(relative) === "") return serveIndex(root, token);
    return apiError(404, "NOT_FOUND", "找不到页面");
  }
  if (linked.isSymbolicLink()) {
    const real = await realpath(target).catch(() => null);
    if (!real || !isInside(root, real)) return apiError(404, "NOT_FOUND", "找不到页面");
  }
  const info = await stat(target).catch(() => null);
  if (info?.isFile()) return new Response(Bun.file(target));
  if (extname(relative) === "") return serveIndex(root, token);
  return apiError(404, "NOT_FOUND", "找不到页面");
}

async function serveIndex(root: string, token: string): Promise<Response> {
  const index = resolve(root, "index.html");
  const info = await stat(index).catch(() => null);
  if (!info?.isFile()) return apiError(404, "NOT_FOUND", "找不到页面");
  const html = await Bun.file(index).text();
  const script = `<script>window.__YOU_BRAIN__=${JSON.stringify({ token })}</script>`;
  const body = html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : `${script}${html}`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function missingWebHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>you-brain</title></head>
<body>
<main>
<h1>you-brain 没有找到 Web 界面</h1>
<p>按下面的顺序查找了构建目录，都没有可用的目录：</p>
<ol>
<li>环境变量 <code>YOU_BRAIN_WEB_DIR</code></li>
<li>可执行文件同级的 <code>web/</code> 目录</li>
<li>macOS 应用包内的 <code>../Resources/web</code></li>
<li>源码运行时的 <code>apps/web/dist</code></li>
</ol>
<p>请先构建 <code>apps/web</code>，或把构建目录设到 <code>YOU_BRAIN_WEB_DIR</code>。</p>
</main>
</body>
</html>`;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}
