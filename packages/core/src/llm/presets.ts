import type { LlmProvider } from "@you-brain/protocol";

export type LlmApiKind = "openai-compatible" | "anthropic" | "cli";

/**
 * json_schema is only used where the vendor documents strict structured
 * outputs. Other OpenAI-compatible presets degrade to json_object.
 * Claude uses the Messages API tool_use channel instead of response_format.
 */
export type LlmJsonMode = "json_schema" | "json_object" | "tool_use";

export interface LlmPreset {
  provider: LlmProvider;
  label: string;
  kind: LlmApiKind;
  baseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
  jsonMode: LlmJsonMode;
}

export const LLM_KEYCHAIN_PREFIX = "you-brain/llm/";

export function llmKeychainAccount(provider: LlmProvider): string {
  return `${LLM_KEYCHAIN_PREFIX}${provider}`;
}

/**
 * Base URLs and default models follow each vendor's current docs
 * (checked 2026-10): DeepSeek first-call page, 智谱 OpenAI 兼容,
 * 百炼 compatible-mode（北京，无需 WorkspaceId 的 dashscope 域名）,
 * Kimi OpenAI Chat Completions, OpenAI platform, Ollama local /v1.
 * Ollama has no single bundled model; llama3.2 is the local name in
 * the compatibility doc's default-model section.
 * kimi-k2.6 is the current general model that can answer without
 * forced reasoning; kimi-k3 always reasons.
 */
export const LLM_PRESETS = {
  deepseek: {
    provider: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash",
    requiresApiKey: true,
    jsonMode: "json_object",
  },
  glm: {
    provider: "glm",
    label: "GLM",
    kind: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.3",
    requiresApiKey: true,
    jsonMode: "json_object",
  },
  qwen: {
    provider: "qwen",
    label: "Qwen",
    kind: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    requiresApiKey: true,
    jsonMode: "json_object",
  },
  kimi: {
    provider: "kimi",
    label: "Kimi",
    kind: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.6",
    requiresApiKey: true,
    jsonMode: "json_object",
  },
  openai: {
    provider: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    requiresApiKey: true,
    jsonMode: "json_schema",
  },
  claude: {
    provider: "claude",
    label: "Claude",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-5-5",
    requiresApiKey: true,
    jsonMode: "tool_use",
  },
  ollama: {
    provider: "ollama",
    label: "Ollama",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "llama3.2",
    requiresApiKey: false,
    jsonMode: "json_object",
  },
  custom: {
    provider: "custom",
    label: "Custom",
    kind: "openai-compatible",
    baseUrl: "",
    defaultModel: "",
    requiresApiKey: true,
    jsonMode: "json_object",
  },
  "grok-cli": {
    provider: "grok-cli",
    label: "Grok（本机订阅）",
    kind: "cli",
    baseUrl: "",
    defaultModel: "",
    requiresApiKey: false,
    jsonMode: "json_schema",
  },
  "claude-cli": {
    provider: "claude-cli",
    label: "Claude Code（本机订阅）",
    kind: "cli",
    baseUrl: "",
    defaultModel: "",
    requiresApiKey: false,
    jsonMode: "json_schema",
  },
  "codex-cli": {
    provider: "codex-cli",
    label: "Codex（本机订阅）",
    kind: "cli",
    baseUrl: "",
    defaultModel: "",
    requiresApiKey: false,
    jsonMode: "json_schema",
  },
  "gemini-cli": {
    provider: "gemini-cli",
    label: "Gemini CLI（本机订阅）",
    kind: "cli",
    baseUrl: "",
    defaultModel: "",
    requiresApiKey: false,
    jsonMode: "json_object",
  },
  "opencode-cli": {
    provider: "opencode-cli",
    label: "OpenCode（本机订阅）",
    kind: "cli",
    baseUrl: "",
    defaultModel: "",
    requiresApiKey: false,
    jsonMode: "json_object",
  },
} as const satisfies Record<LlmProvider, LlmPreset>;
