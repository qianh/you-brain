import type { TopicBook } from "../topics/types.js";
import { REMINDER_KIND } from "./due.js";
import { localDateKey, localParts } from "./time.js";

/** 详情里最多列这么多条结论,避免一屏几十页。 */
const MAX_CONCLUSIONS = 60;

/**
 * 提醒正文为了通知被截成了几十个字(「…」结尾),详情把被截掉的原文找回来。
 * 现在只有晨间摘要有被截的内容:昨日结论全文(带所在话题)、被截短的建议跟进话题全名。
 * 其余提醒的正文本身就是完整的,返回 null。
 *
 * 不依赖提醒当时有没有存详情:结论带时间戳、话题名在事件里,按提醒 id 里的日期现算,
 * 所以以前发出的摘要也能展开。
 */
export function reminderDetail(input: {
  reminder: { reminderId: string; kind: string; text: string };
  book: TopicBook;
  timeZoneOffsetMinutes: number;
}): string | null {
  if (input.reminder.kind !== REMINDER_KIND.morningDigest) return null;
  const yesterday = dayBefore(input.reminder.reminderId);
  if (yesterday === null) return null;

  const names = new Map(input.book.topics.map((topic) => [topic.topicId, topic.name.trim() || "未命名话题"]));
  const conclusions = input.book.conclusions
    .filter((item) => {
      const ms = Date.parse(item.ts);
      return !Number.isNaN(ms) && localDateKey(localParts(ms, input.timeZoneOffsetMinutes)) === yesterday;
    })
    .sort((left, right) => (left.ts !== right.ts ? (left.ts < right.ts ? 1 : -1) : left.conclusionId < right.conclusionId ? -1 : 1));

  const lines: string[] = [];
  if (conclusions.length === 0) {
    lines.push("昨日没有新结论。");
  } else {
    lines.push(`昨日结论（${conclusions.length} 条）`);
    conclusions.slice(0, MAX_CONCLUSIONS).forEach((item, index) => {
      const topic = names.get(item.topicId);
      lines.push(`${index + 1}. ${item.text.replace(/[\r\n]+/gu, " ").trim()}${topic ? `  —— ${topic}` : ""}`);
    });
    if (conclusions.length > MAX_CONCLUSIONS) {
      lines.push(`……还有 ${conclusions.length - MAX_CONCLUSIONS} 条较早的结论,在话题册里查看。`);
    }
  }

  const suggestions = fullSuggestionNames(input.reminder.text, [...names.values()]);
  if (suggestions.length > 0) {
    lines.push("", "建议跟进");
    for (const name of suggestions) lines.push(`· ${name}`);
  }
  return lines.join("\n");
}

/** `morning:2026-11-03` → 前一天 `2026-11-02`。 */
function dayBefore(reminderId: string): string | null {
  const match = /^morning:(\d{4})-(\d{2})-(\d{2})$/u.exec(reminderId);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1));
  return date.toISOString().slice(0, 10);
}

/** 从「建议跟进：A、B…、C。」里取出话题名,被「…」截短的按前缀还原成全名。 */
function fullSuggestionNames(text: string, allNames: readonly string[]): string[] {
  const line = text.split("\n").find((entry) => entry.startsWith("建议跟进："));
  if (!line) return [];
  return line
    .slice("建议跟进：".length)
    .replace(/。$/u, "")
    .split("、")
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .map((token) => {
      if (!token.endsWith("…")) return token;
      const prefix = token.slice(0, -1).trim();
      return allNames.find((name) => name.startsWith(prefix)) ?? token;
    });
}
