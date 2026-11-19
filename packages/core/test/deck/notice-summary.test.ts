import { describe, expect, it } from "bun:test";

import {
  buildNoticeSummaryPrompt,
  cleanNoticeScreen,
  cleanNoticeSummary,
  parseNoticeSummary,
  summarizeNotice,
} from "../../src/deck/notice-summary.js";

const draft = {
  kind: "done" as const,
  sessionName: "you-brain",
  agent: "grok",
  cwd: "/Users/x/you-brain",
  body: "",
};

describe("notice summary", () => {
  it("drops ANSI escapes, blank lines and TUI box chrome from the screen", () => {
    const raw = [
      "\x1b[32m✓\x1b[0m 打包完成",
      "",
      "╭──────────────────────╮",
      "──────────────────────────…",
      "   │ ❯",
      "codesign 校验通过",
    ].join("\n");
    expect(cleanNoticeScreen(raw)).toBe(["✓ 打包完成", "codesign 校验通过"].join("\n"));
  });

  it("asks for a conclusion and advice, not the raw output", () => {
    const prompt = buildNoticeSummaryPrompt(draft, "打包完成");
    expect(prompt.system).toContain("不要复述或粘贴原始输出");
    expect(prompt.user).toContain("会话：you-brain（grok）");
    expect(prompt.user).toContain("打包完成");
    const waiting = buildNoticeSummaryPrompt({ ...draft, kind: "waiting", body: "继续吗？" }, "");
    expect(waiting.user).toContain("等用户回复");
    expect(waiting.user).toContain("会话自己报告的状态：继续吗？");
  });

  it("strips markdown from the model output and caps the length", () => {
    expect(cleanNoticeSummary("## 结论\n- **打包成功**\n- 建议重启 App\n")).toBe("结论\n打包成功\n建议重启 App");
    expect(cleanNoticeSummary("  \n ")).toBeNull();
    expect(cleanNoticeSummary("字".repeat(400))?.length).toBe(300);
  });

  it("splits the per-turn task name from the body", () => {
    expect(parseNoticeSummary("任务：修复 TODO 状态误标\n已改完，建议安装验证。")).toEqual({ task: "修复 TODO 状态误标", body: "已改完，建议安装验证。" });
    expect(parseNoticeSummary("**任务：「多巴胺配色」**\n已完成。")).toEqual({ task: "多巴胺配色", body: "已完成。" });
    expect(parseNoticeSummary("任务：未知\n看不出结果。")).toEqual({ task: null, body: "看不出结果。" });
    expect(parseNoticeSummary("没按格式写的正文")).toEqual({ task: null, body: "没按格式写的正文" });
    expect(parseNoticeSummary(`任务：${"长".repeat(30)}\n正文`)?.task).toHaveLength(16);
    expect(parseNoticeSummary("任务：只有任务名")).toBeNull();
  });

  it("calls the model with a timeout and skips an empty screen with no status", async () => {
    const calls: Array<number | undefined> = [];
    const backend = {
      complete: async (request: { timeoutMs?: number }) => {
        calls.push(request.timeoutMs);
        return "任务：打包安装 U-Brain\n打包成功，建议打开 App 确认。";
      },
    };
    expect(await summarizeNotice(backend, draft, "打包完成", 5_000)).toEqual({ task: "打包安装 U-Brain", body: "打包成功，建议打开 App 确认。" });
    expect(await summarizeNotice(backend, draft, "╭────╮\n", 5_000)).toBeNull();
    expect(calls).toEqual([5_000]);
  });
});
