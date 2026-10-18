import type { LlmProvider } from "@you-brain/protocol";

import { LlmRequestError } from "./errors.js";
import type { LlmApiKind, LlmJsonMode } from "./presets.js";

export interface LlmCompleteRequest {
  system: string;
  user: string;
  jsonSchema?: object;
}

export interface LlmBackendDescriptor {
  provider: LlmProvider;
  kind: LlmApiKind;
  model: string;
  baseUrl: string;
  jsonMode: LlmJsonMode;
  requiresApiKey: boolean;
}

export interface LlmBackend {
  readonly id: string;
  readonly descriptor: LlmBackendDescriptor;
  complete(request: LlmCompleteRequest): Promise<string>;
  test(): Promise<void>;
}

export const CLI_CONNECTION_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
} as const;

/** Whole reply is a CLI error log, not a model answer. */
export function looksLikeErrorOutput(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^(?:ERROR:|Error:|stream error:)/u.test(trimmed) ||
    /no last agent message/iu.test(trimmed) ||
    /unexpected status\s+\d{3}\b/iu.test(trimmed)
  );
}

export async function runConnectionTest(
  complete: LlmBackend["complete"],
): Promise<void> {
  const text = await complete({
    system: "Reply with exactly one lowercase word and nothing else.",
    user: "ok",
  });
  if (text.trim() === "") {
    throw new LlmRequestError("server", "模型返回为空");
  }
  if (looksLikeErrorOutput(text)) {
    throw new LlmRequestError("server", "模型返回了错误文本");
  }
}

/** CLI connection test: one tiny schema call, then require `{ ok: true }`. */
export async function runCliConnectionTest(
  complete: LlmBackend["complete"],
): Promise<void> {
  const text = await complete({
    system: "Reply with JSON only.",
    user: "Confirm connectivity.",
    jsonSchema: CLI_CONNECTION_SCHEMA,
  });
  if (looksLikeErrorOutput(text)) {
    throw new LlmRequestError("server", "连接测试返回了错误文本");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LlmRequestError("server", "连接测试返回的不是 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LlmRequestError("server", "连接测试返回的不是 JSON");
  }
  if ((parsed as { ok?: unknown }).ok !== true) {
    throw new LlmRequestError("server", "连接测试未通过");
  }
}
