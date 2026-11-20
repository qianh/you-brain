import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useDaemon } from "../daemon-context.js";
import { Banner } from "../components/banner.js";
import { Button, IconButton } from "../components/button.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { BrandMark, Icon } from "../components/icons.js";
import { SkeletonRow } from "../components/skeleton.js";
import { StatusCapsule } from "../components/status-capsule.js";
import { useToast } from "../components/toast.js";
import { Toggle } from "../components/toggle.js";
import { useDelayed } from "../components/use-delayed.js";
import { capsuleFromStatus, capsuleWarningCount, type CapsuleKind, type CapsuleStatus } from "../lib/health.js";
import { type Language } from "../lib/format.js";
import { settingsHref, topicHref } from "../lib/route.js";
import { isTextEntry, modLabel, shortcutMod } from "../lib/shortcuts.js";
import { browserWindowBridge, quitShell } from "../lib/window.js";
import type { MessageKey } from "../i18n/messages.js";
import { StartGuide } from "./today/guide.js";
import { emptyCaptureView, guideSteps } from "./today/model.js";
import { panelShortcut } from "./panel/model.js";
import { type QuotaCardView } from "./panel/quota.js";
import { QuotaGroups } from "./panel/quota-groups.js";
import type { DeckTelegramStatusResponse } from "@you-brain/core/http/types.js";
import { useQuota } from "./panel/use-quota.js";
import { openAppPath } from "./panel/open.js";
import { ReminderList } from "./reminders/list.js";
import { isRecallReminder, reminderToTaskInput } from "./reminders/model.js";
import { isUnreachableError } from "./status/logic.js";

export function panelCapsuleKind(input: {
  loading: boolean;
  error: string | null;
  status: CapsuleStatus | null;
}): CapsuleKind {
  return capsuleFromStatus(input.status, {
    connected: !(input.error && input.status === null),
    syncing: input.loading && input.status === null,
  });
}

