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
  reminderFailureMessage,
  reminderFirstLine,
  snoozeChoiceUntil,
  type ReminderActionName,
  type SnoozeChoice,
} from "./model.js";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

const SNOOZE_LABEL: Record<SnoozeChoice, MessageKey> = {
  tomorrow: "reminderSnoozeTomorrow",
  threeDays: "reminderSnoozeThreeDays",
  nextWeek: "reminderSnoozeNextWeek",
};

export function ReminderList({
  reminders,
  layout,
  timeZone,
  t,
  onAction,
  onOpenTopic,
  loadDetail,
}: {
  reminders: readonly ReminderView[];
  layout: "today" | "panel";
  timeZone: string;
  t: Translate;
  onAction: (reminderId: string, action: ReminderActionName, until?: string) => Promise<void>;
  /** 打开话题;提醒记着出处会话时一并传入,由页面定位到那段会话。 */
  onOpenTopic: (topicId: string, sessionKey: string | null) => void;
  /** 取提醒被截短的原文;不传就不显示「查看详情」。 */
  loadDetail?: ((reminderId: string) => Promise<string | null>) | undefined;
}) {
  const { push } = useToast();
  const [pending, setPending] = useState<{ id: string; action: ReminderActionName } | null>(null);

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
          loadDetail={loadDetail}
        />
      ))}
    </>
  );
}

export function ReminderCard({
  reminder,
  layout,
  timeZone,
  busy,
  locked,
  t,
  onAction,
  onOpenTopic,
  loadDetail,
}: {
  reminder: ReminderView;
  layout: "today" | "panel";
  timeZone: string;
  busy: ReminderActionName | null;
  locked: boolean;
  t: Translate;
  onAction: (action: ReminderActionName, until?: string) => void;
  onOpenTopic: (topicId: string, sessionKey: string | null) => void;
  loadDetail?: ((reminderId: string) => Promise<string | null>) | undefined;
}) {
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
          className="reminder-expand reminder-detail-toggle"
          aria-expanded={detailOpen}
          disabled={detailLoading}
          onClick={toggleDetail}
        >
          {detailOpen ? t("reminderDetailHide") : detailLoading ? `${t("reminderDetail")}…` : t("reminderDetail")}
        </button>
      ) : null}
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
          items={panelItems(reminder, t, snooze, onAction, onOpenTopic)}
        />
      </>
    );
  } else {
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
    <Banner tone="info" className="reminder-banner" action={action} actionBelow={layout === "panel" && open}>
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
): MenuItem[] {
  const items: MenuItem[] = [
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
