import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ReminderView } from "@you-brain/core/http/types.js";

import { Banner } from "../../components/banner.js";
import { Button, IconButton } from "../../components/button.js";
import { Icon } from "../../components/icons.js";
import { Menu, type MenuItem } from "../../components/menu.js";
import { Spinner } from "../../components/spinner.js";
import { useToast } from "../../components/toast.js";
import type { MessageKey } from "../../i18n/messages.js";
import {
  isDigestReminder,
  isRecallReminder,
  parseDigest,
  parseDigestDetail,
  reminderFailureMessage,
  reminderFirstLine,
  snoozeChoiceUntil,
  type DigestSummary,
  type ReminderActionName,
  type SnoozeChoice,
} from "./model.js";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

const SNOOZE_LABEL: Record<SnoozeChoice, MessageKey> = {
  tomorrow: "reminderSnoozeTomorrow",
  threeDays: "reminderSnoozeThreeDays",
  nextWeek: "reminderSnoozeNextWeek",
};

type PendingKind = ReminderActionName | "todo";

export function ReminderList({
  reminders,
  layout,
  timeZone,
  t,
  onAction,
  onOpenTopic,
  onAddTodo,
  loadDetail,
}: {
  reminders: readonly ReminderView[];
  layout: "today" | "panel";
  timeZone: string;
  t: Translate;
  onAction: (reminderId: string, action: ReminderActionName, until?: string) => Promise<void>;
  /** 打开话题;提醒记着出处会话时一并传入,由页面定位到那段会话。 */
  onOpenTopic: (topicId: string, sessionKey: string | null) => void;
  /** 快速把提醒内容转入 /todos 跟进。 */
  onAddTodo?: ((reminder: ReminderView) => Promise<void>) | undefined;
  /** 取提醒被截短的原文;不传就不显示「查看详情」。 */
  loadDetail?: ((reminderId: string) => Promise<string | null>) | undefined;
}) {
  const { push } = useToast();
  const [pending, setPending] = useState<{ id: string; action: PendingKind } | null>(null);

  const run = async (reminderId: string, action: ReminderActionName, until?: string): Promise<void> => {
    if (pending) return;
    setPending({ id: reminderId, action });
    try {
      await onAction(reminderId, action, until);
    } catch (error) {
      push({ message: reminderFailureMessage(error, t("actionFailed")), tone: "danger" });
    } finally {
      setPending(null);
    }
  };

  const runAddTodo = async (reminder: ReminderView): Promise<void> => {
    if (pending || !onAddTodo) return;
    setPending({ id: reminder.reminderId, action: "todo" });
    try {
      await onAddTodo(reminder);
    } catch (error) {
      push({ message: reminderFailureMessage(error, t("actionFailed")), tone: "danger" });
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      {reminders.map((reminder) => (
        <ReminderCard
          key={reminder.reminderId}
          reminder={reminder}
          layout={layout}
          timeZone={timeZone}
          busy={pending?.id === reminder.reminderId ? pending.action : null}
          locked={pending !== null}
          t={t}
          onAction={(action, until) => void run(reminder.reminderId, action, until)}
          onOpenTopic={onOpenTopic}
          {...(onAddTodo ? { onAddTodo: () => void runAddTodo(reminder) } : {})}
          loadDetail={loadDetail}
        />
      ))}
    </>
  );
}

type CardProps = {
  reminder: ReminderView;
  layout: "today" | "panel";
  timeZone: string;
  busy: PendingKind | null;
  locked: boolean;
  t: Translate;
  onAction: (action: ReminderActionName, until?: string) => void;
  onOpenTopic: (topicId: string, sessionKey: string | null) => void;
  onAddTodo?: (() => void) | undefined;
  loadDetail?: ((reminderId: string) => Promise<string | null>) | undefined;
};

export function ReminderCard(props: CardProps) {
  const summary = props.reminder.kind === "morning_digest" ? parseDigest(props.reminder.text) : null;
  return summary ? <DigestCard {...props} summary={summary} /> : <PlainReminderCard {...props} />;
}

/**
 * 晨间摘要:正文里被截短的第一条结论对阅读没有帮助,卡片只放两个数字和建议跟进的话题,
 * 结论全文按需从详情接口取来,逐条列出并标出所在话题。按钮统一放在底栏。
 */
function DigestCard({ reminder, busy, locked, t, onAction, loadDetail, summary }: CardProps & { summary: DigestSummary }) {
  const [detail, setDetail] = useState<string | null | undefined>(undefined);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const parsed = detail ? parseDigestDetail(detail) : null;
  const canDetail = loadDetail !== undefined && summary.conclusions > 0 && detail !== null;
  const toggleDetail = (): void => {
    if (detailOpen) {
      setDetailOpen(false);
      return;
    }
    if (detail !== undefined || loadDetail === undefined) {
      setDetailOpen(true);
      return;
    }
    setDetailLoading(true);
    void loadDetail(reminder.reminderId)
      .then((text) => {
        setDetail(text);
        setDetailOpen(text !== null);
      })
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  };
  // 详情里有话题全名,取到后替换掉正文里被截短的名字。
  const suggestions = parsed && parsed.suggestions.length > 0 ? parsed.suggestions : summary.suggestions;

  const footer = (
    <>
      {canDetail ? (
        <span className="reminder-links">
          <button
            type="button"
            className="reminder-expand"
            aria-expanded={detailOpen}
            disabled={detailLoading}
            onClick={toggleDetail}
          >
            {detailOpen
              ? t("digestHideConclusions")
              : detailLoading
                ? `${t("digestViewConclusions")}…`
                : t("digestViewConclusions")}
          </button>
        </span>
      ) : null}
      <Button size="sm" variant="ghost" loading={busy === "ignore"} disabled={locked} onClick={() => onAction("ignore")}>
        {t("reminderIgnoreRead")}
      </Button>
    </>
  );

  return (
    <Banner tone="info" className="reminder-banner digest-banner" action={footer} actionBelow>
      <span className="digest-title">{t("digestTitle")}</span>
      <span className="digest-stats">
        <span className="digest-stat">
          <span className="digest-stat-value">{summary.conclusions}</span>
          <span className="digest-stat-label">{t("digestConclusions")}</span>
        </span>
        <span className="digest-stat">
          <span className="digest-stat-value">{summary.todos}</span>
          <span className="digest-stat-label">{t("digestTodos")}</span>
        </span>
      </span>
      {suggestions.length > 0 ? (
        <span className="digest-follow">
          <span className="digest-label">{t("digestFollow")}</span>
          <ol className="digest-follow-list">
            {suggestions.map((name, index) => (
              <li key={name} className="digest-follow-item" title={name}>
                <span className="digest-follow-rank">{index + 1}</span>
                <span className="digest-follow-name">{name}</span>
              </li>
            ))}
          </ol>
        </span>
      ) : null}
      {detailOpen && detail ? (
        parsed ? (
          <span className="digest-detail">
            <ol className="digest-list">
              {parsed.conclusions.map((item, index) => (
                <li key={index}>
                  <span className="digest-item-text">{item.text}</span>
                  {item.topic ? <span className="digest-item-topic">{item.topic}</span> : null}
                </li>
              ))}
            </ol>
            {parsed.note ? <span className="digest-note">{parsed.note}</span> : null}
          </span>
        ) : (
          <div className="reminder-detail">{detail}</div>
        )
      ) : null}
    </Banner>
  );
}

function PlainReminderCard({
  reminder,
  layout,
  timeZone,
  busy,
  locked,
  t,
  onAction,
  onOpenTopic,
  onAddTodo,
  loadDetail,
}: CardProps) {
  const [open, setOpen] = useState(false);
  // 正文为通知被截短了(「…」结尾)时,点「查看详情」现取原文。undefined = 还没取过。
  const [detail, setDetail] = useState<string | null | undefined>(undefined);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const canDetail = loadDetail !== undefined && reminder.kind === "morning_digest" && detail !== null;
  const toggleDetail = (): void => {
    if (detailOpen) {
      setDetailOpen(false);
      return;
    }
    if (detail !== undefined || loadDetail === undefined) {
      setDetailOpen(true);
      return;
    }
    setDetailLoading(true);
    void loadDetail(reminder.reminderId)
      .then((text) => {
        setDetail(text);
        setDetailOpen(text !== null);
      })
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  };
  const digest = isDigestReminder(reminder);
  const preview = reminderFirstLine(reminder.text);
  const panelClamp = layout === "panel" && !open;
  const shown = panelClamp && preview.more ? preview.line : reminder.text;
  // 托盘里折成一行时,一行很长也会被省略号截掉;量一下是否真的放不下,放不下才给「展开」。
  const copyRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = copyRef.current;
    if (!panelClamp || node === null) return;
    const measure = (): void => setOverflows(node.scrollWidth > node.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [panelClamp, shown]);
  const canExpand = layout === "panel" && (preview.more || overflows);
  const snooze = (choice: SnoozeChoice): void => {
    onAction("snooze", snoozeChoiceUntil(new Date(), timeZone, choice));
  };

  // 展开/收起和查看详情排成一行;托盘里展开时整行挪到底栏,和按钮并排(链接靠左、按钮靠右)。
  const links =
    canExpand || canDetail ? (
      <span className="reminder-links">
        {canExpand ? (
          <button
            type="button"
            className="reminder-expand"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t("reminderCollapse") : t("reminderExpand")}
          </button>
        ) : null}
        {canDetail ? (
          <button
            type="button"
            className="reminder-expand"
            aria-expanded={detailOpen}
            disabled={detailLoading}
            onClick={toggleDetail}
          >
            {detailOpen ? t("reminderDetailHide") : detailLoading ? `${t("reminderDetail")}…` : t("reminderDetail")}
          </button>
        ) : null}
      </span>
    ) : null;
  const linksInFooter = layout === "panel" && open;

  const copy = (
    <>
      <span ref={copyRef} className={panelClamp ? "reminder-copy is-clamped" : "reminder-copy"}>
        {isRecallReminder(reminder) ? <span className="reminder-kind">{t("reminderKindRecall")}</span> : null}
        {shown}
      </span>
      {reminder.reply ? (
        <span className="reminder-reply">
          {t("reminderReplyLabel")}：“{reminder.reply}”
        </span>
      ) : null}
      {linksInFooter ? null : links}
      {detailOpen && detail ? <div className="reminder-detail">{detail}</div> : null}
    </>
  );

  const ignoreIcon = (
    <IconButton label={t("reminderIgnore")} disabled={locked} onClick={() => onAction("ignore")}>
      {busy === "ignore" ? <Spinner /> : <Icon name="x" />}
    </IconButton>
  );

  let action: ReactNode = null;
  if (digest) {
    action = (
      <Button
        size="sm"
        variant="ghost"
        loading={busy === "ignore"}
        disabled={locked}
        onClick={() => onAction("ignore")}
      >
        {t("reminderIgnoreRead")}
      </Button>
    );
  } else if (layout === "panel") {
    action = (
      <>
        <Button
          size="sm"
          variant="secondary"
          loading={busy === "reactivate"}
          disabled={locked}
          onClick={() => onAction("reactivate")}
        >
          {t("reminderReactivate")}
        </Button>
        {ignoreIcon}
        <Menu
          label={t("reminderMore")}
          trigger={
            <Button size="sm" variant="ghost" icon={<Icon name="more" />} disabled={locked}>
              {t("reminderMore")}
            </Button>
          }
          items={panelItems(reminder, t, snooze, onAction, onOpenTopic, onAddTodo)}
        />
      </>
    );
  } else {
    action = (
      <>
        {onAddTodo ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="plus" size={13} />}
            loading={busy === "todo"}
            disabled={locked}
            onClick={onAddTodo}
          >
            {t("reminderAddTodo")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          loading={busy === "reactivate"}
          disabled={locked}
          onClick={() => onAction("reactivate")}
        >
          {t("reminderReactivate")}
        </Button>
        <Button size="sm" variant="ghost" loading={busy === "done"} disabled={locked} onClick={() => onAction("done")}>
          {t("reminderDone")}
        </Button>
        <Menu
          label={t("reminderSnooze")}
          trigger={
            <Button size="sm" variant="ghost" disabled={locked}>
              {t("reminderSnooze")}
            </Button>
          }
          items={snoozeItems(t, snooze)}
        />
        <Button size="sm" variant="ghost" loading={busy === "mute"} disabled={locked} onClick={() => onAction("mute")}>
          {t("reminderMute")}
        </Button>
        {reminder.topicId ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => onOpenTopic(reminder.topicId ?? "", reminder.sessionKey ?? null)}
          >
            {t(sourceLabel(reminder))}
          </Button>
        ) : null}
        {ignoreIcon}
      </>
    );
  }

  return (
    <Banner
      tone="info"
      className="reminder-banner"
      action={
        linksInFooter && links ? (
          <>
            {links}
            {action}
          </>
        ) : (
          action
        )
      }
      actionBelow={linksInFooter}
    >
      {copy}
    </Banner>
  );
}

