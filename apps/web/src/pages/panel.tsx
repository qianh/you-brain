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
import { useDelayed } from "../components/use-delayed.js";
import { SourceTile } from "../components/tile.js";
import { capsuleFromStatus, type CapsuleKind, type CapsuleStatus } from "../lib/health.js";
import { formatCount } from "./today/model.js";
import { formatDateTime } from "../lib/format.js";
import { sortSessionsByTime } from "../lib/group.js";
import { settingsHref, topicHref } from "../lib/route.js";
import { isTextEntry, modLabel, shortcutMod } from "../lib/shortcuts.js";
import { browserWindowBridge, quitShell } from "../lib/window.js";
import type { MessageKey } from "../i18n/messages.js";
import { StartGuide } from "./today/guide.js";
import { guideSteps } from "./today/model.js";
import { clockTime, countSessionsByTopic, panelShortcut, panelTopicSlice, takeWithRest, topicDotClass } from "./panel/model.js";
import { openAppPath } from "./panel/open.js";
import { ReminderList } from "./reminders/list.js";
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
  const sessions = today?.sessions ?? [];
  const ordered = useMemo(() => sortSessionsByTime(sessions), [sessions]);
  const todaySlice = takeWithRest(ordered, 4);
  const topicSlice = panelTopicSlice(topics);
  const counts = countSessionsByTopic(sessions);
  const warnings = takeWithRest(status?.warnings ?? [], 2);
  const firstLoad = loading && today === null && status === null;
  const showSkeleton = useDelayed(firstLoad, 150);
  const offline = !loading && today === null && status === null && isUnreachableError(error);
  const failed = Boolean(error) && today === null && status === null && !loading && !offline;
  const steps =
    status === null
      ? []
      : guideSteps({
          driveReachable: status.drive.reachable,
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
    setRefreshing(false);
    if (!ok) push({ message: t("refreshFailed"), tone: "danger" });
  }, [push, reload, t]);

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
          <StatusCapsule kind={kind} label={capsuleText(kind, status?.warnings.length ?? 0, t)} onClick={() => openMain("/status")} />
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
            <Card>
              <div className="panel-card-head">
                <p className="panel-card-name">{t("panelTodayLine", { count: formatCount(sessions.length, language) })}</p>
                <Button size="sm" variant="ghost" iconRight={<Icon name="chevron-right" />} onClick={() => openMain("/today")}>
                  {t("panelOpenToday")}
                </Button>
              </div>
              {sessions.length === 0 ? (
                <div className="panel-empty">
                  <span className="panel-empty-icon" aria-hidden="true">
                    <Icon name="sparkles" size={16} />
                  </span>
                  <span className="panel-empty-text" title={`${t("todayEmptyTitle")}。${t("panelEmptyBody")}`}>
                    {t("todayEmptyTitle")}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => openMain(settingsHref("integrations"))}>
                    {t("panelEmptyAction")}
                  </Button>
                </div>
              ) : (
                todaySlice.visible.map((session) => (
                  <div key={session.sessionKey} className="panel-session" title={session.title}>
                    <SourceTile source={session.source} size="sm" />
                    <span className="panel-session-title">{session.title || t("conversation")}</span>
                    <time dateTime={session.updatedAt ?? undefined} title={formatDateTime(session.updatedAt, language, timeZone)}>
                      {clockTime(session.updatedAt, timeZone)}
                    </time>
                  </div>
                ))
              )}
              {todaySlice.rest > 0 ? <p className="panel-more">{t("panelMoreSessions", { count: todaySlice.rest })}</p> : null}
            </Card>
            {topicSlice.total > 0 ? (
              <Card>
                <div className="panel-card-head">
                  <p className="panel-card-name">{t("panelTopicsLabel")}</p>
                </div>
                {topicSlice.visible.map((topic) => {
                  const count = counts.get(topic.topicId) ?? 0;
                  return (
                    <button
                      key={topic.topicId}
                      type="button"
                      className="panel-topic"
                      title={topic.name}
                      onClick={() => openMain(topicHref(topic.zone, topic.topicId))}
                    >
                      <i className={`dot ${topicDotClass(topic.status)}`} aria-hidden="true" />
                      <span className="panel-topic-name">{topic.name}</span>
                      <span className="panel-topic-meta">
                        {count > 0 ? t("groupLabel", { count }) : clockTime(topic.lastActive, timeZone)}
                      </span>
                    </button>
                  );
                })}
                {topicSlice.rest > 0 ? (
                  <button type="button" className="panel-more panel-more-link" onClick={() => openMain("/topics")}>
                    {t("panelAllTopics", { count: topicSlice.total })}
                  </button>
                ) : null}
              </Card>
            ) : null}
            {warnings.visible.length > 0 ? (
              <div className="panel-alerts">
                {warnings.visible.map((warning) => (
                  <button
                    key={warning.code}
                    type="button"
                    className="banner warn"
                    title={warning.message}
                    onClick={() => openMain("/status")}
                  >
                    <span className="banner-icon">
                      <Icon name="alert" />
                    </span>
                    <span className="banner-text">{warning.message}</span>
                  </button>
                ))}
                {warnings.rest > 0 ? <p className="panel-more panel-more-flat">{t("panelMoreWarnings", { count: warnings.rest })}</p> : null}
              </div>
            ) : null}
            {reminders.length > 0 ? (
              <div className="panel-alerts">
                <ReminderList
                  reminders={reminders}
                  layout="panel"
                  timeZone={timeZone}
                  t={t}
                  onAction={reminderAction}
                  onOpenTopic={(topicId) => openMain(topicHref(topicZone(topics, topicId), topicId))}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </PanelScroll>
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
