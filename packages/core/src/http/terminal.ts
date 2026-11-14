import type { ServerWebSocket } from "bun";
import { validTerminalSize, type TerminalConnection } from "../deck/tty7-terminal.js";
import type { HttpDeps } from "./deps.js";
import { tokensEqual } from "./handlers.js";

export const TERMINAL_PATH = "/api/deck/tty7/terminal";
export interface TerminalSocketData {
  connection?: TerminalConnection;
  timer?: ReturnType<typeof setTimeout>;
  authenticated: boolean;
  inFlight: number;
}

/** 令牌只在首帧发送，不进入 URL；未认证连接不接触 tty7。 */
export function terminalWebSocket(token: string, deps: HttpDeps) {
  const sockets = new Set<ServerWebSocket<TerminalSocketData>>();
  const control = (ws: ServerWebSocket<TerminalSocketData>, value: unknown): void => {
    ws.send(JSON.stringify(value));
  };
  const reject = (ws: ServerWebSocket<TerminalSocketData>, message: string): void => {
    control(ws, { type: "error", message });
    ws.close(1008, "Terminal request rejected");
  };
  return {
    shutdown() {
      for (const ws of sockets) {
        ws.data.connection?.close();
        clearTimeout(ws.data.timer);
        ws.close(1001, "Daemon stopping");
      }
      sockets.clear();
    },
    handler: {
      idleTimeout: 60,
      sendPings: true,
      maxPayloadLength: 1024 * 1024,
      backpressureLimit: 8 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws: ServerWebSocket<TerminalSocketData>) {
        sockets.add(ws);
        ws.data.timer = setTimeout(() => reject(ws, "终端连接认证超时"), 5_000);
      },
      message(ws: ServerWebSocket<TerminalSocketData>, message: string | Buffer) {
        try {
          if (!ws.data.authenticated) {
            if (typeof message !== "string") return reject(ws, "请先认证终端连接");
            const request = JSON.parse(message);
            if (request.type !== "connect" || typeof request.token !== "string" || !tokensEqual(request.token, token)) {
              return reject(ws, "缺少或无效的访问令牌");
            }
            if (!Number.isSafeInteger(request.pane) || request.pane < 0 || !validTerminalSize(request.size)) {
              return reject(ws, "终端会话或尺寸不正确");
            }
            const open = deps.deck?.tty7Terminal;
            if (!open) return reject(ws, "后台没有提供实时终端服务");
            clearTimeout(ws.data.timer);
            ws.data.authenticated = true;
            ws.data.connection = open(request.pane, request.size, {
              ready: () => control(ws, { type: "ready" }),
              output(bytes) {
                // 浏览器解析完成才 ACK，避免快速输出把渲染队列撑满。
                ws.data.inFlight += bytes.length;
                ws.sendBinary(bytes);
                if (ws.data.inFlight >= 256 * 1024) ws.data.connection?.pause();
              },
              size: (size) => control(ws, { type: "size", size }),
              lease: (by) => control(ws, { type: "lease", by }),
              warning: (message) => control(ws, { type: "warning", message }),
              exit: (code) => control(ws, { type: "exit", code }),
              error: (message) => control(ws, { type: "error", message }),
              close: () => ws.close(1000, "Terminal stream closed"),
            });
          } else if (typeof message !== "string") {
            ws.data.connection?.input(message);
          } else {
            const request = JSON.parse(message);
            if (request.type === "resize" && validTerminalSize(request.size)) ws.data.connection?.resize(request.size);
            else if (request.type === "ack" && Number.isSafeInteger(request.bytes) && request.bytes >= 0 && request.bytes <= ws.data.inFlight) {
              ws.data.inFlight -= request.bytes;
              if (ws.data.inFlight < 64 * 1024) ws.data.connection?.resume();
            } else reject(ws, "终端控制消息不正确");
          }
        } catch { reject(ws, "终端请求无效"); }
      },
      close(ws: ServerWebSocket<TerminalSocketData>) {
        clearTimeout(ws.data.timer);
        ws.data.connection?.close();
        sockets.delete(ws);
      },
    },
  };
}
