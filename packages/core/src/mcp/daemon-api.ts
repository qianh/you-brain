import {
  DaemonFileError,
  isProcessAlive,
  readDaemonEndpoint,
} from "../http/daemon-file.js";

export class DaemonCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DaemonCallError";
  }
}

export async function callDaemon<T>(options: {
  dataDir: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
  fetch?: typeof fetch;
}): Promise<T> {
  let endpoint;
  try {
    endpoint = await readDaemonEndpoint(options.dataDir);
  } catch (error) {
    if (error instanceof DaemonFileError) {
      throw new DaemonCallError("DAEMON_NOT_RUNNING", error.message);
    }
    throw error;
  }
  if (!endpoint) {
    throw new DaemonCallError(
      "DAEMON_NOT_RUNNING",
      "daemon 未运行（找不到 daemon.json）",
    );
  }
  if (!isProcessAlive(endpoint.pid)) {
    throw new DaemonCallError(
      "DAEMON_NOT_RUNNING",
      "daemon 未运行（进程已退出）",
    );
  }
  const fetchImpl = options.fetch ?? fetch;
  const headers = new Headers({
    authorization: `Bearer ${endpoint.token}`,
  });
  const init: RequestInit = { method: options.method, headers };
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetchImpl(
      `http://127.0.0.1:${endpoint.port}${options.path}`,
      init,
    );
  } catch {
    throw new DaemonCallError(
      "DAEMON_NOT_RUNNING",
      "daemon 未运行（无法连接本地服务）",
    );
  }
  const text = await response.text();
  const parsed = text === "" ? null : parseJson(text);
  if (response.status === 401) {
    throw new DaemonCallError("DAEMON_TOKEN_REJECTED", "daemon 拒绝了访问令牌");
  }
  if (!response.ok) {
    const error = errorOf(parsed);
    throw new DaemonCallError(
      error?.code ?? "HTTP_ERROR",
      error?.message ?? `daemon 返回 HTTP ${response.status}`,
    );
  }
  return parsed as T;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DaemonCallError("INVALID_RESPONSE", "daemon 返回的不是 JSON");
  }
}

function errorOf(
  value: unknown,
): { code: string; message: string } | null {
  if (value === null || typeof value !== "object" || !("error" in value)) {
    return null;
  }
  const error = (value as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return null;
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  const message =
    "message" in error && typeof error.message === "string" ? error.message : null;
  if (code === null || message === null) return null;
  return { code, message };
}
