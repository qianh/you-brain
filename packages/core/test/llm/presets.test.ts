import { describe, expect, it } from "bun:test";
import { LLM_PROVIDERS } from "@you-brain/protocol";

import { LLM_PRESETS, llmKeychainAccount } from "../../src/llm/presets.js";

describe("llm presets", () => {
  it("covers every provider with the documented base URL and default model", () => {
    expect(Object.keys(LLM_PRESETS).sort()).toEqual([...LLM_PROVIDERS].sort());
    expect(LLM_PRESETS.deepseek).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-flash",
      kind: "openai-compatible",
      jsonMode: "json_object",
      requiresApiKey: true,
    });
    expect(LLM_PRESETS.glm).toMatchObject({
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultModel: "glm-5.3",
    });
    expect(LLM_PRESETS.qwen).toMatchObject({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen-plus",
    });
    expect(LLM_PRESETS.kimi).toMatchObject({
      baseUrl: "https://api.moonshot.cn/v1",
      defaultModel: "kimi-k2.6",
    });
    expect(LLM_PRESETS.openai).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.4",
      jsonMode: "json_schema",
    });
    expect(LLM_PRESETS.claude).toMatchObject({
      baseUrl: "https://api.anthropic.com",
      defaultModel: "claude-sonnet-5-5",
      kind: "anthropic",
      jsonMode: "tool_use",
    });
    expect(LLM_PRESETS.ollama).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "llama3.2",
      requiresApiKey: false,
      jsonMode: "json_object",
    });
    expect(LLM_PRESETS.custom).toMatchObject({
      baseUrl: "",
      defaultModel: "",
      requiresApiKey: true,
      jsonMode: "json_object",
    });
  });

  it("names keychain accounts you-brain/llm/<provider>", () => {
    expect(llmKeychainAccount("deepseek")).toBe("you-brain/llm/deepseek");
    expect(llmKeychainAccount("claude")).toBe("you-brain/llm/claude");
    expect(llmKeychainAccount("ollama")).toBe("you-brain/llm/ollama");
  });
});
