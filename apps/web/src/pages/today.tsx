import { useEffect, useRef, useState } from "react";

import { useDaemon } from "../daemon-context.js";
import { Banner } from "../components/banner.js";
import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { Page, PageHeader } from "../components/page.js";
import { Segmented } from "../components/segmented.js";
import { SkeletonRow, SkeletonStat } from "../components/skeleton.js";
import { StatBlock, StatGrid } from "../components/stat.js";
import { useDelayed } from "../components/use-delayed.js";
import { useRelativeTime } from "../components/use-relative-time.js";
import { driveState, type DriveInput } from "../lib/drive-state.js";
import { settingsHref, topicHref } from "../lib/route.js";
import { useRoute } from "../router.js";
import { ReminderList } from "./reminders/list.js";
import { isUnreachableError } from "./status/logic.js";
import { TodayGroups } from "./today/groups.js";
import { StartGuide } from "./today/guide.js";
import {
  arrivedKeys,
  emptyCaptureView,
  formatCount,
  formatTodayHeading,
  guideSteps,
  readTodayMode,
  summarizeToday,
  topicZone,
  writeTodayMode,
  type TodayMode,
} from "./today/model.js";

export function TodayPage() {
  const { t, language, today, devices, timeZone, topics, status, reminders, error, loading, reload, reminderAction } = useDaemon();
  const { navigate } = useRoute();
  // The session blocks point at the list further down this page.
  const sessionsRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<TodayMode>(() => readTodayMode(storage()));
  const sessions = today?.sessions ?? [];
  const arrived = useArrived(sessions.map((session) => session.sessionKey));
  const showSkeleton = useDelayed(loading && today === null, 150);
  const offline = !loading && today === null && isUnreachableError(error);
  const stats = summarizeToday(sessions);
  const syncedAt = status?.sync.lastSyncAt ?? null;
  const relativeSync = useRelativeTime(syncedAt, language, timeZone);
  const syncValue = syncedAt ? relativeSync : t("neverSynced");
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
  const setup = emptyCaptureView(steps) === "setup";
  const changeMode = (value: string): void => {
    const next: TodayMode = value === "time" ? "time" : "topic";
    setMode(next);
    writeTodayMode(storage(), next);
  };

  return (
    <div className="today-page">
      <Page>
        <PageHeader
          title={t("today")}
          description={today ? formatTodayHeading(today.date, language) : t("todayHint")}
          actions={
            <Segmented
              label={t("today")}
              value={mode}
              options={[
                { value: "topic", label: t("byTopic") },
                { value: "time", label: t("byTime") },
              ]}
              onChange={changeMode}
            />
          }
        />
        {showSkeleton ? <TodaySkeleton /> : null}
        {offline ? (
          <EmptyState
            icon="activity"
            title={t("statusOfflineTitle")}
            description={t("statusOfflineBody")}
            action={
              <Button variant="primary" onClick={() => void reload("all")}>
                {t("statusReconnect")}
              </Button>
            }
          />
        ) : null}
        {!offline && !today && !loading && !showSkeleton ? (
          <Banner
            tone="danger"
            action={
              <Button size="sm" onClick={() => void reload("all")}>
                {t("retry")}
              </Button>
            }
          >
            <span title={error ?? ""}>{t("todayLoadError")}</span>
          </Banner>
        ) : null}
        {today ? (
          <>
            <StartGuide steps={steps} variant="page" onOpen={(section) => navigate(settingsHref(section))} />
            <Card>
              <StatGrid>
                <StatBlock
                  value={formatCount(stats.sessions, language)}
                  label={t("todayStatSessions")}
                  hint={t("todayStatSources", { count: stats.sources })}
                  zero={stats.sessions === 0}
                  english={language === "en"}
                  {...(sessions.length > 0
                    ? {
                        onSelect: () =>
                          sessionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
                      }
                    : {})}
                />
                <StatBlock
                  value={formatCount(stats.topics, language)}
                  label={t("todayStatTopics")}
                  hint={t("todayStatUnassigned", { count: stats.unassigned })}
                  zero={stats.topics === 0}
                  english={language === "en"}
                  onSelect={() => navigate(topicHref("active"))}
                />
                <StatBlock
                  value={formatCount(stats.openTodos, language)}
                  label={t("todayStatTodos")}
                  hint={t("todayStatDone", { count: stats.doneTodos })}
                  zero={stats.openTodos === 0}
                  english={language === "en"}
                  onSelect={() => navigate(topicHref("active"))}
                />
                <StatBlock
                  value={syncValue}
                  label={t("todayStatSync")}
                  hint={driveHint(status?.drive, t)}
                  zero={!syncedAt}
                  compact={!/^\d+$/.test(syncValue)}
                  english={language === "en"}
                  onSelect={() => navigate("/status")}
                />
              </StatGrid>
            </Card>
            {reminders.length > 0 ? (
              <div className="today-reminders">
                <p className="today-reminders-label">{t("reminders")}</p>
                <ReminderList
                  reminders={reminders}
                  layout="today"
                  timeZone={timeZone}
                  t={t}
                  onAction={reminderAction}
                  onOpenTopic={(topicId) => navigate(topicHref(topicZone(topics, topicId), topicId))}
                />
              </div>
            ) : null}
            {sessions.length === 0 ? (
              <EmptyState
                icon="sparkles"
                title={t("todayEmptyTitle")}
                description={setup ? t("todayEmptySetupBody") : t("todayEmptyBody")}
                action={
                  setup ? (
                    <Button variant="primary" onClick={() => navigate(settingsHref("integrations"))}>
                      {t("todaySetupCapture")}
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={() => navigate("/status")}>
                      {t("todayViewStatus")}
                    </Button>
                  )
                }
                secondary={
                  setup ? null : (
                    <Button variant="ghost" onClick={() => navigate(settingsHref("integrations"))}>
                      {t("todaySetupCapture")}
                    </Button>
                  )
                }
              />
            ) : (
              <div ref={sessionsRef}>
                <TodayGroups
                  mode={mode}
                  sessions={sessions}
                  devices={devices}
                  language={language}
                  timeZone={timeZone}
                  topics={topics}
                  arrived={arrived}
                />
              </div>
            )}
          </>
        ) : null}
      </Page>
    </div>
  );
}

function TodaySkeleton() {
  return (
    <>
      <Card>
        <div className="stat-grid today-skel-stats" aria-hidden="true">
          <SkeletonStat />
          <SkeletonStat />
          <SkeletonStat />
          <SkeletonStat />
        </div>
      </Card>
      <Card>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </Card>
    </>
  );
}

function driveHint(
  drive: DriveInput | null | undefined,
  t: (key: "driveOk" | "driveDown" | "driveSignedOut" | "driveChecking") => string,
): string {
  const state = driveState(drive);
  if (state === "connected") return t("driveOk");
  if (state === "offline") return t("driveDown");
  if (state === "signedOut") return t("driveSignedOut");
  return t("driveChecking");
}

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function useArrived(keys: readonly string[]): ReadonlySet<string> {
  const previous = useRef<ReadonlySet<string> | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() => new Set());
  const signature = keys.join("\n");
  useEffect(() => {
    const next = signature === "" ? [] : signature.split("\n");
    const fresh = arrivedKeys(previous.current, next);
    previous.current = new Set(next);
    if (fresh.length === 0) return;
    setArrived(new Set(fresh));
    const timer = window.setTimeout(() => setArrived(new Set()), 1200);
    return () => window.clearTimeout(timer);
  }, [signature]);
  return arrived;
}
