import { LlmRequestError } from "./errors.js";
import { isRecord, joinUrl, jsonInstruction, postJson } from "./http.js";
import type { LlmPreset } from "./presets.js";
import { runConnectionTest, type LlmBackend, type LlmCompleteRequest } from "./types.js";

export interface OpenAiCompatibleOptions {
  preset: LlmPreset;
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function responseFormat(
  jsonSchema: object | undefined,
  mode: LlmPreset["jsonMode"],
): Record<string, unknown> | undefined {
  if (!jsonSchema || mode === "tool_use") return undefined;
  if (mode === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: jsonSchema,
      },
    };
  }
  return { type: "json_object" };
}

function readTextContent(content: unknown): string {
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

function readChatContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new LlmRequestError("server", "模型返回为空");
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new LlmRequestError("server", "模型返回为空");
  }
  const text = readTextContent(choice.message.content);
  if (text.trim() === "") throw new LlmRequestError("server", "模型返回为空");
  return text;
}

export function createOpenAiCompatibleBackend(
  options: OpenAiCompatibleOptions,
): LlmBackend {
  const jsonMode = options.preset.jsonMode === "tool_use" ? "json_object" : options.preset.jsonMode;
  const backend: LlmBackend = {
    id: options.preset.provider,
    descriptor: {
      provider: options.preset.provider,
      kind: "openai-compatible",
      model: options.model,
      baseUrl: options.baseUrl,
      jsonMode,
      requiresApiKey: options.preset.requiresApiKey,
    },
    async complete(request: LlmCompleteRequest): Promise<string> {
      const format = responseFormat(request.jsonSchema, jsonMode);
      const system = request.jsonSchema
        ? `${request.system}${jsonInstruction(request.jsonSchema)}`
        : request.system;
      const body: Record<string, unknown> = {
        model: options.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: request.user },
        ],
      };
      if (format) body.response_format = format;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      const payload = await postJson({
        url: joinUrl(options.baseUrl, "/chat/completions"),
        headers,
        body,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      return readChatContent(payload);
    },
    test(): Promise<void> {
      return runConnectionTest((request) => backend.complete(request));
    },
  };
  return backend;
}