export function PanelPage() {
  const { t, language, today, topics, status, reminders, error, loading, reload, timeZone, client, reminderAction } = useDaemon();
  const { push } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const { quota, cards, nowMs, reload: loadQuota } = useQuota();
  const sessions = today?.sessions ?? [];

  const firstLoad = loading && today === null && status === null;
  const showSkeleton = useDelayed(firstLoad, 150);
  const offline = !loading && today === null && status === null && isUnreachableError(error);
  const failed = Boolean(error) && today === null && status === null && !loading && !offline;
  const steps =
    status === null
      ? []
      : guideSteps({
          driveReachable: status.drive.reachable,
          accountEmail: status.drive.accountEmail,
          warnings: status.warnings,
          sessionCount: sessions.length,
          lastSyncAt: status.sync.lastSyncAt,
        });
  const kind = panelCapsuleKind({ loading, error, status });
  const mod = shortcutMod(typeof navigator === "undefined" ? "" : navigator.platform);
  const chord = (key: string): string => `${modLabel(mod)}${mod === "meta" ? "" : "+"}${key}`;

  const openMain = useCallback(
    (path: string) => {
      void openAppPath(browserWindowBridge(), path)
        .then((mode) => {
          if (mode === "blocked") push({ message: t("popupBlocked"), tone: "danger" });
        })
        .catch(() => push({ message: t("popupBlocked"), tone: "danger" }));
    },
    [push, t],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const ok = await reload("all");
    void loadQuota();
    setRefreshing(false);
    if (!ok) push({ message: t("refreshFailed"), tone: "danger" });
  }, [loadQuota, push, reload, t]);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      await client.sync();
      push({ message: t("syncStarted"), tone: "success" });
      await reload("status");
    } catch {
      push({ message: t("syncFailed"), tone: "danger" });
    } finally {
      setSyncing(false);
    }
  }, [client, push, reload, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const action = panelShortcut(
        {
          key: event.key,
          meta: event.metaKey,
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          targetIsText: isTextEntry(event.target),
        },
        mod,
      );
      if (!action) return;
      event.preventDefault();
      if (action === "close") window.close();
      else if (action === "open") openMain("/");
      else void refresh();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mod, openMain, refresh]);

  return (
    <div className="panel-frame panel-page">
      <header className="panel-top">
        <span className="brand">
          <BrandMark size={20} />
          <span>{t("brand")}</span>
        </span>
        <span className="panel-tools">
          <StatusCapsule kind={kind} label={capsuleText(kind, capsuleWarningCount(status), t)} onClick={() => openMain("/status")} />
          <IconButton label={t("panelOpenMain")} shortcut={chord("O")} onClick={() => openMain("/")}>
            <Icon name="external-link" />
          </IconButton>
          <IconButton label={t("reload")} shortcut={chord("R")} className={refreshing ? "is-spinning" : ""} onClick={() => void refresh()}>
            <Icon name="refresh" />
          </IconButton>
        </span>
      </header>
      <PanelScroll>
        {showSkeleton ? <PanelSkeleton /> : null}
        {offline ? (
          <EmptyState
            icon="activity"
            title={t("statusOfflineTitle")}
            description={t("statusOfflineBody")}
            action={
              <Button variant="primary" onClick={() => void refresh()}>
                {t("statusReconnect")}
              </Button>
            }
          />
        ) : null}
        {failed ? (
          <Banner
            tone="danger"
            action={
              <Button size="sm" onClick={() => void refresh()}>
                {t("retry")}
              </Button>
            }
          >
            <span title={error ?? ""}>{t("panelLoadError")}</span>
          </Banner>
        ) : null}
        {!firstLoad && !failed && !offline ? (
          <>
            <StartGuide steps={steps} variant="mini" onOpen={(section) => openMain(settingsHref(section))} />
            {reminders.length > 0 ? (
              <div className="panel-alerts">
                <ReminderList
                  reminders={reminders}
                  layout="panel"
                  timeZone={timeZone}
                  t={t}
                  onAction={reminderAction}
                  onOpenTopic={(topicId, session) => openMain(topicHref(topicZone(topics, topicId), topicId, session))}
                  onAddTodo={async (reminder) => {
                    await client.createTask(reminderToTaskInput(reminder));
                    if (isRecallReminder(reminder)) {
                      await client.reminderReply(reminder.reminderId, t("popupTodoReplyNote"));
                      await reload("today");
                    } else {
                      await reminderAction(reminder.reminderId, "done");
                    }
                    push({ message: t("reminderAddedTodo"), tone: "success" });
                  }}
                  loadDetail={(reminderId) => client.reminderDetail(reminderId).then((result) => result.detail)}
                />
              </div>
            ) : null}
            {cards.length > 0 ? (
              <QuotaCard
                cards={cards}
                readAt={quota?.readAt ?? null}
                stale={quota?.stale === true}
                nowMs={nowMs}
                language={language}
                timeZone={timeZone}
                t={t}
              />
            ) : null}
            {reminders.length === 0 && cards.length === 0 ? (
              <div className="panel-empty">
                <span className="panel-empty-icon" aria-hidden="true">
                  <Icon name="sparkles" size={16} />
                </span>
                <span className="panel-empty-text">{t("panelNothingNow")}</span>
              </div>
            ) : null}
          </>
        ) : null}
      </PanelScroll>
      <SilentNotificationsSetting t={t} />
      <MobileNotificationsSetting onConfigure={() => openMain(settingsHref("integrations"))} />
      <footer className="panel-footer">
        <Button size="sm" variant="ghost" icon={<Icon name="refresh" />} loading={syncing} onClick={() => void sync()}>
          {t("cmdSync")}
        </Button>
        <div className="panel-actions">
          <Button size="sm" variant="secondary" onClick={() => openMain("/")}>
            {t("openWindow")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void quitShell({ ...browserWindowBridge(), close: () => window.close() });
            }}
          >
            {t("quit")}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function SilentNotificationsSetting({ t }: { t: (key: MessageKey) => string }) {
  const { push } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void browserWindowBridge().invoke?.("get_silent_notifications")
      .then((value) => {
        if (typeof value === "boolean") setEnabled(value);
      })
      .catch(() => undefined);
  }, []);

  const save = async (next: boolean) => {
    const invoke = browserWindowBridge().invoke;
    if (!invoke) return;
    setSaving(true);
    try {
      await invoke("set_silent_notifications", { enabled: next });
      setEnabled(next);
    } catch {
      push({ message: t("panelSilentNotificationsSaveFailed"), tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  if (enabled === null) return null;
  const label = t("panelSilentNotifications");
  return (
    <div className="panel-notification-setting">
      <span>{label}</span>
      <Toggle checked={enabled} label={label} disabled={saving} onChange={(next) => void save(next)} />
    </div>
  );
}

function MobileNotificationsSetting({ onConfigure }: { onConfigure: () => void }) {
  const { client, t } = useDaemon();
  const { push } = useToast();
  const [status, setStatus] = useState<DeckTelegramStatusResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);

  useEffect(() => {
    const refresh = () => {
      const current = ++revision.current;
      void client.deckTelegram().then((next) => {
        if (current === revision.current) setStatus(next);
      }, () => {
        if (current === revision.current) setStatus(null);
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      revision.current += 1;
      window.removeEventListener("focus", refresh);
    };
  }, [client]);

  const save = async (enabled: boolean) => {
    revision.current += 1;
    setSaving(true);
    try {
      const updated = await client.deckTelegramAction({ action: "set-notifications", enabled });
      revision.current += 1;
      setStatus(updated);
    } catch {
      push({ message: t("panelMobileNotificationsSaveFailed"), tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  const enabled = status?.notificationsEnabled === true;
  const needsBinding = status !== null && status.bound === null;
  const label = t("panelMobileNotifications");
  return (
    <div className="panel-notification-setting">
      <span>{label}</span>
      <div className="panel-notification-controls">
        {needsBinding && <Button size="sm" variant="ghost" onClick={onConfigure}>{t("panelMobileNotificationsBind")}</Button>}
        <Toggle checked={enabled} label={label} disabled={status === null || saving || (needsBinding && !enabled)} onChange={(next) => void save(next)} />
      </div>
    </div>
  );
}

function QuotaCard({
  cards,
  readAt,
  stale,
  nowMs,
  language,
  timeZone,
  t,
}: {
  cards: readonly QuotaCardView[];
  readAt: string | null;
  stale: boolean;
  nowMs: number;
  language: Language;
  timeZone: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const ageMinutes = readAt === null ? 0 : Math.max(1, Math.round((nowMs - Date.parse(readAt)) / 60_000));
  return (
    <Card>
      <div className="panel-card-head">
        <p className="panel-card-name">{t("panelQuotaTitle")}</p>
        {stale ? <span className="quota-stale">{t("panelQuotaStale", { minutes: ageMinutes })}</span> : null}
      </div>
      <QuotaGroups cards={cards} nowMs={nowMs} language={language} timeZone={timeZone} t={t} hideCardStale={stale} />
    </Card>
  );
}

function PanelScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.scrollHeight - el.clientHeight > 1;
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    setFade(overflow && !atEnd);
  }, []);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);
  return (
    <div className="panel-scroll-host">
      <div className="panel-scroll" ref={ref}>
        {children}
      </div>
      {fade ? <div className="panel-scroll-fade" aria-hidden="true" /> : null}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <Card aria-hidden="true">
      <div className="panel-card-head">
        <span className="skeleton panel-skel-line" />
      </div>
      <SkeletonRow />
      <SkeletonRow />
      <SkeletonRow />
    </Card>
  );
}

function capsuleText(
  kind: CapsuleKind,
  count: number,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (kind === "offline") return t("capsuleOffline");
  if (kind === "loading") return t("capsuleLoading");
  if (kind === "refine-error") return t("capsuleRefineError");
  if (kind === "sync-error") return t("capsuleSyncError");
  if (kind === "warn") return t("capsuleWarn", { count });
  return t("healthy");
}

function topicZone(topics: readonly { topicId: string; zone: "active" | "history" }[], topicId: string): "active" | "history" {
  return topics.find((topic) => topic.topicId === topicId)?.zone ?? "active";
}
