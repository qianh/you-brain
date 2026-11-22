import type { LlmBackend } from "../../llm/types.js";
import type { TelegramRouteCandidate } from "./relay.js";

/** 判断：这句话是回候选里的哪一条。返回候选下标（从 0 起）；拿不准返回 null。 */
export type TelegramRouteJudge = (input: { text: string; candidates: TelegramRouteCandidate[]; now: number }) => Promise<number | null>;

/** 已经问过用户「是哪一条」后，等用户回序号的时间。 */
export const PENDING_CHOICE_TTL_MS = 10 * 60_000;
const JUDGE_TIMEOUT_MS = 45_000;

const JUDGE_SYSTEM = [
  "你是 U-Brain 的消息路由器。用户在手机上给几台电脑上正在干活的 AI 会话发了一句话，但没有指明是回哪一条提醒。",
  "下面给出最近的提醒清单（序号从 1 起，新的在前）和用户这句话，判断这句话是在回复哪一条。",
  "规则：",
  "- 只有内容明确指向某一条（提到了它的任务、设备、文件、问题，或是对它那个问题的回答）才选它。",
  "- 像「收到」「好」「继续」「谢谢」这类通用的话，而清单里不止一条时，不能选，输出 null。",
  "- 拿不准时输出 null，宁可让用户选，也不要猜错发到别的会话里。",
  '只输出一行 JSON：{"choice": 序号或null}，不要任何解释。',
].join("\n");

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}

export function buildJudgeUser(input: { text: string; candidates: TelegramRouteCandidate[]; now: number }): string {
  const lines = input.candidates.map(
    (candidate, index) => `${index + 1}. [${candidate.deviceName}，${ago(input.now - candidate.at)}] ${candidate.preview}`,
  );
  return [`提醒清单：`, ...lines, "", `用户这句话：${input.text}`].join("\n");
}

/** 从模型输出里取出序号（1 起）并转成下标；越界、null、解析失败都当拿不准。 */
export function parseJudgeChoice(raw: string, count: number): number | null {
  const match = /\{[^{}]*\}/u.exec(raw);
  if (!match) return null;
  let value: unknown;
  try {
    value = (JSON.parse(match[0]) as { choice?: unknown }).choice;
  } catch {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > count) return null;
  return value - 1;
}

/** 用 daemon 的 LLM 做判断；没有可用的模型、超时、出错都当拿不准，让上层去问用户。 */
export function createLlmRouteJudge(getBackend: () => Promise<Pick<LlmBackend, "complete"> | null>): TelegramRouteJudge {
  return async (input) => {
    try {
      const backend = await getBackend();
      if (!backend) return null;
      const raw = await backend.complete({ system: JUDGE_SYSTEM, user: buildJudgeUser(input), timeoutMs: JUDGE_TIMEOUT_MS });
      return parseJudgeChoice(raw, input.candidates.length);
    } catch (error) {
      console.error(`[telegram] 路由判断出错：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
}

/** 让用户选的那条消息：列出候选，回序号即可。 */
export function formatChoiceList(candidates: TelegramRouteCandidate[]): string {
  const lines = candidates.map((candidate, index) => `${index + 1}. ${candidate.deviceName}：${candidate.preview}`);
  return ["这句话是回哪一条？回序号就行（10 分钟内有效）：", ...lines].join("\n");
}

/** 用户回的是不是一个序号：「2」「选2」「第 2 个」「2号」都认；超出范围返回 null。 */
export function parseChoiceReply(text: string, count: number): number | null {
  const match = /^(?:选|第)?\s*(\d{1,2})\s*(?:个|条|号|项)?[.。!！]?$/u.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 1 && value <= count ? value - 1 : null;
}