/** 记着出处会话的提醒去那段会话;旧提醒和没有单一出处的,仍去话题。 */
function sourceLabel(reminder: ReminderView): MessageKey {
  return reminder.sessionKey ? "reminderViewSource" : "todayViewTopic";
}

function snoozeItems(t: Translate, snooze: (choice: SnoozeChoice) => void): MenuItem[] {
  return (Object.keys(SNOOZE_LABEL) as SnoozeChoice[]).map((choice) => ({
    id: choice,
    label: t(SNOOZE_LABEL[choice]),
    onSelect: () => snooze(choice),
  }));
}

function panelItems(
  reminder: ReminderView,
  t: Translate,
  snooze: (choice: SnoozeChoice) => void,
  onAction: (action: ReminderActionName, until?: string) => void,
  onOpenTopic: (topicId: string, sessionKey: string | null) => void,
  onAddTodo?: (() => void) | undefined,
): MenuItem[] {
  const items: MenuItem[] = [
    ...(onAddTodo ? [{ id: "todo", label: t("reminderAddTodo"), onSelect: onAddTodo }] : []),
    { id: "done", label: t("reminderDone"), onSelect: () => onAction("done") },
    ...snoozeItems(t, snooze),
    { id: "mute", label: t("reminderMute"), onSelect: () => onAction("mute") },
  ];
  if (reminder.topicId) {
    const topicId = reminder.topicId;
    const sessionKey = reminder.sessionKey ?? null;
    items.push({ id: "topic", label: t(sourceLabel(reminder)), onSelect: () => onOpenTopic(topicId, sessionKey) });
  }
  return items;
}
