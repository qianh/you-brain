import { useState } from "react";
import type { SharedConfig } from "@you-brain/protocol";

import { BrowserDaemonError } from "../api/client.js";
import { Button } from "../components/button.js";
import { Card, Section } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { Icon } from "../components/icons.js";
import { PageHeader } from "../components/page.js";
import { Row } from "../components/row.js";
import { SkeletonStat } from "../components/skeleton.js";
import { StatBlock, StatGrid } from "../components/stat.js";
import { useToast } from "../components/toast.js";
import { useDelayed } from "../components/use-delayed.js";
import { useRelativeTime } from "../components/use-relative-time.js";
import { useDaemon } from "../daemon-context.js";
import { consolidationView, readLogs } from "../lib/copy.js";
import { driveState, needsDriveLogin } from "../lib/drive-state.js";
import { formatDateTime } from "../lib/format.js";
import { settingsHref } from "../lib/route.js";
import { useRoute } from "../router.js";
import { AttentionList } from "./status/attention.js";
import { CaptureGrid } from "./status/captures.js";
import { Connections } from "./status/connections.js";
import { StatusHero } from "./status/hero.js";
import {
  attentionItems,
  captureViews,
  heroFault,
  heroKind,
  logsBesideWarnings,
  statusScreen,
  syncLine,
  withConsolidationWarning,
  withDriveSignedOutWarning,
} from "./status/logic.js";

