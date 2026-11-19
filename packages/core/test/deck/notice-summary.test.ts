import { describe, expect, it } from "bun:test";

import {
  buildNoticeSummaryPrompt,
  cleanNoticeScreen,
  cleanNoticeSummary,
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

  it("calls the model with a timeout and skips an empty screen with no status", async () => {
    const calls: Array<number | undefined> = [];
    const backend = {
      complete: async (request: { timeoutMs?: number }) => {
        calls.push(request.timeoutMs);
        return "打包成功，建议打开 App 确认。";
      },
    };
    expect(await summarizeNotice(backend, draft, "打包完成", 5_000)).toBe("打包成功，建议打开 App 确认。");
    expect(await summarizeNotice(backend, draft, "╭────╮\n", 5_000)).toBeNull();
    expect(calls).toEqual([5_000]);
  });
});
