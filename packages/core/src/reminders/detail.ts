import type { ReminderDetailResponse } from "../http/types.js";
import type { TopicBook } from "../topics/types.js";
import { digestConclusions, digestTodos, MAX_DIGEST_CONCLUSIONS } from "./digest.js";
import { REMINDER_KIND, type DigestSnapshot } from "./due.js";
import { DIGEST_FOLLOW_PREFIX, DIGEST_INCOMPLETE, DIGEST_TODO_PREFIX, hasLegacyDigestWarning } from "./text.js";
import { localDateKey, localParts } from "./time.js";

/**
 * 提醒正文为了通知被截成了几十个字(「…」结尾),详情把被截掉的原文找回来。
 * 现在只有晨间摘要有被截的内容:昨日结论全文(带所在话题)、被截短的建议跟进话题全名。
 * 其余提醒的正文本身就是完整的,返回 null。
 *
 * 不依赖提醒当时有没有存详情:结论带时间戳、话题名在事件里,按提醒 id 里的日期现算,
 * 所以以前发出的摘要也能展开。
 */
export function reminderDetail(input: {
  reminder: { reminderId: string; kind: string; text: string; issuedAt?: string };
  book: TopicBook;
  timeZoneOffsetMinutes: number;
  sourceSessionUpdatedAt?: Readonly<Record<string, string>>;
  digestSnapshot?: DigestSnapshot;
}): string | null {
  if (input.reminder.kind !== REMINDER_KIND.morningDigest) return null;
  const yesterday = dayBefore(input.reminder.reminderId);
  if (yesterday === null) return null;

  const names = new Map(input.book.topics.map((topic) => [topic.topicId, topic.name.trim() || "未命名话题"]));
  const recent = input.reminder.text.split("\n").some((line) => line.startsWith(DIGEST_TODO_PREFIX));
  const indexed = input.digestSnapshot ? new Map(input.book.conclusions.map((item) => [item.conclusionId, item])) : null;
  const conclusions = input.digestSnapshot && indexed ? input.digestSnapshot.ids.flatMap((id) => indexed.get(id) ?? []) : recent ? digestConclusions({
    book: input.book,
    day: yesterday,
    offsetMinutes: input.timeZoneOffsetMinutes,
    sourceSessionUpdatedAt: input.sourceSessionUpdatedAt ?? {},
    asOf: input.reminder.issuedAt === undefined ? Infinity : Date.parse(input.reminder.issuedAt),
  }) : input.book.conclusions
    .filter((item) => {
      const ms = Date.parse(item.ts);
      return !Number.isNaN(ms) && localDateKey(localParts(ms, input.timeZoneOffsetMinutes)) === yesterday;
    })
    .sort((left, right) => (left.ts !== right.ts ? (left.ts < right.ts ? 1 : -1) : left.conclusionId < right.conclusionId ? -1 : 1));

  const total = input.digestSnapshot?.total ?? conclusions.length;
  const lines: string[] = [];
  const notes: string[] = [];
  if (total === 0) {
    lines.push("昨日没有新结论。");
  } else {
    lines.push(`昨日结论（${total} 条）`);
    conclusions.slice(0, MAX_DIGEST_CONCLUSIONS).forEach((item, index) => {
      const topic = names.get(item.topicId);
      lines.push(`${index + 1}. ${item.text.replace(/[\r\n]+/gu, " ").trim()}${topic ? `  —— ${topic}` : ""}`);
    });
    if (input.digestSnapshot && conclusions.length < input.digestSnapshot.ids.length) {
      notes.push("部分结论尚未同步到本机。");
    } else if (total > MAX_DIGEST_CONCLUSIONS) {
      notes.push(`还有 ${total - MAX_DIGEST_CONCLUSIONS} 条较早的结论,在话题册里查看。`);
    }
  }
  if (input.digestSnapshot?.incomplete || hasLegacyDigestWarning(input.reminder.text)) notes.push(DIGEST_INCOMPLETE);
  if (notes.length > 0) lines.push(`……${notes.join("")}`);

  const suggestions = fullSuggestionNames(input.reminder.text, [...names.values()]);
  if (suggestions.length > 0) {
    lines.push("", recent ? "今日接续" : "建议跟进");
    for (const name of suggestions) lines.push(`· ${name}`);
  }
  return lines.join("\n");
}

export function reminderDetailResponse(
  input: Parameters<typeof reminderDetail>[0],
  bookAtIssue?: () => TopicBook,
): ReminderDetailResponse {
  const detail = reminderDetail(input);
  if (detail === null) return { detail };
  let ids = input.digestSnapshot?.followUps?.todoIds;
  if (ids === undefined && bookAtIssue && input.reminder.issuedAt) {
    const count = /^昨日新增待办 (\d+) 件未完成。$/mu.exec(input.reminder.text);
    const day = dayBefore(input.reminder.reminderId);
    if (day && count && Number(count[1]) > 0) {
      const reconstructed = digestTodos({
        book: bookAtIssue(),
        day,
        offsetMinutes: input.timeZoneOffsetMinutes,
        sourceSessionUpdatedAt: input.sourceSessionUpdatedAt ?? {},
        asOf: Date.parse(input.reminder.issuedAt),
      });
      if (reconstructed.length === Number(count[1])) ids = reconstructed.map(({ todo }) => todo.todoId);
    }
  }
  if (ids === undefined) return { detail };
  const indexed = new Map(input.book.todos.map((todo) => [todo.todoId, todo]));
  const todos = ids.flatMap((id) => {
    const todo = indexed.get(id);
    if (!todo) return [];
    const { todoId, topicId, sessionKey, text } = todo;
    return [{ todoId, topicId, sessionKey, text }];
  });
  return { detail, todos };
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
  const line = text.split("\n").find((entry) => entry.startsWith(DIGEST_FOLLOW_PREFIX) || entry.startsWith("建议跟进："));
  if (!line) return [];
  return line
    .slice(line.indexOf("：") + 1)
    .replace(/。$/u, "")
    .split("、")
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .map((token) => {
      if (!token.endsWith("…")) return token;
      const prefix = token.slice(0, -1).trim();
      const matches = allNames.filter((name) => name.startsWith(prefix));
      return matches.length === 1 ? matches[0]! : token;
    });
}
