import {
  MERGE_SUGGESTIONS_JSON_SCHEMA,
  PORTRAIT_JSON_SCHEMA,
  TOPIC_SUMMARY_JSON_SCHEMA,
} from "./schema.js";
import { clipUnits, textUnits } from "./text.js";

export const TOPIC_SUMMARY_SYSTEM_PROMPT = `你是 you-brain 的话题沉淀器。根据这个话题当天的变化，重写话题概要和下一步。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. summary 用中文，不超过 200 字，把当天新的结论整合进现有概要，不要逐条罗列会话。
2. nextStep 用中文，不超过 80 字，写现在最值得做的一件事。没有明确下一步时输出空字符串。
3. 不要编造输入里没有的事实。
4. JSON 键名保持英文。`;

export const MERGE_SUGGESTIONS_SYSTEM_PROMPT = `你是 you-brain 的话题整理器。下面是活跃区和历史区的话题。只找出高度重复、看起来是同一件事的话题对，并给出合并建议。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. pairs 最多 5 对。没有高度重复的就输出空数组。
2. fromTopicId 和 intoTopicId 必须是输入里给出的 topicId，不能相同。
3. 不要重复同一对。
4. reason 用中文短句，不超过 80 字，说明为什么它们是同一件事。
5. JSON 键名保持英文。`;

export interface SummaryPromptSession {
  title: string;
  summary: string;
  conclusions: readonly string[];
}

export interface SummaryPromptInput {
  day: string;
  name: string;
  aliases: readonly string[];
  summary: string;
  nextStep: string;
  sessions: readonly SummaryPromptSession[];
  openTodos: readonly string[];
}

export interface MergePromptTopic {
  topicId: string;
  name: string;
  aliases: readonly string[];
  summary: string;
  zone: "active" | "history";
}

const PROMPT_CLIP = 500;

function line(value: string): string {
  const text = clipUnits(value.replace(/[\r\n]+/gu, " ").trim(), PROMPT_CLIP);
  return text === "" ? "（无）" : text;
}

export function buildTopicSummaryPrompt(input: SummaryPromptInput): { system: string; user: string } {
  const aliases = input.aliases.length === 0 ? "（无）" : input.aliases.map(line).join("、");
  const sessions =
    input.sessions.length === 0
      ? "（无）"
      : input.sessions
          .map((session, index) => {
            const conclusions =
              session.conclusions.length === 0
                ? "（无）"
                : session.conclusions.map((item) => `- ${line(item)}`).join("\n");
            return [
              `### 会话 ${index + 1}`,
              `标题：${line(session.title)}`,
              `概要：${line(session.summary)}`,
              "新增结论：",
              conclusions,
            ].join("\n");
          })
          .join("\n\n");
  const todos =
    input.openTodos.length === 0
      ? "（无）"
      : input.openTodos.map((item) => `- ${line(item)}`).join("\n");
  const user = [
    `日期：${input.day}`,
    `话题：${line(input.name)}`,
    `别名：${aliases}`,
    `当前概要：${line(input.summary)}`,
    `当前下一步：${line(input.nextStep)}`,
    "",
    "## 最近会话",
    sessions,
    "",
    "## 开放待办",
    todos,
    "",
    "## 输出 JSON schema",
    JSON.stringify(TOPIC_SUMMARY_JSON_SCHEMA),
  ].join("\n");
  return { system: TOPIC_SUMMARY_SYSTEM_PROMPT, user };
}

export function buildMergeSuggestionsPrompt(input: {
  day: string;
  topics: readonly MergePromptTopic[];
}): { system: string; user: string } {
  const topics =
    input.topics.length === 0
      ? "（无）"
      : input.topics
          .map((topic) => {
            const aliases = topic.aliases.length === 0 ? "（无）" : topic.aliases.map(line).join("、");
            return [
              `- topicId: ${topic.topicId}`,
              `  区域：${topic.zone === "active" ? "活跃" : "历史"}`,
              `  名称：${line(topic.name)}`,
              `  别名：${aliases}`,
              `  概要：${line(topic.summary)}`,
            ].join("\n");
          })
          .join("\n");
  const user = [
    `日期：${input.day}`,
    "## 话题",
    topics,
    "",
    "## 输出 JSON schema",
    JSON.stringify(MERGE_SUGGESTIONS_JSON_SCHEMA),
  ].join("\n");
  return { system: MERGE_SUGGESTIONS_SYSTEM_PROMPT, user };
}

