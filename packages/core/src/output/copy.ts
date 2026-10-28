import type { TopicStatus, UiLanguage } from "@you-brain/protocol";
import { TOPIC_STATUS_LABELS } from "@you-brain/protocol";

export interface OutputCopy {
  todayTitle: string;
  topicsTitle: string;
  remindersTitle: string;
  noSessions: string;
  noActive: string;
  noHistory: string;
  unassigned: string;
  unknownTopic: string;
  unknownDevice: string;
  unknownTime: string;
  untitled: string;
  none: string;
  source: string;
  device: string;
  time: string;
  title: string;
  summary: string;
  topic: string;
  drive: string;
  active: string;
  history: string;
  status: string;
  next: string;
  aliases: string;
  todos: string;
  conclusions: string;
  allConclusions: string;
  sessions: string;
  remindersEmpty: string;
  remindersFollow: string;
  remindersDigest: string;
  remindersWeekly: string;
  statusLabels: Record<TopicStatus, string>;
  sources: Record<string, string>;
}

const SOURCES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "grok-build": "Grok Build",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
  pi: "Pi",
  "t3-code": "T3 Code",
  zcode: "ZCode",
};

const EN_STATUS: Record<TopicStatus, string> = {
  active: "Active",
  follow_up: "Follow up",
  done: "Done",
  parked: "Parked",
};

const ZH: OutputCopy = {
  todayTitle: "今日",
  topicsTitle: "话题",
  remindersTitle: "提醒",
  noSessions: "今天还没有会话。",
  noActive: "暂无活跃话题。",
  noHistory: "暂无历史话题。",
  unassigned: "未归入话题",
  unknownTopic: "未知话题",
  unknownDevice: "未知设备",
  unknownTime: "未知",
  untitled: "未命名会话",
  none: "无",
  source: "来源",
  device: "设备",
  time: "时间",
  title: "标题",
  summary: "概要",
  topic: "话题",
  drive: "Drive",
  active: "活跃",
  history: "历史",
  status: "状态",
  next: "下一步",
  aliases: "别名",
  todos: "未完成待办",
  conclusions: "最近结论",
  allConclusions: "全部结论",
  sessions: "相关会话",
  remindersEmpty: "暂无提醒",
  remindersFollow: "待跟进话题",
  remindersDigest: "今日早报",
  remindersWeekly: "本周回顾",
  statusLabels: TOPIC_STATUS_LABELS,
  sources: SOURCES,
};

const EN: OutputCopy = {
  todayTitle: "Today",
  topicsTitle: "Topics",
  remindersTitle: "Reminders",
  noSessions: "No sessions today.",
  noActive: "No active topics.",
  noHistory: "No history topics.",
  unassigned: "Unassigned",
  unknownTopic: "Unknown topic",
  unknownDevice: "Unknown device",
  unknownTime: "unknown",
  untitled: "Untitled",
  none: "none",
  source: "Source",
  device: "Device",
  time: "Time",
  title: "Title",
  summary: "Summary",
  topic: "Topic",
  drive: "Drive",
  active: "Active",
  history: "History",
  status: "Status",
  next: "Next step",
  aliases: "Aliases",
  todos: "Open todos",
  conclusions: "Recent conclusions",
  allConclusions: "All conclusions",
  sessions: "Sessions",
  remindersEmpty: "No reminders yet",
  remindersFollow: "Topics to follow up",
  remindersDigest: "Morning digest",
  remindersWeekly: "Weekly review",
  statusLabels: EN_STATUS,
  sources: SOURCES,
};

export function outputCopy(language: UiLanguage): OutputCopy {
  return language === "en" ? EN : ZH;
}
