import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReminderView } from "@you-brain/core/http/types.js";

import { translate, type MessageKey } from "../../src/i18n/messages.js";
import { ReminderCard } from "../../src/pages/reminders/list.js";

const t = (key: MessageKey): string => translate("zh", key);

const topic: ReminderView = {
  reminderId: "rem-stale",
  kind: "stale",
  topicId: "topic-trip",
  text: "京都旅行已经三天没有新会话。",
  status: "open",
  until: null,
  issuedAt: "2026-10-23T00:00:00.000Z",
};

const digest: ReminderView = {
  reminderId: "rem-morning",
  kind: "morning_digest",
  topicId: null,
  text: "早报\n昨天有 4 段会话。",
  status: "open",
  until: null,
  issuedAt: "2026-10-23T00:00:00.000Z",
};

function card(reminder: ReminderView, layout: "today" | "panel", busy: "reactivate" | "ignore" | null = null): string {
  return renderToStaticMarkup(
    <ReminderCard
      reminder={reminder}
      layout={layout}
      timeZone="Asia/Shanghai"
      busy={busy}
      locked={busy !== null}
      t={t}
      onAction={() => undefined}
      onOpenTopic={() => undefined}
    />,
  );
}

describe("ReminderCard", () => {
  test("shows topic actions on today and keeps line breaks in the text", () => {
    const html = card(topic, "today");
    expect(html).toContain("重新激活");
    expect(html).toContain("标记完结");
    expect(html).toContain("稍后提醒");
    expect(html).toContain("不再提醒");
    expect(html).toContain("查看话题");
    expect(html).toContain('aria-label="忽略"');
    expect(html).toContain("京都旅行已经三天没有新会话。");
    expect(html).not.toContain("忽略（已读）");
  });

  test("keeps only reactivate and dismiss on the panel, and folds the rest into More", () => {
    const html = card(topic, "panel");
    expect(html).toContain("重新激活");
    expect(html).toContain("更多");
    expect(html).toContain('aria-label="忽略"');
    expect(html).not.toContain("标记完结");
    expect(html).not.toContain("稍后提醒");
    expect(html).not.toContain("不再提醒");
  });

  test("shows a digest as preformatted text on today and the first line on the panel", () => {
    const today = card(digest, "today");
    expect(today).toContain("忽略（已读）");
    expect(today).toContain("早报");
    expect(today).toContain("昨天有 4 段会话。");
    expect(today).toContain("reminder-copy");
    expect(today).not.toContain("is-clamped");
    expect(today).not.toContain("重新激活");

    const panel = card(digest, "panel");
    expect(panel).toContain("忽略（已读）");
    expect(panel).toContain("早报");
    expect(panel).toContain("展开");
    expect(panel).toContain("is-clamped");
    expect(panel).not.toContain("昨天有 4 段会话。");
    expect(panel).not.toContain("重新激活");
  });

  test("marks the in-flight action as busy", () => {
    const html = card(topic, "today", "reactivate");
    expect(html).toContain('aria-busy="true"');
  });
});
