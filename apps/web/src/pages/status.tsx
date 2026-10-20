import { useDaemon } from "../daemon-context.js";
import { Banner } from "../components/ui.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { SourceMark } from "../components/icons.js";
import { Row } from "../components/row.js";
import { StatBlock, StatGrid } from "../components/stat.js";
import { consolidationView, readCaptures, readLogs } from "../lib/copy.js";
import { formatDateTime, sourceLabel } from "../lib/format.js";

export function StatusPage() {
  const { t, language, status, timeZone } = useDaemon();
  const captures = readCaptures(status);
  const extraLogs = readLogs(status);
  const warnings = status?.warnings ?? [];
  const consolidation = consolidationView(status?.consolidation);
  const logs = [
    ...extraLogs,
    ...warnings
      .filter((warning) => warning.message.trim() !== "")
      .map((warning) => ({ at: null as string | null, message: `${warning.code}: ${warning.message}` })),
  ];
  const pending = status?.sync.pendingOutbox ?? 0;
  const retries = status?.refine.pending ?? 0;
  const documents = status?.search.documents ?? 0;
  const syncAt = formatDateTime(status?.sync.lastSyncAt ?? null, language, timeZone);
  const consolidationValue =
    consolidation === "disabled"
      ? t("disabledLabel")
      : status?.consolidation.lastFinishedAt
        ? formatDateTime(status.consolidation.lastFinishedAt, language, timeZone)
        : t("consolidationNever");
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("statusPage")}</h1>
          <p>{t("statusHint")}</p>
        </div>
      </header>
      {status?.drive.reachable === false ? <Banner tone="bad">{t("driveDown")}</Banner> : null}
      {status?.refine.lastError ? <Banner tone="warn">{status.refine.lastError}</Banner> : null}
      {warnings.map((warning) =>
        warning.message.trim() === "" ? null : (
          <Banner key={`${warning.code}-${warning.message}`} tone="warn">
            {warning.message}
          </Banner>
        ),
      )}
      {consolidation === "stale" ? <Banner tone="warn">{t("consolidationStale")}</Banner> : null}
      <Card>
        <StatGrid>
          <StatBlock
            value={String(pending)}
            label={t("statPending")}
            hint={status?.sync.lastSyncAt ? `${t("lastSync")} · ${syncAt}` : t("neverSynced")}
          />
          <StatBlock
            value={String(documents)}
            label={t("statDocuments")}
            hint={status?.search.ready ? t("ready") : t("notReady")}
          />
          <StatBlock
            value={String(retries)}
            label={t("statRetries")}
            hint={retries === 0 ? t("queueIdle") : t("refineLine", { count: retries })}
          />
          <StatBlock
            value={consolidationValue}
            compact={consolidationValue.length > 6}
            label={t("consolidation")}
            hint={
              consolidation === "disabled"
                ? t("consolidationDisabled")
                : consolidation === "stale"
                  ? t("consolidationStale")
                  : t("healthy")
            }
          />
        </StatGrid>
      </Card>
      <Card>
        <Row
          title={t("reachable")}
          subtitle={
            <>
              <i
                className={
                  status?.drive.reachable === true
                    ? "dot dot-ok"
                    : status?.drive.reachable === false
                      ? "dot dot-bad"
                      : "dot dot-muted"
                }
              />
              <span>
                {status?.drive.reachable === true
                  ? t("driveOk")
                  : status?.drive.reachable === false
                    ? t("driveDown")
                    : t("driveUnknown")}
              </span>
              <span>{" · "}{status?.drive.accountEmail || t("notSignedIn")}</span>
            </>
          }
          trailing={<span>{pending === 0 ? t("queueIdle") : t("outboxLine", { count: pending })}</span>}
        />
      </Card>
      <section className="stack">
        <h2 className="group-label">
          <span>{t("captures")}</span>
        </h2>
        {captures.length === 0 ? <EmptyState title={t("emptyCaptures")} icon="inbox" /> : null}
        {captures.length > 0 ? (
          <Card>
            {captures.map((row) => (
              <Row
                key={row.source}
                icon={<SourceMark source={row.source} />}
                title={sourceLabel(row.source)}
                subtitle={
                  <>
                    <i className={row.error ? "dot dot-bad" : row.lastCaptureAt ? "dot dot-ok" : "dot dot-muted"} />
                    <span>
                      {row.lastCaptureAt
                        ? formatDateTime(row.lastCaptureAt, language, timeZone)
                        : t("capturedNever")}
                    </span>
                    {row.error ? <span>{" · "}{row.error}</span> : null}
                  </>
                }
                {...(row.error ? {} : { trailing: <span>{t("noneYet")}</span> })}
              />
            ))}
          </Card>
        ) : null}
      </section>
      <section className="stack">
        <h2 className="group-label">
          <span>{t("errorLog")}</span>
        </h2>
        {logs.length === 0 ? <EmptyState title={t("emptyLogs")} icon="inbox" /> : null}
        {logs.length > 0 ? (
          <Card>
            {logs.map((row, index) => (
              <Row
                key={`${row.at ?? "log"}-${index}`}
                icon={<i className="dot dot-warn" />}
                title={row.message}
                subtitle={row.at ? formatDateTime(row.at, language, timeZone) : t("noneYet")}
              />
            ))}
          </Card>
        ) : null}
      </section>
    </div>
  );
}
