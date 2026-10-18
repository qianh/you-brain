import type { LlmProvider } from "@you-brain/protocol";

import { cliCommandName, cliLoginCommand, isCliProvider } from "./cli/locate.js";
import { isLlmRequestError } from "./errors.js";

export interface LlmSetupWarning {
  code: "LLM_NOT_CONFIGURED" | "LLM_CLI_MISSING" | "LLM_CLI_UNAUTHENTICATED" | "LLM_UNAVAILABLE";
  message: string;
}

const NOT_CONFIGURED: LlmSetupWarning = {
  code: "LLM_NOT_CONFIGURED",
  message: "未配置模型，已上传会话但跳过提炼",
};

/** Turn a backend-creation or login failure into a status warning. */
export function describeLlmSetupFailure(provider: LlmProvider, error: unknown): LlmSetupWarning {
  const text = error instanceof Error ? error.message : "";
  const auth = isLlmRequestError(error) && error.kind === "auth";
  if (isCliProvider(provider)) {
    const command = cliCommandName(provider);
    if (text.includes("未找到") && text.includes("命令行")) {
      return {
        code: "LLM_CLI_MISSING",
        message: `未找到 ${command} 命令行，已上传会话但跳过提炼`,
      };
    }
    if (auth || text.includes("未登录")) {
      return {
        code: "LLM_CLI_UNAUTHENTICATED",
        message: `${command} 未登录，已上传会话但跳过提炼。请运行 ${cliLoginCommand(provider)}`,
      };
    }
  }
  if (auth || text.includes("缺少 API Key") || text.trim() === "") return NOT_CONFIGURED;
  return { code: "LLM_UNAVAILABLE", message: text.trim() };
}
