import { createServer } from "node:http";

import type { OAuthLoopbackOptions, OAuthLoopbackSession } from "./oauth-loopback.js";

/**
 * 无界面机器上的 OAuth 回调。
 *
 * 普通 loopback 监听 0 端口，端口随机，只有登录开始后才知道，服务器上没法提前
 * 开好 SSH 隧道。这里固定端口，并在打印授权链接之前先把隧道命令写出来。
 *
 * Google 已经废弃了带外（copy/paste）授权码流程，所以回调必须真的到达
 * 127.0.0.1 上的这个端口：用户在自己电脑上执行 `ssh -L` 转发过来。
 */
export const HEADLESS_CALLBACK_PORT = 53682;
export const HEADLESS_CALLBACK_PATH = "/oauth/callback";

export interface HeadlessLoopbackOptions extends OAuthLoopbackOptions {
  port?: number;
  /** 打印给用户的 SSH 隧道命令。返回 null 时不打印（例如已经在同一台机器上）。 */
  describeTunnel?: (port: number) => string | null;
  /**
   * 授权链接已经交给别的渠道展示（例如 Web 界面的“登录”按钮）时设为 false，
   * 不再往 stdout 写。daemon 的 stdout 在服务器上只进 journalctl，用户看不到。
   */
  printHint?: boolean;
  /** 把授权链接与隧道命令交给调用方展示，而不是只写 stdout。 */
  onAuthorizationUrl?: (info: { url: string; tunnel: string | null }) => void;
}

export function headlessRedirectUri(port = HEADLESS_CALLBACK_PORT): string {
  return `http://127.0.0.1:${port}${HEADLESS_CALLBACK_PATH}`;
}

/**
 * 与 `startOAuthLoopback` 行为一致，只是固定端口并额外打印隧道命令。
 * 端口被占用时抛 EADDRINUSE，由调用方转成可读的错误。
 */
export async function startHeadlessOAuthLoopback(
  state: string,
  options: HeadlessLoopbackOptions = {},
): Promise<OAuthLoopbackSession> {
  const port = options.port ?? HEADLESS_CALLBACK_PORT;
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  let settled = false;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // close() 也会 settle，即使没人等 code。先挂一个空 handler，避免变成 unhandled rejection。
  void codePromise.catch(() => undefined);
  const settleError = (error: Error): void => {
    if (settled) return;
    settled = true;
    rejectCode(error);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== HEADLESS_CALLBACK_PATH || url.searchParams.get("state") !== state) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("you-brain authorization failed. You can close this window.");
      settleError(new Error("OAuth callback validation failed"));
      return;
    }
    if (url.searchParams.has("error")) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("you-brain authorization was cancelled. You can close this window.");
      settleError(new Error("OAuth authorization was cancelled"));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("you-brain authorization failed. You can close this window.");
      settleError(new Error("OAuth callback validation failed"));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("you-brain authorization completed. You can close this window.");
    if (!settled) {
      settled = true;
      resolveCode(code);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      // 端口固定，重启或旧进程残留时很容易撞上。直接说清楚该怎么办。
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `本地授权端口 ${port} 被占用（可能上一个登录还没结束）。先关闭占用它的进程，或稍后重试。`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to open OAuth callback server");
  }
  const redirectUri = headlessRedirectUri(address.port);
  let timeout: NodeJS.Timeout | undefined;
  return {
    redirectUri,
    async authorize(authorizationUrl: string): Promise<string> {
      const signal = options.signal;
      const onAbort = (): void => {
        if (timeout) clearTimeout(timeout);
        settleError(new Error("OAuth authorization was cancelled"));
      };
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const tunnel = (options.describeTunnel ?? describeSshTunnel)(address.port);
      const handedOff = options.onAuthorizationUrl !== undefined;
      options.onAuthorizationUrl?.({ url: authorizationUrl, tunnel });
      // 链接已经交给界面时不再写 stdout：服务器上 stdout 只进 journalctl，
      // 重复写只会让人以为应该去看日志。
      if (options.printHint !== false && !handedOff) {
        if (tunnel) {
          console.log("这台机器没有浏览器。先在你自己的电脑上执行：");
          console.log(`  ${tunnel}`);
          console.log("保持这个终端窗口开着，然后在浏览器里打开下面的链接：");
        }
        (options.printUrl ?? printHeadlessUrl)(authorizationUrl);
      }
      // 服务器上不要尝试拉起浏览器：没有图形会话，open 只会失败并刷一行噪音。
      if (options.openUrl) await options.openUrl(authorizationUrl).catch(() => undefined);
      timeout = setTimeout(
        () => settleError(new Error("OAuth callback timed out")),
        options.timeoutMs ?? 10 * 60_000,
      );
      try {
        return await codePromise;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timeout);
        timeout = undefined;
      }
    },
    async close(): Promise<void> {
      if (timeout) clearTimeout(timeout);
      // 服务一关就不可能再收到 code，让等待者结束而不是悬着。
      settleError(new Error("OAuth authorization was cancelled"));
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** `ssh -N -L 53682:127.0.0.1:53682 user@server`，用户名和主机名取环境。 */
export function describeSshTunnel(port: number, env: NodeJS.ProcessEnv = process.env): string {
  const user = env.USER?.trim() || env.LOGNAME?.trim();
  const host = env.SSH_CONNECTION?.split(/\s+/u)[2]?.trim();
  // 两个都拿到才拼出可用的命令。只拿到用户名时会变成 `ssh ... john`，反而误导。
  const target = user && host ? `${user}@${host}` : "user@这台服务器";
  return `ssh -N -L ${port}:127.0.0.1:${port} ${target}`;
}

function printHeadlessUrl(url: string): void {
  console.log(url);
}
