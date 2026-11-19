import type { DeckSessionNotice, ReminderView } from "@you-brain/core/http/types.js";

export type PopupItem =
  | { type: "reminder"; key: string; at: string; reminder: ReminderView }
  | { type: "terminal"; key: string; at: string; notice: DeckSessionNotice };

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