export function StatusPage() {
  const { t, language, status, config, timeZone, loading, error, reload, client } = useDaemon();
  const { navigate } = useRoute();
  const { push } = useToast();
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const screen = statusScreen({ loading, hasStatus: status !== null, error });
  const delayed = useDelayed(screen === "loading");
  const line = syncLine(status?.sync);
  const syncIso = line.at;
  const finishedAt = status?.consolidation.lastFinishedAt ?? null;
  const syncRelative = useRelativeTime(syncIso, language, timeZone);
  const finishedRelative = useRelativeTime(finishedAt, language, timeZone);
  const syncAbsolute = formatDateTime(syncIso, language, timeZone);
  const syncError = line.message;
  const syncLabel = line.tone === "bad" ? t("statusSyncErrorLabel") : t("lastSync");
  const syncValue =
    line.tone === "bad"
      ? line.at
        ? t("statusSyncFailedAt", { time: syncRelative })
        : ""
      : line.tone === "ok"
        ? syncRelative
        : t("neverSynced");

  async function refresh() {
    setRefreshing(true);
    const ok = await reload("all");
    setRefreshing(false);
    if (!ok) push({ message: t("refreshFailed"), tone: "danger" });
  }

  async function sync() {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await client.sync();
      if (!result.started) {
        push({ message: t("syncFailed"), tone: "danger" });
        return;
      }
      push({ message: t("syncStarted"), tone: "success" });
      await reload("status");
    } catch {
      push({ message: t("syncFailed"), tone: "danger" });
    } finally {
      setSyncing(false);
    }
  }

  async function login() {
    if (loginBusy) return;
    setLoginBusy(true);
    try {
      const result = await client.googleLogin();
      push({ message: result.message || t("loginStarted"), tone: "success" });
      await reload("status");
    } catch (caught) {
      const message = caught instanceof BrowserDaemonError && caught.message !== "" ? caught.message : t("actionFailed");
      push({ message, tone: "danger" });
    } finally {
      setLoginBusy(false);
    }
  }

  const view = consolidationView(status?.consolidation);
  const warnings = withDriveSignedOutWarning(
    withConsolidationWarning(status?.warnings ?? [], view === "stale", t("consolidationStale")),
    needsDriveLogin(driveState(status?.drive), status?.warnings ?? []),
    t("statusDriveSignedOut"),
  );
  const items = attentionItems(warnings);
  const kind = heroKind({
    loading: screen === "loading",
    hasStatus: status !== null,
    driveReachable: status?.drive.reachable ?? null,
    driveEmail: status?.drive.accountEmail ?? null,
    refineError: status?.refine.lastError ?? null,
    syncError,
    warningCount: items.length,
  });
  const fault = heroFault({
    loading: screen === "loading",
    hasStatus: status !== null,
    driveReachable: status?.drive.reachable ?? null,
    driveEmail: status?.drive.accountEmail ?? null,
    refineError: status?.refine.lastError ?? null,
    syncError,
    warningCount: items.length,
  });
  const refineError = (status?.refine.lastError ?? "").trim();
  const heroTitle =
    kind === "loading"
      ? t("statusLoadingTitle")
      : kind === "danger"
        ? t(fault === "refine" ? "statusRefineBroken" : fault === "drive" ? "statusDriveOffline" : "statusSyncBroken")
        : kind === "warn"
          ? t("statusNeedsWork", { count: items.length })
          : t("statusAllClear");
  const heroBody =
    kind === "loading"
      ? t("statusLoadingBody")
      : kind === "danger" && fault === "refine"
        ? refineError || t("statusRefineBroken")
        : kind === "danger" && fault === "drive"
          ? t("statusDriveOfflineBody")
          : kind === "danger"
            ? syncError || t("statusSyncBrokenBody")
            : kind === "warn"
              ? t("statusNeedsWorkBody")
              : t("statusAllClearBody");
  const logs = logsBesideWarnings(readLogs(status), warnings);

  return (
    <div className="status-page">
      <PageHeader
        title={t("statusPage")}
        description={t("statusLead")}
        actions={
          screen === "ready" ? (
            <>
              <Button
                variant="secondary"
                icon={<Icon name="refresh" />}
                loading={refreshing}
                onClick={() => void refresh()}
              >
                {t("reload")}
              </Button>
              <Button variant="primary" icon={<Icon name="refresh" />} loading={syncing} onClick={() => void sync()}>
                {t("cmdSync")}
              </Button>
            </>
          ) : null
        }
      />
      {screen === "loading" ? (
        delayed ? (
          <StatusSkeleton />
        ) : (
          <div className="status-hold" aria-busy="true" />
        )
      ) : null}
      {screen === "offline" ? (
        <EmptyState
          icon="activity"
          title={t("statusOfflineTitle")}
          description={t("statusOfflineBody")}
          action={
            <Button variant="primary" loading={refreshing} onClick={() => void refresh()}>
              {t("statusReconnect")}
            </Button>
          }
        />
      ) : null}
      {screen === "error" ? (
        <EmptyState
          icon="alert-circle"
          title={t("statusUnavailable")}
          description={t("statusUnavailableBody")}
          action={
            <Button variant="primary" loading={refreshing} onClick={() => void refresh()}>
              {t("retry")}
            </Button>
          }
        />
      ) : null}
      {screen === "ready" && status ? (
        <div className="status-stack">
          <StatusHero
            tone={kind}
            title={heroTitle}
            body={heroBody}
            syncLabel={syncLabel}
            syncValue={syncValue}
            syncIso={line.tone === "muted" ? null : syncIso}
            syncAbsolute={syncAbsolute}
            syncFault={syncError}
          />
          <AttentionList
            items={items}
            syncing={syncing}
            loginBusy={loginBusy}
            t={t}
            onSync={() => void sync()}
            onModel={() => navigate(settingsHref("model"))}
            onLogin={() => void login()}
          />
          <Card>
            <StatGrid>
              <StatBlock
                value={String(status.sync.pendingOutbox)}
                label={t("statPending")}
                hint={status.sync.pendingOutbox === 0 ? t("statusAllSynced") : t("outboxLine", { count: status.sync.pendingOutbox })}
                english={language === "en"}
              />
              <StatBlock
                value={String(status.search.documents)}
                label={t("statusStatDocs")}
                hint={status.search.ready ? t("statusIndexReady") : t("notReady")}
                english={language === "en"}
              />
              <StatBlock
                value={String(status.refine.pending)}
                label={t("statusStatRefine")}
                hint={status.refine.pending === 0 ? t("statusNoBacklog") : t("statusRefineBusy", { count: status.refine.pending })}
                english={language === "en"}
              />
              <StatBlock
                value={view === "disabled" || view === "unknown" ? t("disabledLabel") : t("statusEnabled")}
                compact
                label={t("statusStatDaily")}
                hint={consolidationHint(view, finishedAt, finishedRelative, t)}
                english={language === "en"}
              />
            </StatGrid>
          </Card>
          <Connections status={status} language={language} timeZone={timeZone} t={t} />
          <CaptureGrid
            rows={captureViews(status, sourceEnabled(config))}
            language={language}
            timeZone={timeZone}
            t={t}
            onSettings={() => navigate(settingsHref("capture"))}
          />
          {logs.length > 0 ? (
            <Section title={t("errorLog")}>
              <Card>
                {logs.map((row, index) => (
                  <LogRow key={`${row.at ?? "log"}-${index}`} at={row.at} message={row.message} language={language} timeZone={timeZone} fallback={t("noneYet")} />
                ))}
              </Card>
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function consolidationHint(
  view: ReturnType<typeof consolidationView>,
  at: string | null,
  relative: string,
  t: (key: "statusConsolidationOff" | "statusLastRun" | "consolidationNever" | "consolidationStale", vars?: Record<string, string | number>) => string,
): string {
  if (view === "disabled" || view === "unknown") return t("statusConsolidationOff");
  if (view === "stale") return t("consolidationStale");
  if (at) return t("statusLastRun", { time: relative });
  return t("consolidationNever");
}

function sourceEnabled(config: SharedConfig | null): Record<string, boolean> | null {
  if (!config) return null;
  const sources = config.capture.sources;
  return {
    "claude-code": sources["claude-code"].enabled,
    codex: sources.codex.enabled,
    "grok-build": sources["grok-build"].enabled,
    cursor: sources.cursor.enabled,
    "gemini-cli": sources["gemini-cli"].enabled,
  };
}

function LogRow({
  at,
  message,
  language,
  timeZone,
  fallback,
}: {
  at: string | null;
  message: string;
  language: "zh" | "en";
  timeZone: string;
  fallback: string;
}) {
  const relative = useRelativeTime(at, language, timeZone);
  const absolute = formatDateTime(at, language, timeZone);
  return (
    <Row
      icon={<i className="dot dot-warn" aria-hidden="true" />}
      title={message}
      titleText={message}
      subtitle={at ? <time dateTime={at} title={absolute}>{relative}</time> : fallback}
    />
  );
}

function StatusSkeleton() {
  return (
    <div className="status-stack" aria-hidden="true">
      <div className="status-hero tone-loading">
        <span className="status-hero-badge" />
      </div>
      <Card>
        <StatGrid>
          <SkeletonStat />
          <SkeletonStat />
          <SkeletonStat />
          <SkeletonStat />
        </StatGrid>
      </Card>
    </div>
  );
}