export const PORTRAIT_SYSTEM_PROMPT = `你是 you-brain 的数字分身维护者。根据当天的话题变化和尚未应用的纠正，决定是否更新 full 变体。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. 保持原有结构、标题、格式和语气。
2. 只在当天证据支持的地方增改，不要凭空编造。
3. 每条纠正都必须体现在新文本里。
4. 与当天无关的内容原样保留。
5. 没有值得更新的内容时 changed 为 false，portrait 可以是空字符串。
6. changed 为 true 时 portrait 是完整的新文本，不是差异片段。
7. JSON 键名保持英文。`;

export interface PortraitPromptTopic {
  name: string;
  summary: string;
  titles: readonly string[];
  conclusions: readonly string[];
}

export interface PortraitPromptCorrection {
  correctionId: string;
  section: string;
  text: string;
}

export interface PortraitPromptInput {
  day: string;
  current: string;
  topics: readonly PortraitPromptTopic[];
  corrections: readonly PortraitPromptCorrection[];
}

const PORTRAIT_NAME_CLIP = 80;
const PORTRAIT_SUMMARY_CLIP = 400;
const PORTRAIT_TITLE_CLIP = 80;
const PORTRAIT_CONCLUSION_CLIP = 160;
const PORTRAIT_SECTION_CLIP = 40;
const PORTRAIT_CORRECTION_CLIP = 240;
/** Cap on the day's evidence. The existing portrait is sent in full. */
export const PORTRAIT_EVIDENCE_LIMIT = 6_000;

export function buildPortraitPrompt(input: PortraitPromptInput): {
  system: string;
  user: string;
  includedCorrectionIds: string[];
} {
  const included = packCorrections(input.corrections);
  const correctionUnits = textUnits(included.text);
  const separator = included.text === "" ? 0 : 2;
  const topicBudget = Math.max(0, PORTRAIT_EVIDENCE_LIMIT - correctionUnits - separator);
  const topics = clipUnits(formatTopics(input.topics), topicBudget);
  const user = [
    `日期：${input.day}`,
    "",
    "## 当前数字分身",
    input.current.trim() === "" ? "（空）" : input.current,
    "",
    "## 当天变化",
    topics.trim() === "" ? "（无）" : topics,
    "",
    "## 未应用的纠正",
    included.text === "" ? "（无）" : included.text,
    "",
    "## 输出 JSON schema",
    JSON.stringify(PORTRAIT_JSON_SCHEMA),
  ].join("\n");
  return { system: PORTRAIT_SYSTEM_PROMPT, user, includedCorrectionIds: included.ids };
}

function formatTopics(topics: readonly PortraitPromptTopic[]): string {
  return topics
    .map((topic) => {
      const titles =
        topic.titles.length === 0
          ? "（无）"
          : topic.titles.map((title) => clipUnits(oneLine(title), PORTRAIT_TITLE_CLIP)).join("、");
      const conclusions =
        topic.conclusions.length === 0
          ? "（无）"
          : topic.conclusions
              .map((item) => clipUnits(oneLine(item), PORTRAIT_CONCLUSION_CLIP))
              .join("；");
      return [
        `### ${clipUnits(oneLine(topic.name), PORTRAIT_NAME_CLIP)}`,
        `概要：${clipUnits(oneLine(topic.summary), PORTRAIT_SUMMARY_CLIP)}`,
        `当天会话：${titles}`,
        `当天结论：${conclusions}`,
      ].join("\n");
    })
    .join("\n\n");
}

function packCorrections(corrections: readonly PortraitPromptCorrection[]): {
  text: string;
  ids: string[];
} {
  const lines: string[] = [];
  const ids: string[] = [];
  let used = 0;
  for (const correction of corrections) {
    const line = [
      `- ${correction.correctionId}`,
      `  位置：${clipUnits(oneLine(correction.section), PORTRAIT_SECTION_CLIP)}`,
      `  内容：${clipUnits(oneLine(correction.text), PORTRAIT_CORRECTION_CLIP)}`,
    ].join("\n");
    const extra = textUnits(line) + (lines.length === 0 ? 0 : 1);
    if (used + extra > PORTRAIT_EVIDENCE_LIMIT) break;
    lines.push(line);
    ids.push(correction.correctionId);
    used += extra;
  }
  return { text: lines.join("\n"), ids };
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}
