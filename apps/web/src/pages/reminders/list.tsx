import { useState, type ReactNode } from "react";
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
}: {
  reminders: readonly ReminderView[];
  layout: "today" | "panel";
  timeZone: string;
  t: Translate;
  onAction: (reminderId: string, action: ReminderActionName, until?: string) => Promise<void>;
  onOpenTopic: (topicId: string) => void;
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
}: {
  reminder: ReminderView;
  layout: "today" | "panel";
  timeZone: string;
  busy: ReminderActionName | null;
  locked: boolean;
  t: Translate;
  onAction: (action: ReminderActionName, until?: string) => void;
  onOpenTopic: (topicId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const digest = isDigestReminder(reminder);
  const preview = reminderFirstLine(reminder.text);
  const panelClamp = layout === "panel" && !open;
  const shown = panelClamp && preview.more ? preview.line : reminder.text;
  const snooze = (choice: SnoozeChoice): void => {
    onAction("snooze", snoozeChoiceUntil(new Date(), timeZone, choice));
  };

  const copy = (
    <>
      <span className={panelClamp ? "reminder-copy is-clamped" : "reminder-copy"}>{shown}</span>
      {layout === "panel" && preview.more ? (
        <button
          type="button"
          className="reminder-expand"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t("reminderCollapse") : t("reminderExpand")}
        </button>
      ) : null}
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
          <Button size="sm" variant="ghost" disabled={locked} onClick={() => onOpenTopic(reminder.topicId ?? "")}>
            {t("todayViewTopic")}
          </Button>
        ) : null}
        {ignoreIcon}
      </>
    );
  }

  return (
    <Banner tone="info" className="reminder-banner" action={action}>
      {copy}
    </Banner>
  );
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
  onOpenTopic: (topicId: string) => void,
): MenuItem[] {
  const items: MenuItem[] = [
    { id: "done", label: t("reminderDone"), onSelect: () => onAction("done") },
    ...snoozeItems(t, snooze),
    { id: "mute", label: t("reminderMute"), onSelect: () => onAction("mute") },
  ];
  if (reminder.topicId) {
    const topicId = reminder.topicId;
    items.push({ id: "topic", label: t("todayViewTopic"), onSelect: () => onOpenTopic(topicId) });
  }
  return items;
}
