import { LlmAbortError, isLlmAbortError, isLlmRequestError } from "../llm/errors.js";
import type { LlmBackend } from "../llm/types.js";
import { extractJson } from "../refine/parse.js";

export const DEFAULT_TRANSPORT_RETRY_DELAYS_MS = [2_000, 5_000] as const;
const MAX_FORMAT_RETRIES = 1;

export interface CompleteJsonWithRetryOptions {
  signal?: AbortSignal;
  /** Backoff delays (ms) for transport retries; length controls retry count. */
  retryDelaysMs?: readonly number[];
  /** Optional wrapper for the final error thrown when retries are exhausted. */
  wrapError?: (detail: string) => Error;
}

function isTransportRetryable(error: unknown): boolean {
  if (!isLlmRequestError(error)) return false;
  if (error.kind === "network" || error.kind === "rate_limit") return true;
  if (error.kind === "server" && error.status !== null && error.status >= 500) return true;
  return false;
}

function isNonRetryable(error: unknown): boolean {
  if (isLlmAbortError(error)) return true;
  if (isLlmRequestError(error) && !error.retryable) return true;
  return false;
}

function failureDetail(error: unknown, raw: string): string {
  const message = error instanceof Error ? error.message : "模型输出无法校验";
  const snippet = raw.trim().slice(0, 500);
  const text = snippet === "" ? message : `${message}\n上次输出：${snippet}`;
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new LlmAbortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Calls `llm.complete` with structured JSON parsing and separate retry budgets:
 * - Transport failures (network, 429, 5xx): retry with backoff without mutating the prompt.
 * - Non-retryable failures (401/403/404/400, abort): fail immediately.
 * - Output/format failures (invalid JSON, schema failure, empty response): retry once with correction feedback.
 */
export async function completeJsonWithRetry<T>(
  llm: LlmBackend,
  prompt: { system: string; user: string },
  jsonSchema: object,
  parse: (input: unknown) => T,
  options?: CompleteJsonWithRetryOptions,
): Promise<T> {
  const signal = options?.signal;
  const retryDelays = options?.retryDelaysMs ?? DEFAULT_TRANSPORT_RETRY_DELAYS_MS;
  let transportAttempt = 0;
  let formatAttempt = 0;
  let correctionDetail: string | null = null;
  let lastDetail = "模型输出无法校验";

  for (;;) {
    if (signal?.aborted) throw new LlmAbortError();
    const user =
      correctionDetail === null
        ? prompt.user
        : `${prompt.user}\n\n## 上次输出无法通过校验\n${correctionDetail}\n请只输出修正后的 JSON。`;
    let raw = "";
    try {
      raw = await llm.complete({
        system: prompt.system,
        user,
        jsonSchema,
        ...(signal === undefined ? {} : { signal }),
      });
      return parse(extractJson(raw));
    } catch (error) {
      if (isLlmAbortError(error) || signal?.aborted) {
        throw isLlmAbortError(error) ? error : new LlmAbortError();
      }
      lastDetail = failureDetail(error, raw);
      if (isNonRetryable(error)) {
        throw options?.wrapError ? options.wrapError(lastDetail) : error;
      }
      if (isTransportRetryable(error)) {
        if (transportAttempt < retryDelays.length) {
          const delayMs = retryDelays[transportAttempt] ?? 0;
          transportAttempt += 1;
          await waitWithSignal(delayMs, signal);
          continue;
        }
        throw options?.wrapError ? options.wrapError(lastDetail) : error;
      }
      if (formatAttempt < MAX_FORMAT_RETRIES) {
        formatAttempt += 1;
        correctionDetail = lastDetail;
        continue;
      }
      throw options?.wrapError ? options.wrapError(lastDetail) : new Error(lastDetail);
    }
  }
}
