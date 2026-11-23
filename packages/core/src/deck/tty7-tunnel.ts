import { z } from "zod";

import {
  TUNNEL_TTY7_CHUNK_BYTES,
  TUNNEL_TTY7_HEADER,
  type TunnelSession,
  type TunnelSocket,
  type TunnelTty7Handler,
} from "../dispatch/tunnel.js";
import {
  DeckTty7DeleteBodySchema,
  DeckTty7RenameBodySchema,
  DeckTty7SendBodySchema,
  DeckTty7StartBodySchema,
  DeckTty7ViewingBodySchema,
  type DeckTty7PasteImageResponse,
  type DeckTty7RenameBody,
  type DeckTty7ScreenResponse,
  type DeckTty7SendBody,
  type DeckTty7SessionsResponse,
  type DeckTty7StartBody,
  type DeckTty7StartResponse,
  type DeckTty7ViewingBody,
} from "../http/types.js";
import { validTerminalSize, type TerminalConnection, type TerminalSize, type Tty7TerminalEvents } from "./tty7-terminal.js";

const PASTE_IMAGE_LIMIT = 10 * 1024 * 1024;
const TTY7_TERMINAL_PATH = "/api/deck/tty7/terminal";
const LEGACY_PEER_ERROR = "对端设备版本较旧，升级对端 U-Brain 后即可查看其终端会话";

