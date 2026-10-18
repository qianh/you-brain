import { LlmRequestError, type LlmErrorKind } from "../errors.js";
import { redactSecrets } from "./exec.js";

const MODEL_HINT = "（可在模型名里指定该账号支持的模型）";

/** CLI logs that mean the process failed even when the exit code is 0. */
export function isCliFailureLog(text: string): boolean {
  return (
    /(?:^|\n)\s*(?:ERROR:|stream error:)/u.test(text) ||
    /no last agent message/iu.test(text) ||
    /unexpected status\s+\d{3}\b/iu.test(text)
  );
}

export function recordErrorMessage(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  const error = record.error ?? record.error_message;
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const object = error as Record<string, unknown>;
    for (const key of ["message", "detail", "error"]) {
      const value = object[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  return null;
}

function quotedField(blob: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u").exec(blob);
  const raw = match?.[1];
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(`"${raw}"`) as unknown;
    return typeof parsed === "string" && parsed.trim() !== "" ? parsed.trim() : null;
  } catch {
    return raw.trim() === "" ? null : raw.trim();
  }
}

function extractDetail(blob: string): string {
  const detail = quotedField(blob, "detail") ?? quotedField(blob, "message");
  if (detail) return detail;
  for (const line of blob.split("\n")) {
    const match = /(?:^|\s)ERROR:\s*(.+)$/iu.exec(line.trim());
    const rest = match?.[1]?.replace(/;?\s*retrying\s+\d+\/\d+.*$/iu, "").trim();
    if (rest) return rest;
  }
  if (/no last agent message/iu.test(blob)) return "no last agent message";
  return "没有返回内容";
}

function extractHttpStatus(blob: string): number | null {
  const explicit = /unexpected status\s+(\d{3})\b/iu.exec(blob);
  if (explicit?.[1]) return Number(explicit[1]);
  const http = /\bHTTP\/\d+(?:\.\d+)?\s+(\d{3})\b/iu.exec(blob);
  if (http?.[1]) return Number(http[1]);
  return null;
}

export function classifyCliStatus(status: number | null, blob: string): LlmErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "network";
  if (status === 429) return "rate_limit";
  if (status !== null && status >= 500) return "server";
  if (status !== null && status >= 400) return "client";
  if (
    /ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|fetch failed|connection reset/iu.test(
      blob,
    )
  ) {
    return "network";
  }
  return "server";
}

/**
 * Exit code 0 with an empty or log-only payload. Codex names the failure
 * directly; other CLIs share the same status classification.
 */
export function cliProcessFailure(
  source: "codex" | "cli",
  stdout: string,
  stderr: string,
  secrets: readonly string[],
): LlmRequestError {
  const blob = `${stdout}\n${stderr}`;
  const detail = redactSecrets(extractDetail(blob), secrets);
  const status = extractHttpStatus(blob);
  const kind = classifyCliStatus(status, blob);
  const message =
    source === "codex"
      ? `codex 调用失败：${detail}${kind === "client" ? MODEL_HINT : ""}`
      : `命令执行失败（退出码 0）：${detail}`;
  return new LlmRequestError(kind, message, { status });
}
