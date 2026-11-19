import type { LlmBackend } from "../llm/types.js";
import type { SessionNoticeDraft } from "./session-notices.js";

/**
 * 终端会话提醒的正文：把会话停下时的屏幕交给模型，写成给用户看的结论和建议，
 * 而不是把原始终端输出原样丢给用户。
 */

const ANSI_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/gu;
/** 只剩线框、分隔符、提示符的行（TUI 输入框边框等），对分析没用。 */
const CHROME_LINE = /^[\s─-╿▀-▟│|>❯›»$%#*·•…\-_=+~.]*$/u;
const SCREEN_CHAR_MAX = 8_000;
const SUMMARY_CHAR_MAX = 300;

/** 去掉控制符、空行和纯线框行，只保留末尾一段。 */
export function cleanNoticeScreen(raw: string): string {
  const lines = raw
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => line.trim() !== "" && !CHROME_LINE.test(line));
  const text = lines.join("\n");
  return text.length > SCREEN_CHAR_MAX ? text.slice(text.length - SCREEN_CHAR_MAX) : text;
}

export function buildNoticeSummaryPrompt(
  draft: Pick<SessionNoticeDraft, "kind" | "sessionName" | "agent" | "cwd" | "body">,
  screen: string,
): { system: string; user: string } {
  const state =
    draft.kind === "waiting"
      ? "它停下来在等用户回复或确认"
      : "它刚执行完一轮任务";
  const system = [
    "你是用户的终端助理。用户同时开着很多终端会话，某个会话停下来时由你写一条提醒。",
    "根据会话屏幕内容，用中文写给用户看的结论，不要复述或粘贴原始输出、命令、日志、线框。",
    "已完成：说清楚做成了什么、结果如何（成功/失败/部分完成），有失败或需要用户验证的地方点出来，最后给一句建议的下一步。",
    "等待回复：说清楚它在问什么、有哪些选项，并给出你的建议选择和理由。",
    "屏幕信息不足以判断时，如实说明看不出结果，并建议用户打开终端查看。",
    `纯文本，不用 Markdown，不加标题和前缀，总共不超过 ${SUMMARY_CHAR_MAX / 2} 个汉字左右，两三句话。`,
  ].join("\n");
  const head = [
    `会话：${draft.sessionName}${draft.agent ? `（${draft.agent}）` : ""}`,
    draft.cwd ? `目录：${draft.cwd}` : null,
    `状态：${state}`,
    draft.body.trim() !== "" ? `会话自己报告的状态：${draft.body.trim()}` : null,
  ].filter((line): line is string => line !== null);
  const user = `${head.join("\n")}\n\n屏幕末尾内容：\n${screen === "" ? "（空）" : screen}`;
  return { system, user };
}

/** 模型输出清理：去掉 Markdown 记号和多余空白，过长截断。空输出返回 null。 */
export function cleanNoticeSummary(raw: string): string | null {
  const text = raw
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/^#+\s*/gmu, "")
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/^\s*[-*]\s+/gmu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
  if (text === "") return null;
  return text.length > SUMMARY_CHAR_MAX ? `${text.slice(0, SUMMARY_CHAR_MAX - 1)}…` : text;
}

export async function summarizeNotice(
  backend: Pick<LlmBackend, "complete">,
  draft: Pick<SessionNoticeDraft, "kind" | "sessionName" | "agent" | "cwd" | "body">,
  rawScreen: string,
  timeoutMs: number,
): Promise<string | null> {
  const screen = cleanNoticeScreen(rawScreen);
  if (screen === "" && draft.body.trim() === "") return null;
  const prompt = buildNoticeSummaryPrompt(draft, screen);
  const raw = await backend.complete({ ...prompt, timeoutMs });
  return cleanNoticeSummary(raw);
}
