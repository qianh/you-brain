import type { UiLanguage } from "@you-brain/protocol";

import { driveFileUrl, formatWhen } from "../output/render.js";
import { outputCopy, type OutputCopy } from "../output/copy.js";
import type {
  ConclusionState,
  SessionState,
  TodoState,
  TopicBook,
  TopicState,
} from "../topics/types.js";

export interface TopicDetailInput {
  topic: TopicState;
  book: Pick<TopicBook, "sessions" | "conclusions" | "todos">;
  language: UiLanguage;
  timeZone: string;
  /** Orders sessions only. It is not written into the file. */
  sessionUpdatedAt?: Readonly<Record<string, string>>;
}

export interface TopicOverviewEntry {
  topic: TopicState;
  fileId: string | null;
}

export interface TopicOverviewInput {
  active: readonly TopicOverviewEntry[];
  history: readonly TopicOverviewEntry[];
  language: UiLanguage;
}

export function renderTopicDetail(input: TopicDetailInput): string {
  const copy = outputCopy(input.language);
  const topic = input.topic;
  const lines = [`# ${topicLabel(topic, copy)}`, ""];
  lines.push(field(copy.aliases, aliasValue(topic.aliases, copy, input.language), input.language));
  lines.push(field(copy.status, copy.statusLabels[topic.status], input.language));
  lines.push(field(copy.summary, oneLine(topic.summary) || copy.none, input.language));
  lines.push(field(copy.next, oneLine(topic.nextStep) || copy.none, input.language));
  pushItems(
    lines,
    copy.todos,
    openTodos(input.book.todos, topic.topicId).map((todo) => oneLine(todo.text)),
    copy,
    input.language,
  );
  pushItems(
    lines,
    copy.allConclusions,
    conclusions(input.book.conclusions, topic.topicId).map((conclusion) =>
      conclusionLine(conclusion, input.timeZone, input.language, copy),
    ),
    copy,
    input.language,
  );
  pushItems(
    lines,
    copy.sessions,
    sessions(input.book.sessions, topic.topicId, input.sessionUpdatedAt).map((session) =>
      sessionLine(session, copy),
    ),
    copy,
    input.language,
  );
  return finish(lines);
}

export function renderTopicsOverview(input: TopicOverviewInput): string {
  const copy = outputCopy(input.language);
  const lines = [`# ${copy.topicsTitle}`, "", `## ${copy.active}`, ""];
  if (input.active.length === 0) lines.push(copy.noActive);
  input.active.forEach((item, index) => {
    if (index > 0) lines.push("");
    lines.push(linkedHeading(item, copy));
    lines.push(field(copy.status, copy.statusLabels[item.topic.status], input.language));
    lines.push(field(copy.summary, oneLine(item.topic.summary) || copy.none, input.language));
    lines.push(field(copy.next, oneLine(item.topic.nextStep) || copy.none, input.language));
  });
  lines.push("", `## ${copy.history}`, "");
  if (input.history.length === 0) lines.push(copy.noHistory);
  else {
    for (const item of input.history) lines.push(linkedItem(item, copy));
  }
  return finish(lines);
}

function linkedHeading(item: TopicOverviewEntry, copy: OutputCopy): string {
  const name = topicLabel(item.topic, copy);
  if (!item.fileId) return `### ${name}`;
  return `### [${escapeLinkText(name)}](${driveFileUrl(item.fileId)})`;
}

function linkedItem(item: TopicOverviewEntry, copy: OutputCopy): string {
  const name = topicLabel(item.topic, copy);
  if (!item.fileId) return `- ${name}`;
  return `- [${escapeLinkText(name)}](${driveFileUrl(item.fileId)})`;
}

function topicLabel(topic: TopicState, copy: OutputCopy): string {
  return oneLine(topic.name) || oneLine(topic.topicId) || copy.unknownTopic;
}

function aliasValue(
  aliases: readonly string[],
  copy: OutputCopy,
  language: UiLanguage,
): string {
  const items = aliases.map(oneLine).filter((item) => item !== "");
  if (items.length === 0) return copy.none;
  return items.join(language === "zh" ? "、" : ", ");
}

function openTodos(todos: readonly TodoState[], topicId: string): TodoState[] {
  return todos
    .filter((todo) => todo.topicId === topicId && todo.status === "open")
    .sort(
      (left, right) => left.ts.localeCompare(right.ts) || left.todoId.localeCompare(right.todoId),
    );
}

function conclusions(
  items: readonly ConclusionState[],
  topicId: string,
): ConclusionState[] {
  return items
    .filter((item) => item.topicId === topicId)
    .sort(
      (left, right) =>
        right.ts.localeCompare(left.ts) || left.conclusionId.localeCompare(right.conclusionId),
    );
}

function conclusionLine(
  conclusion: ConclusionState,
  timeZone: string,
  language: UiLanguage,
  copy: OutputCopy,
): string {
  const text = oneLine(conclusion.text);
  const when = formatWhen(conclusion.ts, timeZone, copy);
  return language === "zh" ? `${text}（${when}）` : `${text} (${when})`;
}

function sessions(
  items: readonly SessionState[],
  topicId: string,
  updatedAt: Readonly<Record<string, string>> | undefined,
): SessionState[] {
  return items
    .filter((session) => session.topicId === topicId)
    .sort((left, right) => {
      const delta = stamp(updatedAt?.[right.sessionKey]) - stamp(updatedAt?.[left.sessionKey]);
      if (delta !== 0) return delta;
      return left.sessionKey.localeCompare(right.sessionKey);
    });
}

function sessionLine(session: SessionState, copy: OutputCopy): string {
  const label = oneLine(session.title) || copy.untitled;
  if (!session.fileId) return label;
  return `[${escapeLinkText(label)}](${driveFileUrl(session.fileId)})`;
}

function stamp(iso: string | undefined): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function pushItems(
  lines: string[],
  label: string,
  items: readonly string[],
  copy: OutputCopy,
  language: UiLanguage,
): void {
  if (items.length === 0) {
    lines.push(field(label, copy.none, language));
    return;
  }
  lines.push(language === "zh" ? `- ${label}：` : `- ${label}:`);
  for (const item of items) lines.push(`  - ${item}`);
}

function field(label: string, value: string, language: UiLanguage): string {
  return language === "zh" ? `- ${label}：${value}` : `- ${label}: ${value}`;
}

function finish(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function escapeLinkText(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\]/gu, "\\]");
}
