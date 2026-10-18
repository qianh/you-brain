import { LlmRequestError } from "./errors.js";
import { isRecord, joinUrl, jsonInstruction, postJson } from "./http.js";
import type { LlmPreset } from "./presets.js";
import { runConnectionTest, type LlmBackend, type LlmCompleteRequest } from "./types.js";

export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_JSON_TOOL = "emit_json";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicBackendOptions {
  preset: LlmPreset;
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

function readAnthropicContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    throw new LlmRequestError("server", "模型返回无法解析");
  }
  for (const block of payload.content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    if (block.input === undefined) continue;
    return typeof block.input === "string" ? block.input : JSON.stringify(block.input);
  }
  const text = payload.content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("");
  if (text.trim() === "") throw new LlmRequestError("server", "模型返回为空");
  return text;
}

export function createAnthropicBackend(options: AnthropicBackendOptions): LlmBackend {
  const backend: LlmBackend = {
    id: options.preset.provider,
    descriptor: {
      provider: options.preset.provider,
      kind: "anthropic",
      model: options.model,
      baseUrl: options.baseUrl,
      jsonMode: "tool_use",
      requiresApiKey: true,
    },
    async complete(request: LlmCompleteRequest): Promise<string> {
      if (options.apiKey.trim() === "") {
        throw new LlmRequestError("auth", "缺少 API Key（you-brain/llm/claude）");
      }
      const system = request.jsonSchema
        ? `${request.system}${jsonInstruction(request.jsonSchema)}\n如果无法调用工具，只输出符合 schema 的 JSON。`
        : request.system;
      const body: Record<string, unknown> = {
        model: options.model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: request.user }],
      };
      if (request.jsonSchema) {
        body.tools = [
          {
            name: ANTHROPIC_JSON_TOOL,
            description: "Return the result as JSON matching the schema.",
            input_schema: request.jsonSchema,
          },
        ];
        body.tool_choice = { type: "tool", name: ANTHROPIC_JSON_TOOL };
      }
      const payload = await postJson({
        url: joinUrl(options.baseUrl, "/v1/messages"),
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      return readAnthropicContent(payload);
    },
    test(): Promise<void> {
      return runConnectionTest((request) => backend.complete(request));
    },
  };
  return backend;
}
