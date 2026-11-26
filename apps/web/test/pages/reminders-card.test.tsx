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

  test("a real morning digest shows the counts and follow-up topics, not the clipped first conclusion", () => {
    const real: ReminderView = {
      ...digest,
      text: "昨日结论 384 条：等待8分钟阻塞监测数据的后台命令已完成，退出码为0；本…\n未完成待办 727 件。\n建议跟进：ChatGPT订阅计费、货代产品能力、海运运价预测。",
    };
    for (const layout of ["today", "panel"] as const) {
      const html = card(real, layout);
      expect(html).toContain("digest-banner");
      expect(html).toContain(">384<");
      expect(html).toContain(">727<");
      expect(html).toContain("货代产品能力");
      expect(html).toContain('<ol class="digest-follow-list">');
      expect(html).toContain('<span class="digest-follow-rank" aria-hidden="true">2</span><span class="digest-follow-name">货代产品能力</span>');
      expect(html).not.toContain("digest-chip");
      expect(html).not.toContain("本…");
      expect(html).not.toContain("展开");
      expect(html).toContain("忽略（已读）");
      expect(html).toContain("actions-below");
    }
  });

  test("today and panel share one reminder row style (alignment comes from the row height, not a one-line special case)", () => {
    const multi: ReminderView = { ...topic, text: "第一行\n第二行" };
    for (const html of [card(topic, "panel"), card(multi, "panel"), card(topic, "today"), card(multi, "today")]) {
      expect(html).toContain('class="banner info reminder-banner"');
      expect(html).not.toContain("is-line");
    }
  });

  test("today and panel label the new digest as yesterday's new open todos", () => {
    const recent: ReminderView = {
      ...digest,
      text: "昨日结论：方案确认\n昨日新增待办 1 件未完成。\n今日接续：近期话题。",
    };
    for (const layout of ["today", "panel"] as const) {
      const html = card(recent, layout);
      expect(html).toContain("昨日新增未完成待办");
      expect(html).toContain("今日接续");
      expect(html).toContain("近期话题");
      expect(html).not.toContain("建议跟进");
    }
  });

  test("renders both counts and the suggested topic as controls without an initial detail request", () => {
    const recent: ReminderView = {
      ...digest,
      text: "昨日结论 97 条：方案确认\n昨日新增待办 7 件未完成。\n今日接续：早报里的名称。",
      digestFollowUpTopicIds: ["topic-trip"],
    };
    for (const layout of ["today", "panel"] as const) {
      const html = renderToStaticMarkup(
        <ReminderCard
          reminder={recent}
          layout={layout}
          topics={[{ topicId: "topic-trip", name: "更新后的话题名" }]}
          timeZone="Asia/Shanghai"
          busy={null}
          locked={false}
          t={t}
          onAction={() => undefined}
          onOpenTopic={() => undefined}
          loadDetail={async () => { throw new Error("must not fetch before clicking"); }}
        />,
      );
      expect(html.match(/<button type="button" class="digest-stat"/gu)).toHaveLength(2);
      expect(html).toContain('<button type="button" class="digest-follow-content">');
      expect(html).toContain("更新后的话题名");
      expect(html).not.toContain("早报里的名称");
    }
  });

  test("a collapsed panel reminder keeps the compact single row (actions beside the text)", () => {
    expect(card(topic, "panel")).not.toContain("actions-below");
  });

  test("a reminder that records its source session offers 查看出处; an old one keeps 查看话题", () => {
    const sourced: ReminderView = { ...topic, kind: "recall", sessionKey: "a".repeat(64) };
    expect(card(sourced, "today")).toContain("查看出处");
    expect(card(sourced, "today")).not.toContain("查看话题");
    expect(card(topic, "today")).toContain("查看话题");
    expect(card({ ...topic, sessionKey: null }, "today")).toContain("查看话题");
  });

  test("marks the in-flight action as busy", () => {
    const html = card(topic, "today", "reactivate");
    expect(html).toContain('aria-busy="true"');
  });

  test("renders 加入 TODO button on today when onAddTodo is provided", () => {
    const html = renderToStaticMarkup(
      <ReminderCard
        reminder={{ ...topic, kind: "recall", topicName: "发布流程" }}
        layout="today"
        timeZone="Asia/Shanghai"
        busy={null}
        locked={false}
        t={t}
        onAction={() => undefined}
        onOpenTopic={() => undefined}
        onAddTodo={() => undefined}
      />,
    );
    expect(html).toContain("加入 TODO");
  });
});
