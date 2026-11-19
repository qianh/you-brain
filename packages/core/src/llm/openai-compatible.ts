import { LlmRequestError } from "./errors.js";
import {
  joinUrl,
  jsonInstruction,
  postJson,
  postSseChat,
  readChatCompletionContent,
} from "./http.js";
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

const STREAM_FALLBACK_STATUSES = new Set([400, 415, 422]);

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

export function createOpenAiCompatibleBackend(
  options: OpenAiCompatibleOptions,
): LlmBackend {
  const jsonMode = options.preset.jsonMode === "tool_use" ? "json_object" : options.preset.jsonMode;
  let streamUnsupported = false;

  const buildRequest = (request: LlmCompleteRequest) => {
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
    return {
      url: joinUrl(options.baseUrl, "/chat/completions"),
      headers,
      body,
      timeoutMs: request.timeoutMs ?? options.timeoutMs,
    };
  };

  const runNonStream = async (request: LlmCompleteRequest): Promise<string> => {
    const built = buildRequest(request);
    const payload = await postJson({
      url: built.url,
      headers: built.headers,
      body: built.body,
      ...(built.timeoutMs === undefined ? {} : { timeoutMs: built.timeoutMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    return readChatCompletionContent(payload);
  };

  const runStream = async (
    request: LlmCompleteRequest,
    onDelta?: (cumulative: string) => void,
  ): Promise<string> => {
    if (streamUnsupported) {
      const text = await runNonStream(request);
      onDelta?.(text);
      return text;
    }
    const built = buildRequest(request);
    try {
      return await postSseChat({
        url: built.url,
        headers: built.headers,
        body: { ...built.body, stream: true },
        ...(built.timeoutMs === undefined ? {} : { timeoutMs: built.timeoutMs }),
        ...(request.firstChunkTimeoutMs === undefined
          ? {}
          : { firstChunkTimeoutMs: request.firstChunkTimeoutMs }),
        ...(request.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: request.idleTimeoutMs }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(onDelta === undefined ? {} : { onDelta }),
      });
    } catch (error) {
      if (
        error instanceof LlmRequestError &&
        error.status !== null &&
        STREAM_FALLBACK_STATUSES.has(error.status)
      ) {
        streamUnsupported = true;
        const text = await runNonStream(request);
        onDelta?.(text);
        return text;
      }
      throw error;
    }
  };

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
      if (request.stream === true) {
        return runStream(request);
      }
      return runNonStream(request);
    },
    async completeStream(
      request: LlmCompleteRequest,
      onDelta: (cumulative: string) => void,
    ): Promise<string> {
      return runStream(request, onDelta);
    },
    test(): Promise<void> {
      return runConnectionTest((request) => backend.complete(request));
    },
  };
  return backend;
}
