import type { UiLanguage } from "@you-brain/protocol";

import type {
  ConclusionRecord,
  DeviceRecord,
  SessionRecord,
  TodoRecord,
  TopicRecord,
} from "../store/types.js";
import { emptyTopicBook, partitionTopics } from "../topics/index.js";
import type { SessionState, TopicBook, TopicState, ZonedTopic } from "../topics/types.js";
import { outputCopy, type OutputCopy } from "./copy.js";

export interface OutputRenderInput {
  now: Date;
  timeZone: string;
  language: UiLanguage;
  activeLimit: number;
  historyDays: number;
  topics: readonly TopicRecord[];
  sessions: readonly SessionRecord[];
  todaySessions: readonly SessionRecord[];
  conclusions: readonly ConclusionRecord[];
  todos: readonly TodoRecord[];
  devices: readonly DeviceRecord[];
}

export interface RenderedOutput {
  today: string;
  topics: string;
  reminders: string;
}

export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

export function renderLocalMarkdown(input: OutputRenderInput): RenderedOutput {
  const copy = outputCopy(input.language);
  const zoned = zones(input);
  return {
    today: renderToday(input, copy),
    topics: renderTopics(input, copy, zoned.active, zoned.history),
    reminders: renderReminders(copy),
  };
}

export function renderReminders(copy: OutputCopy): string {
  return finish([`# ${copy.remindersTitle}`, "", copy.remindersEmpty]);
}

function renderToday(input: OutputRenderInput, copy: OutputCopy): string {
  const lines = [`# ${copy.todayTitle}`, ""];
  const groups = groupToday(input, copy);
  if (groups.length === 0) {
    lines.push(copy.noSessions);
    return finish(lines);
  }
  groups.forEach((group, index) => {
    if (index > 0) lines.push("");
    lines.push(`## ${group.name}`, "");
    group.sessions.forEach((session, sessionIndex) => {
      if (sessionIndex > 0) lines.push("");
      const topicName = group.unassigned ? copy.unassigned : group.name;
      lines.push(
        `### ${oneLine(session.title) || copy.untitled}`,
        field(copy.source, sourceLabel(session.source, copy), input.language),
        field(copy.device, deviceLabel(session.device, input.devices, copy), input.language),
        field(copy.time, formatWhen(session.updatedAt, input.timeZone, copy), input.language),
        field(copy.title, oneLine(session.title) || copy.untitled, input.language),
        field(copy.summary, oneLine(session.summary) || copy.none, input.language),
        field(copy.topic, topicName, input.language),
        field(
          copy.drive,
          session.fileId ? driveFileUrl(session.fileId) : copy.none,
          input.language,
        ),
      );
    });
  });
  return finish(lines);
}

function renderTopics(
  input: OutputRenderInput,
  copy: OutputCopy,
  active: readonly ZonedTopic[],
  history: readonly ZonedTopic[],
): string {
  const lines = [`# ${copy.topicsTitle}`, "", `## ${copy.active}`, ""];
  if (active.length === 0) lines.push(copy.noActive);
  active.forEach((topic, index) => {
    if (index > 0) lines.push("");
    lines.push(`### ${topic.name || topic.topicId}`);
    lines.push(field(copy.status, copy.statusLabels[topic.status], input.language));
    lines.push(field(copy.summary, oneLine(topic.summary) || copy.none, input.language));
    lines.push(field(copy.next, oneLine(topic.nextStep) || copy.none, input.language));
    pushItems(
      lines,
      copy.todos,
      openTodos(input, topic.topicId).map((todo) => oneLine(todo.text)),
      copy,
      input.language,
    );
    pushItems(
      lines,
      copy.conclusions,
      recentConclusions(input, topic.topicId).map((conclusion) =>
        conclusionItem(conclusion, input, copy),
      ),
      copy,
      input.language,
    );
    pushItems(
      lines,
      copy.sessions,
      relatedSessions(input, topic.topicId).map((session) => sessionItem(session, copy)),
      copy,
      input.language,
    );
  });
  lines.push("", `## ${copy.history}`, "");
  if (history.length === 0) lines.push(copy.noHistory);
  else for (const topic of history) lines.push(`- ${topic.name || topic.topicId}`);
  return finish(lines);
}

function conclusionItem(
  conclusion: ConclusionRecord,
  input: OutputRenderInput,
  copy: OutputCopy,
): string {
  const text = oneLine(conclusion.text);
  const when = formatWhen(conclusion.ts, input.timeZone, copy);
  return input.language === "zh" ? `${text}（${when}）` : `${text} (${when})`;
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

function sourceLabel(source: string, copy: OutputCopy): string {
  if (!source) return copy.none;
  return copy.sources[source] ?? source;
}

function deviceLabel(
  deviceId: string,
  devices: readonly DeviceRecord[],
  copy: OutputCopy,
): string {
  if (!deviceId) return copy.unknownDevice;
  return devices.find((device) => device.deviceId === deviceId)?.displayName ?? deviceId;
}

export function formatWhen(iso: string | null, timeZone: string, copy: OutputCopy): string {
  if (!iso) return copy.unknownTime;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return copy.unknownTime;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const bag = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== "literal") bag.set(part.type, part.value);
  }
  const year = bag.get("year") ?? "";
  const month = bag.get("month") ?? "";
  const day = bag.get("day") ?? "";
  let hour = bag.get("hour") ?? "";
  const minute = bag.get("minute") ?? "";
  if (hour === "24") hour = "00";
  if (!year || !month || !day || !hour || !minute) return copy.unknownTime;
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

