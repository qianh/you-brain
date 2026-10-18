import { describe, expect, it } from "bun:test";

import { LlmRequestError } from "../../src/llm/errors.js";
import { describeLlmSetupFailure } from "../../src/llm/setup-status.js";

describe("llm setup status", () => {
  it("keeps the missing-key warning and names a missing or logged-out CLI", () => {
    expect(
      describeLlmSetupFailure(
        "deepseek",
        new LlmRequestError("auth", "缺少 API Key（you-brain/llm/deepseek）"),
      ),
    ).toEqual({
      code: "LLM_NOT_CONFIGURED",
      message: "未配置模型，已上传会话但跳过提炼",
    });
    expect(
      describeLlmSetupFailure(
        "codex-cli",
        new LlmRequestError("client", "未找到 codex 命令行，请先安装并登录"),
      ),
    ).toEqual({
      code: "LLM_CLI_MISSING",
      message: "未找到 codex 命令行，已上传会话但跳过提炼",
    });
    expect(
      describeLlmSetupFailure(
        "claude-cli",
        new LlmRequestError("auth", "未登录 claude。请运行 claude auth login"),
      ),
    ).toEqual({
      code: "LLM_CLI_UNAUTHENTICATED",
      message: "claude 未登录，已上传会话但跳过提炼。请运行 claude auth login",
    });
    expect(
      describeLlmSetupFailure("gemini-cli", new Error("未登录 gemini。请先运行 gemini 并执行 /auth 登录")),
    ).toEqual({
      code: "LLM_CLI_UNAUTHENTICATED",
      message: "gemini 未登录，已上传会话但跳过提炼。请运行 gemini 并执行 /auth",
    });
    expect(describeLlmSetupFailure("custom", new LlmRequestError("client", "未配置模型地址"))).toEqual({
      code: "LLM_UNAVAILABLE",
      message: "未配置模型地址",
    });
  });
});
