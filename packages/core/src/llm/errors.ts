export const LLM_ERROR_KINDS = [
  "auth",
  "rate_limit",
  "network",
  "server",
  "client",
] as const;

export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];

const RETRYABLE: Record<LlmErrorKind, boolean> = {
  auth: false,
  rate_limit: true,
  network: true,
  server: true,
  client: false,
};

export class LlmRequestError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    kind: LlmErrorKind,
    message: string,
    options?: { retryable?: boolean; status?: number | null },
  ) {
    super(message);
    this.name = "LlmRequestError";
    this.kind = kind;
    this.retryable = options?.retryable ?? RETRYABLE[kind];
    this.status = options?.status ?? null;
  }
}

export function isLlmRequestError(error: unknown): error is LlmRequestError {
  return error instanceof LlmRequestError;
}

function clip(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

function providerMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string") return clip(error);
      if (error && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return clip(message);
      }
      if (typeof record.message === "string") return clip(record.message);
    }
  } catch {
    // Fall through to the raw body.
  }
  return clip(trimmed);
}

export function httpStatusError(status: number, body: string): LlmRequestError {
  const detail = providerMessage(body);
  const suffix = detail === "" ? "" : `：${detail}`;
  if (status === 401 || status === 403) {
    return new LlmRequestError("auth", `鉴权失败（HTTP ${status}）${suffix}`, {
      status,
    });
  }
  if (status === 408) {
    return new LlmRequestError("network", `请求超时${suffix}`, { status });
  }
  if (status === 429) {
    return new LlmRequestError("rate_limit", `请求被限流（HTTP 429）${suffix}`, {
      status,
    });
  }
  if (status >= 500) {
    return new LlmRequestError("server", `模型服务错误（HTTP ${status}）${suffix}`, {
      status,
    });
  }
  return new LlmRequestError("client", `请求被拒绝（HTTP ${status}）${suffix}`, {
    status,
  });
}

export function networkError(error: unknown): LlmRequestError {
  if (error instanceof LlmRequestError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new LlmRequestError("network", "请求超时");
  }
  const message = error instanceof Error ? error.message : "网络请求失败";
  return new LlmRequestError("network", `网络错误：${clip(message)}`);
}