interface TodayGroup {
  name: string;
  unassigned: boolean;
  newest: number;
  sessions: SessionRecord[];
}

function groupToday(input: OutputRenderInput, copy: OutputCopy): TodayGroup[] {
  const groups = new Map<string, TodayGroup>();
  for (const session of [...input.todaySessions].sort(byRecency)) {
    const topic = resolveTopic(input.topics, session.topicId);
    const key = topic?.topicId ?? "";
    let group = groups.get(key);
    if (!group) {
      group = {
        name: topic ? topic.name || topic.topicId : copy.unassigned,
        unassigned: topic === null,
        newest: stamp(session.updatedAt),
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
    group.newest = Math.max(group.newest, stamp(session.updatedAt));
  }
  return [...groups.values()].sort((left, right) => {
    if (left.unassigned !== right.unassigned) return left.unassigned ? 1 : -1;
    if (left.newest !== right.newest) return right.newest - left.newest;
    return left.name.localeCompare(right.name);
  });
}

function zones(input: OutputRenderInput): { active: ZonedTopic[]; history: ZonedTopic[] } {
  const { states, updatedAt } = zoningSessions(input.topics, input.sessions);
  const book: TopicBook = {
    ...emptyTopicBook(),
    topics: input.topics.map(toTopicState),
    sessions: states,
    conclusions: input.conclusions.map((conclusion) => ({ ...conclusion })),
    todos: input.todos.map((todo) => ({ ...todo })),
  };
  return partitionTopics(book, {
    now: input.now.toISOString(),
    activeLimit: input.activeLimit,
    historyDays: input.historyDays,
    sessionUpdatedAt: updatedAt,
  });
}

function zoningSessions(
  topics: readonly TopicRecord[],
  sessions: readonly SessionRecord[],
): { states: SessionState[]; updatedAt: Record<string, string> } {
  const states: SessionState[] = [];
  const updatedAt: Record<string, string> = {};
  for (const session of sessions) {
    states.push(toSessionState(session));
    if (session.updatedAt) updatedAt[session.sessionKey] = session.updatedAt;
  }
  for (const topic of topics) {
    if (topic.mergedInto || !topic.lastActive) continue;
    const known = states
      .filter((session) => session.topicId === topic.topicId)
      .map((session) => Date.parse(updatedAt[session.sessionKey] ?? ""))
      .filter((value) => !Number.isNaN(value));
    const best = known.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...known);
    if (Date.parse(topic.lastActive) <= best) continue;
    const sessionKey = `last-active:${topic.topicId}`;
    states.push({
      sessionKey,
      source: "",
      fileId: "",
      title: "",
      summary: "",
      refinedUpTo: 0,
      topicId: topic.topicId,
    });
    updatedAt[sessionKey] = topic.lastActive;
  }
  return { states, updatedAt };
}

function toTopicState(topic: TopicRecord): TopicState {
  return {
    topicId: topic.topicId,
    name: topic.name,
    aliases: [...topic.aliases],
    status: topic.status,
    statusBy: topic.statusBy,
    summary: topic.summary,
    nextStep: topic.nextStep,
    mergedInto: topic.mergedInto,
    createdTs: topic.createdTs,
    lastUserOpAt: topic.lastUserOpAt,
    userLocked: topic.userLocked,
  };
}

function toSessionState(session: SessionRecord): SessionState {
  return {
    sessionKey: session.sessionKey,
    source: session.source,
    fileId: session.fileId ?? "",
    title: session.title,
    summary: session.summary,
    refinedUpTo: session.refinedUpTo,
    topicId: session.topicId,
  };
}

function resolveTopic(
  topics: readonly TopicRecord[],
  topicId: string | null,
): TopicRecord | null {
  if (!topicId) return null;
  const byId = new Map(topics.map((topic) => [topic.topicId, topic]));
  let current = topicId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const topic = byId.get(current);
    if (!topic) return null;
    if (!topic.mergedInto) return topic;
    current = topic.mergedInto;
  }
  return null;
}

function openTodos(input: OutputRenderInput, topicId: string): TodoRecord[] {
  return input.todos
    .filter(
      (todo) =>
        todo.status === "open" && resolveTopic(input.topics, todo.topicId)?.topicId === topicId,
    )
    .sort(
      (left, right) => left.ts.localeCompare(right.ts) || left.todoId.localeCompare(right.todoId),
    );
}

function recentConclusions(input: OutputRenderInput, topicId: string): ConclusionRecord[] {
  return input.conclusions
    .filter(
      (conclusion) => resolveTopic(input.topics, conclusion.topicId)?.topicId === topicId,
    )
    .sort(
      (left, right) =>
        right.ts.localeCompare(left.ts) || left.conclusionId.localeCompare(right.conclusionId),
    );
}

function relatedSessions(input: OutputRenderInput, topicId: string): SessionRecord[] {
  return input.sessions
    .filter(
      (session) =>
        !session.sessionKey.startsWith("last-active:") &&
        resolveTopic(input.topics, session.topicId)?.topicId === topicId,
    )
    .sort(byRecency);
}

function sessionItem(session: SessionRecord, copy: OutputCopy): string {
  const label = oneLine(session.title) || copy.untitled;
  if (!session.fileId) return label;
  return `[${label}](${driveFileUrl(session.fileId)})`;
}

function byRecency(left: SessionRecord, right: SessionRecord): number {
  const delta = stamp(right.updatedAt) - stamp(left.updatedAt);
  if (delta !== 0) return delta;
  return left.sessionKey.localeCompare(right.sessionKey);
}

function stamp(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}
