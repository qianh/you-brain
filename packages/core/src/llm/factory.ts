import type { LlmProvider, SharedConfig } from "@you-brain/protocol";

import { createAnthropicBackend } from "./anthropic.js";
import { createCliBackend } from "./cli/backend.js";
import { LlmRequestError } from "./errors.js";
import { createOpenAiCompatibleBackend } from "./openai-compatible.js";
import { LLM_PRESETS, llmKeychainAccount, type LlmPreset } from "./presets.js";
import type { LlmBackend } from "./types.js";

export type LlmSelection = Pick<SharedConfig["llm"], "provider" | "model" | "baseUrl">;

export type GetApiKey = (
  provider: LlmProvider,
) => string | null | undefined | Promise<string | null | undefined>;

export interface CreateLlmBackendOptions {
  config: LlmSelection;
  getApiKey: GetApiKey;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Data directory used to place the subscription CLI cwd at `<dataDir>/llm-cli`. */
  dataDir?: string;
  /** Lookup and child environment. PATH is not taken from `process.env` when this is set. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Test injection. Authoritative executable path for a CLI provider. */
  cliBin?: string;
  signal?: AbortSignal;
}

export interface ResolvedLlmTarget {
  preset: LlmPreset;
  model: string;
  baseUrl: string;
}

export function resolveLlmTarget(config: LlmSelection): ResolvedLlmTarget {
  const preset = LLM_PRESETS[config.provider];
  if (preset.kind === "cli") {
    return {
      preset,
      model: config.model.trim(),
      baseUrl: config.baseUrl.trim().replace(/\/+$/u, ""),
    };
  }
  const model = config.model.trim() || preset.defaultModel;
  const baseUrl = (config.baseUrl.trim() || preset.baseUrl).replace(/\/+$/u, "");
  if (model === "") {
    throw new LlmRequestError("client", "未配置模型名");
  }
  if (baseUrl === "") {
    throw new LlmRequestError("client", "未配置模型地址");
  }
  return { preset, model, baseUrl };
}

async function readApiKey(provider: LlmProvider, getApiKey: GetApiKey): Promise<string> {
  const value = await getApiKey(provider);
  const key = typeof value === "string" ? value.trim() : "";
  if (key === "") {
    throw new LlmRequestError(
      "auth",
      `缺少 API Key（${llmKeychainAccount(provider)}）`,
    );
  }
  return key;
}

export async function createLlmBackend(
  options: CreateLlmBackendOptions,
): Promise<LlmBackend> {
  const target = resolveLlmTarget(options.config);
  if (target.preset.kind === "cli") {
    return createCliBackend({
      provider: target.preset.provider,
      model: target.model,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      ...(options.cliBin === undefined ? {} : { cliBin: options.cliBin }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  const shared = {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  if (target.preset.kind === "anthropic") {
    const apiKey = await readApiKey(target.preset.provider, options.getApiKey);
    return createAnthropicBackend({
      preset: target.preset,
      model: target.model,
      baseUrl: target.baseUrl,
      apiKey,
      ...shared,
    });
  }
  const apiKey = target.preset.requiresApiKey
    ? await readApiKey(target.preset.provider, options.getApiKey)
    : "";
  return createOpenAiCompatibleBackend({
    preset: target.preset,
    model: target.model,
    baseUrl: target.baseUrl,
    ...(apiKey === "" ? {} : { apiKey }),
    ...shared,
  });
}
