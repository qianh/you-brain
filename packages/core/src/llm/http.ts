import { LlmAbortError, LlmRequestError, httpStatusError, networkError } from "./errors.js";

export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_SSE_FIRST_CHUNK_TIMEOUT_MS = 120_000;
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 60_000;

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface PostSseChatOptions extends PostJsonOptions {
  firstChunkTimeoutMs?: number;
  idleTimeoutMs?: number;
  onDelta?: (cumulative: string) => void;
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
  if (options.signal?.aborted) throw new LlmAbortError();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.body),
      signal: combinedSignal,
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
    if (options.signal?.aborted) throw new LlmAbortError();
    throw networkError(error);
  }
}

export function readChatTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

export function readChatCompletionContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new LlmRequestError("server", "模型返回为空");
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new LlmRequestError("server", "模型返回为空");
  }
  const text = readChatTextContent(choice.message.content);
  if (text.trim() === "") throw new LlmRequestError("server", "模型返回为空");
  return text;
}

function readStreamErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (isRecord(value) && typeof value.message === "string" && value.message.trim() !== "") {
    return value.message.trim();
  }
  return "模型流式返回错误";
}

export async function postSseChat(options: PostSseChatOptions): Promise<string> {
  if (options.signal?.aborted) throw new LlmAbortError();
  const fetchImpl = options.fetchImpl ?? fetch;
  const totalTimeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const firstChunkTimeoutMs =
    options.firstChunkTimeoutMs ?? Math.min(totalTimeoutMs, DEFAULT_SSE_FIRST_CHUNK_TIMEOUT_MS);
  const idleTimeoutMs =
    options.idleTimeoutMs ?? Math.min(totalTimeoutMs, DEFAULT_SSE_IDLE_TIMEOUT_MS);

  const controller = new AbortController();
  let abortReason: "external" | "total" | "first_chunk" | "idle" | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let firstChunkTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<unknown> } | null = null;

  const triggerAbort = (reason: "external" | "total" | "first_chunk" | "idle"): void => {
    if (abortReason !== null) return;
    abortReason = reason;
    controller.abort();
  };

  const onExternalAbort = (): void => triggerAbort("external");
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const clearFirstChunkTimer = (): void => {
    if (firstChunkTimer !== null) {
      clearTimeout(firstChunkTimer);
      firstChunkTimer = null;
    }
  };
  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const resetIdleTimer = (): void => {
    clearIdleTimer();
    idleTimer = setTimeout(() => triggerAbort("idle"), idleTimeoutMs);
  };

  totalTimer = setTimeout(() => triggerAbort("total"), totalTimeoutMs);
  firstChunkTimer = setTimeout(() => triggerAbort("first_chunk"), firstChunkTimeoutMs);

  try {
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw httpStatusError(response.status, text);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      clearFirstChunkTimer();
      const text = await response.text();
      if (text.trim() === "") {
        throw new LlmRequestError("server", "模型返回为空", { status: response.status });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new LlmRequestError("server", "模型返回的不是 JSON", { status: response.status });
      }
      const result = readChatCompletionContent(parsed);
      options.onDelta?.(result);
      return result;
    }

    if (!response.body) {
      throw new LlmRequestError("server", "模型返回为空", { status: response.status });
    }

    resetIdleTimer();
    const streamReader = response.body.getReader();
    reader = streamReader;
    const decoder = new TextDecoder();
    let buffer = "";
    let eventDataLines: string[] = [];
    let content = "";
    let sawDone = false;
    let finishReason: string | null = null;
    let sawFirstSignal = false;

    const markFirstSignal = (): void => {
      if (sawFirstSignal) return;
      sawFirstSignal = true;
      clearFirstChunkTimer();
    };

    const flushEvent = (): void => {
      if (eventDataLines.length === 0) return;
      const payload = eventDataLines.join("\n").trim();
      eventDataLines = [];
      if (payload === "") return;
      markFirstSignal();
      if (payload === "[DONE]") {
        sawDone = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        // Ignore malformed non-JSON SSE data frames rather than crashing mid-stream.
        return;
      }
      if (!isRecord(parsed)) return;
      if (parsed.error !== undefined && parsed.error !== null) {
        throw new LlmRequestError("server", readStreamErrorMessage(parsed.error));
      }
      if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) return;
      const choice = parsed.choices[0];
      if (!isRecord(choice)) return;
      if (typeof choice.finish_reason === "string" && choice.finish_reason.trim() !== "") {
        finishReason = choice.finish_reason;
      }
      const delta = choice.delta;
      if (!isRecord(delta)) return;
      const piece = readChatTextContent(delta.content);
      if (piece !== "") {
        content += piece;
        options.onDelta?.(content);
      }
    };

    const processLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        flushEvent();
        return;
      }
      if (line.startsWith(":")) {
        // Keep-alive comment: counts as first signal / activity.
        markFirstSignal();
        return;
      }
      if (line.startsWith("data:")) {
        const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
        eventDataLines.push(value);
      }
    };

    for (;;) {
      const { done, value } = await streamReader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        resetIdleTimer();
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          processLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
    }

    const tail = decoder.decode();
    if (tail !== "") buffer += tail;
    if (buffer !== "") {
      for (const line of buffer.split("\n")) {
        processLine(line);
      }
    }
    flushEvent();

    if (!sawDone && finishReason === null) {
      throw new LlmRequestError("network", "模型流式响应提前中断");
    }
    if (content.trim() === "") {
      throw new LlmRequestError("server", "模型返回为空");
    }
    return content;
  } catch (error) {
    if (abortReason === "external" || options.signal?.aborted) {
      throw new LlmAbortError();
    }
    if (abortReason === "first_chunk") {
      throw new LlmRequestError("network", "请求首包超时");
    }
    if (abortReason === "idle") {
      throw new LlmRequestError("network", "流式响应空闲超时");
    }
    if (abortReason === "total") {
      throw new LlmRequestError("network", "请求超时");
    }
    if (error instanceof LlmAbortError) throw error;
    if (error instanceof LlmRequestError) throw error;
    throw networkError(error);
  } finally {
    if (totalTimer !== null) clearTimeout(totalTimer);
    clearFirstChunkTimer();
    clearIdleTimer();
    options.signal?.removeEventListener("abort", onExternalAbort);
    if (reader) {
      void reader.cancel().catch(() => undefined);
    }
  }
}

export function jsonInstruction(schema: object): string {
  return `\n\n只输出一个 JSON 对象，不要 Markdown。JSON 必须符合这个 schema：\n${JSON.stringify(schema)}`;
}
