import { LlmRequestError, httpStatusError, networkError } from "./errors.js";

export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${trimmed}${suffix}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function postJson(options: PostJsonOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  try {
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw httpStatusError(response.status, text);
    if (text.trim() === "") {
      throw new LlmRequestError("server", "模型返回为空", {
        status: response.status,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LlmRequestError("server", "模型返回的不是 JSON", {
        status: response.status,
      });
    }
  } catch (error) {
    throw networkError(error);
  }
}

export function jsonInstruction(schema: object): string {
  return `\n\n只输出一个 JSON 对象，不要 Markdown。JSON 必须符合这个 schema：\n${JSON.stringify(schema)}`;
}