/** 目标端提供给隧道的最小 tty7 能力集合（与 DeckService 对齐）。 */
export interface Tty7HostPort {
  tty7Sessions(): Promise<DeckTty7SessionsResponse>;
  tty7Delete(pane: number): Promise<{ ok: true }>;
  tty7Rename(body: DeckTty7RenameBody): Promise<{ ok: true }>;
  tty7Viewing(body: DeckTty7ViewingBody): Promise<{ ok: true }>;
  tty7Screen(pane: number, lines?: number): Promise<DeckTty7ScreenResponse>;
  tty7Send(body: DeckTty7SendBody): Promise<{ ok: true }>;
  tty7Start(body: DeckTty7StartBody): Promise<DeckTty7StartResponse>;
  tty7PasteImage(data: Uint8Array, contentType: string): Promise<DeckTty7PasteImageResponse>;
  tty7Terminal(pane: number, size: TerminalSize, events: Tty7TerminalEvents): TerminalConnection;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorJson(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function parseJsonBody(body: Uint8Array): unknown {
  const text = Buffer.from(body).toString("utf8").trim();
  if (text === "") return {};
  return JSON.parse(text);
}

/**
 * 目标端 tty7 隧道处理器：只放行 `/api/deck/tty7/*` 白名单路径，不暴露 daemon 其他接口。
 */
export function createTty7TunnelHostHandler(getPort: () => Tty7HostPort | null): TunnelTty7Handler {
  return {
    async fetch(method, rawPath, headers, body) {
      const port = getPort();
      if (!port) return errorJson(503, "SOURCE_UNAVAILABLE", "对端没有提供终端会话服务");
      let url: URL;
      try {
        url = new URL(rawPath, "http://tty7.local");
      } catch {
        return errorJson(400, "INVALID_INPUT", "请求路径不合法");
      }
      const path = url.pathname;
      try {
        if (path === "/api/deck/tty7/sessions") {
          if (method !== "GET") return errorJson(405, "METHOD_NOT_ALLOWED", "只支持 GET");
          return jsonResponse(await port.tty7Sessions());
        }
        if (path === "/api/deck/tty7/delete") {
          if (method !== "POST") return errorJson(405, "METHOD_NOT_ALLOWED", "只支持 POST");
          const parsed = DeckTty7DeleteBodySchema.parse(parseJsonBody(body));
          return jsonResponse(await port.tty7Delete(parsed.pane));
        }
        if (path === "/api/deck/tty7/rename") {
          if (method !== "POST") return errorJson(405, "METHOD_NOT_ALLOWED", "只支持 POST");
          const parsed = DeckTty7RenameBodySchema.parse(parseJsonBody(body));
          return jsonResponse(await port.tty7Rename(parsed));
        }
        if (path === "/api/deck/tty7/viewing") {
          if (method !== "POST") return errorJson(405, "METHOD_NOT_ALLOWED", "只支持 POST");
          const parsed = DeckTty7ViewingBodySchema.parse(parseJsonBody(body));
          return jsonResponse(await port.tty7Viewing(parsed));
        }
        if (path === "/api/deck/tty7/screen") {
          if (method !== "GET") return errorJson(405, "METHOD_NOT_ALLOWED", "只支持 GET");
          const pane = z.coerce.number().int().nonnegative().parse(url.searchParams.get("pane") ?? "");
          const lines = url.searchParams.get("lines");
          return jsonResponse(
            await port.tty7Screen(pane, lines === null ? undefined : z.coerce.number().int().min(1).max(400).parse(lines)),
          );
        }
        if (path === "/api/deck/tty7/send") {
          if (method !== "POST") return errorJson(405, "METHOD_NOT_ALLOWED", "只支持 POST");
          const parsed = DeckTty7SendBodySchema.parse(parseJsonBody(body));
          return jsonResponse(await port.tty7Send(parsed));
        }
        if (path === "/api/deck/tty7/start") {
          if (method !== "POST") return errorJson(405, "METHOD_NOT_ALLOWED", "只支持 POST");
          const parsed = DeckTty7StartBodySchema.parse(parseJsonBody(body));
          return jsonResponse(await port.tty7Start(parsed));
        }
        if (path === "/api/deck/tty7/paste-image") {
          if (method !== "POST") return errorJson(405, "METHOD_NOT_ALLOWED", "只支持 POST");
          const contentType = (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
          if (contentType === "") return errorJson(400, "INVALID_INPUT", "缺少图片类型");
          if (body.byteLength === 0) return errorJson(400, "INVALID_INPUT", "没有图片内容");
          if (body.byteLength > PASTE_IMAGE_LIMIT) return errorJson(413, "INVALID_INPUT", "图片超过 10 MB");
          return jsonResponse(await port.tty7PasteImage(body, contentType));
        }
        return errorJson(404, "NOT_FOUND", "未知的终端会话接口");
      } catch (error) {
        if (error instanceof z.ZodError) return errorJson(400, "INVALID_INPUT", error.message);
        if (error instanceof SyntaxError) return errorJson(400, "INVALID_INPUT", "请求体 JSON 格式无效");
        return errorJson(500, "INTERNAL_ERROR", error instanceof Error ? error.message : "对端终端操作失败");
      }
    },
    openTerminal(pane, size, events) {
      const port = getPort();
      if (!port) throw new Error("对端没有提供实时终端服务");
      return port.tty7Terminal(pane, size, events);
    },
  };
}

/** 经加密隧道向对端发起一次 tty7 JSON 请求；若对端未返回 tty7 标记头则说明版本较旧。 */
export async function remoteTty7Json<T>(
  getSession: () => Promise<TunnelSession>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const session = await getSession();
  const headers: Array<[string, string]> = [];
  let encodedBody: Uint8Array | undefined;
  if (body !== undefined) {
    headers.push(["content-type", "application/json"]);
    encodedBody = new TextEncoder().encode(JSON.stringify(body));
  }
  const response = await session.fetch(path, {
    method,
    headers,
    ...(encodedBody ? { body: encodedBody } : {}),
    target: "tty7",
  });
  return parseRemoteTty7Response<T>(response);
}

/** 经加密隧道把粘贴的图片落盘到对端设备。 */
export async function remoteTty7PasteImage(
  getSession: () => Promise<TunnelSession>,
  data: Uint8Array,
  contentType: string,
): Promise<DeckTty7PasteImageResponse> {
  const session = await getSession();
  const response = await session.fetch("/api/deck/tty7/paste-image", {
    method: "POST",
    headers: [["content-type", contentType]],
    body: data,
    target: "tty7",
  });
  return parseRemoteTty7Response<DeckTty7PasteImageResponse>(response);
}

async function parseRemoteTty7Response<T>(response: Response): Promise<T> {
  if (response.headers.get(TUNNEL_TTY7_HEADER) !== "1") {
    throw new Error(LEGACY_PEER_ERROR);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    if (!response.ok) throw new Error(`对端终端服务返回异常（HTTP ${response.status}）`);
    throw new Error("对端终端服务返回的数据格式不正确");
  }
  if (!response.ok) {
    const message =
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error?: { message?: unknown } }).error?.message === "string"
        ? (parsed as { error: { message: string } }).error.message
        : `对端终端操作失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return parsed as T;
}

/**
 * 发起端实时终端连接：把 `TerminalConnection` / `Tty7TerminalEvents` 经加密隧道桥接到对端 tty7。
 * 隧道握手与打开前收到的输入/尺寸/暂停会被排队，握手完成后按序发出。
 */
export function openRemoteTty7Terminal(
  getSession: () => Promise<TunnelSession>,
  pane: number,
  size: TerminalSize,
  events: Tty7TerminalEvents,
): TerminalConnection {
  if (!Number.isSafeInteger(pane) || pane < 0) throw new Error("会话编号不正确");
  if (!validTerminalSize(size)) throw new Error("终端尺寸不正确");

  let closed = false;
  let opened = false;
  let socket: TunnelSocket | null = null;
  let lastSize: TerminalSize | null = null;
  let pendingPause: boolean | null = null;
  const queuedInput: Uint8Array[] = [];

  const finish = (): void => {
    if (closed) return;
    closed = true;
    queuedInput.length = 0;
    const current = socket;
    socket = null;
    try {
      current?.close();
    } catch {
      // 已经关了。
    }
    events.close();
  };

  const fail = (message: string): void => {
    if (closed) return;
    events.error(message);
    finish();
  };

  const sendInputChunks = (target: TunnelSocket, bytes: Uint8Array): void => {
    for (let offset = 0; offset < bytes.length; offset += TUNNEL_TTY7_CHUNK_BYTES) {
      target.send(bytes.subarray(offset, Math.min(bytes.length, offset + TUNNEL_TTY7_CHUNK_BYTES)));
    }
  };

  const sendControl = (target: TunnelSocket, value: unknown): void => {
    target.send(JSON.stringify(value));
  };

  void getSession().then(
    (session) => {
      if (closed) return;
      const ws = session.socket(TTY7_TERMINAL_PATH, [], "tty7");
      socket = ws;
      ws.addEventListener("open", (() => {
        if (closed) {
          ws.close();
          return;
        }
        opened = true;
        sendControl(ws, { type: "connect", pane, size: lastSize ?? size });
        lastSize = null;
        if (pendingPause !== null) {
          sendControl(ws, { type: pendingPause ? "pause" : "resume" });
          pendingPause = null;
        }
        while (queuedInput.length > 0) {
          sendInputChunks(ws, queuedInput.shift()!);
        }
      }) as never);
      ws.addEventListener("message", ((event: { data: string | ArrayBuffer }) => {
        if (closed) return;
        if (event.data instanceof ArrayBuffer) {
          events.output(new Uint8Array(event.data));
          return;
        }
        let message: {
          type?: unknown;
          size?: unknown;
          by?: unknown;
          message?: unknown;
          code?: unknown;
        };
        try {
          message = JSON.parse(event.data) as typeof message;
        } catch {
          fail("对端终端返回的数据格式无效");
          return;
        }
        if (message.type === "ready") events.ready();
        else if (message.type === "live") events.live();
        else if (message.type === "size" && validTerminalSize(message.size)) events.size(message.size);
        else if (message.type === "lease" && (message.by === null || typeof message.by === "string")) events.lease(message.by);
        else if (message.type === "warning" && typeof message.message === "string") events.warning(message.message);
        else if (message.type === "exit") events.exit(typeof message.code === "number" ? message.code : null);
        else if (message.type === "error" && typeof message.message === "string") events.error(message.message);
      }) as never);
      ws.addEventListener("error", ((event: { message?: unknown }) => {
        const detail = typeof event?.message === "string" && event.message !== "" ? event.message : "对端终端连接中断";
        fail(detail);
      }) as never);
      ws.addEventListener("close", (() => {
        finish();
      }) as never);
    },
    (error: unknown) => {
      fail(error instanceof Error ? error.message : "无法建立到对端设备的隧道");
    },
  );

  return {
    input(bytes) {
      if (closed || bytes.length === 0) return;
      if (opened && socket) sendInputChunks(socket, bytes);
      else queuedInput.push(Uint8Array.from(bytes));
    },
    resize(next) {
      if (closed || !validTerminalSize(next)) return;
      if (opened && socket) sendControl(socket, { type: "resize", size: next });
      else lastSize = next;
    },
    pause() {
      if (closed) return;
      if (opened && socket) sendControl(socket, { type: "pause" });
      else pendingPause = true;
    },
    resume() {
      if (closed) return;
      if (opened && socket) sendControl(socket, { type: "resume" });
      else pendingPause = false;
    },
    close: finish,
  };
}
