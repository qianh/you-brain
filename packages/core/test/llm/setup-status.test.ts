import { describe, expect, it } from "bun:test";

import { LlmRequestError } from "../../src/llm/errors.js";
import { cliUnresponsiveWarning, describeLlmSetupFailure } from "../../src/llm/setup-status.js";

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
        new LlmRequestError("auth", "未登录 claude。请运行 claude（交互里 /login）"),
      ),
    ).toEqual({
      code: "LLM_CLI_UNAUTHENTICATED",
      message: "claude 未登录，已上传会话但跳过提炼。请运行 claude（交互里 /login）",
    });
    expect(
      describeLlmSetupFailure("gemini-cli", new Error("未登录 gemini。请运行 gemini（交互里完成登录）")),
    ).toEqual({
      code: "LLM_CLI_UNAUTHENTICATED",
      message: "gemini 未登录，已上传会话但跳过提炼。请运行 gemini（交互里完成登录）",
    });
    expect(cliUnresponsiveWarning("gemini-cli")).toEqual({
      code: "LLM_CLI_UNRESPONSIVE",
      message: "gemini 没有响应，已上传会话但跳过提炼。请运行 gemini（交互里完成登录） 检查登录",
    });
    expect(cliUnresponsiveWarning("deepseek")).toBeNull();
    expect(describeLlmSetupFailure("custom", new LlmRequestError("client", "未配置模型地址"))).toEqual({
      code: "LLM_UNAVAILABLE",
      message: "未配置模型地址",
    });
  });
});
