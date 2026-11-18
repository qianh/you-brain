import type { DeckSessionNotice, ReminderView } from "@you-brain/core/http/types.js";

export type PopupItem =
  | { type: "reminder"; key: string; at: string; reminder: ReminderView }
  | { type: "terminal"; key: string; at: string; notice: DeckSessionNotice };

const ANSI_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/gu;
const LINE_CHAR_MAX = 140;

/**
 * 合并待处理的「聊到时记忆提醒」与「终端会话提醒」，按产生时间从新到旧排序，
 * 让刚触发弹窗的那一条总是排在第一位。
 */
export function buildPopupQueue(
  reminders: readonly ReminderView[],
  notices: readonly DeckSessionNotice[],
): PopupItem[] {
  const items: PopupItem[] = [];
  for (const reminder of reminders) {
    if (reminder.kind !== "recall" || reminder.status !== "open") continue;
    items.push({
      type: "reminder",
      key: `reminder:${reminder.reminderId}`,
      at: reminder.issuedAt,
      reminder,
    });
  }
  for (const notice of notices) {
    if (notice.status !== "open") continue;
    items.push({
      type: "terminal",
      key: `terminal:${notice.seq}`,
      at: notice.at,
      notice,
    });
  }
  items.sort((left, right) => {
    if (left.at !== right.at) return left.at < right.at ? 1 : -1;
    if (left.type !== right.type) return left.type === "terminal" ? -1 : 1;
    return left.key < right.key ? 1 : -1;
  });
  return items;
}

/**
 * 把终端屏幕尾部文本裁剪成适合小弹窗预览的几行非空摘要。
 */
export function formatTerminalSnippet(raw: string, maxLines = 4): string {
  const cleaned = raw.replace(ANSI_ESCAPE, "");
  const nonEmpty = cleaned
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) return "";
  return nonEmpty
    .slice(-maxLines)
    .map((line) => (line.length > LINE_CHAR_MAX ? `${line.slice(0, LINE_CHAR_MAX - 1)}…` : line))
    .join("\n");
}
