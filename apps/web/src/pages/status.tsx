import { useDaemon } from "../daemon-context.js";
import { readCaptures, readLogs } from "../lib/copy.js";
import { formatDateTime, sourceLabel } from "../lib/format.js";

export function StatusPage() {
  const { t, language, status, timeZone } = useDaemon();
  const captures = readCaptures(status);
  const extraLogs = readLogs(status);
  const warnings = status?.warnings ?? [];
  const logs = [
    ...extraLogs,
    ...warnings
      .filter((warning) => warning.message.trim() !== "")
      .map((warning) => ({ at: null as string | null, message: `${warning.code}: ${warning.message}` })),
  ];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("statusPage")}</h1>
          <p>{t("statusHint")}</p>
        </div>
      </header>
      <section className="stat-grid">
        <article className="card">
          <h2>{t("reachable")}</h2>
          <p>
            {status?.drive.reachable === true
              ? t("driveOk")
              : status?.drive.reachable === false
                ? t("driveDown")
                : t("driveUnknown")}
          </p>
          <p className="muted">{status?.drive.accountEmail || t("notSignedIn")}</p>
        </article>
        <article className="card">
          <h2>{t("lastSync")}</h2>
          <p>{formatDateTime(status?.sync.lastSyncAt ?? null, language, timeZone)}</p>
          <p className="muted">{t("outboxLine", { count: status?.sync.pendingOutbox ?? 0 })}</p>
        </article>
        <article className="card">
          <h2>{t("refineQueue")}</h2>
          <p>{t("refineLine", { count: status?.refine.pending ?? 0 })}</p>
          <p className="muted">{status?.refine.lastError || t("noRefineError")}</p>
        </article>
        <article className="card">
          <h2>{t("consolidation")}</h2>
          <p>
            {status?.consolidation.lastFinishedAt
              ? formatDateTime(status.consolidation.lastFinishedAt, language, timeZone)
              : t("consolidationNever")}
          </p>
          <p className={status?.consolidation.stale ? "warn-text" : "muted"}>
            {status?.consolidation.stale ? t("consolidationStale") : t("healthy")}
          </p>
        </article>
        <article className="card">
          <h2>{t("searchIndex")}</h2>
          <p>{status?.search.ready ? t("ready") : t("notReady")}</p>
          <p className="muted">{t("documents", { count: status?.search.documents ?? 0 })}</p>
        </article>
      </section>

      <section>
        <h2>{t("captures")}</h2>
        {captures.length === 0 ? <p className="empty">{t("emptyCaptures")}</p> : null}
        {captures.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>{t("sourceColumn")}</th>
                <th>{t("whenColumn")}</th>
                <th>{t("errorColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {captures.map((row) => (
                <tr key={row.source}>
                  <td>{sourceLabel(row.source)}</td>
                  <td>
                    {row.lastCaptureAt
                      ? formatDateTime(row.lastCaptureAt, language, timeZone)
                      : t("capturedNever")}
                  </td>
                  <td>{row.error ?? t("noneYet")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section>
        <h2>{t("syncQueue")}</h2>
        <p>
          {(status?.sync.pendingOutbox ?? 0) === 0
            ? t("queueIdle")
            : t("outboxLine", { count: status?.sync.pendingOutbox ?? 0 })}
        </p>
      </section>

      <section>
        <h2>{t("refineQueue")}</h2>
        <p>
          {(status?.refine.pending ?? 0) === 0
            ? t("queueIdle")
            : t("refineLine", { count: status?.refine.pending ?? 0 })}
        </p>
        <p className="muted">{status?.refine.lastError || t("noRefineError")}</p>
      </section>

      <section>
        <h2>{t("errorLog")}</h2>
        {logs.length === 0 ? <p className="empty">{t("emptyLogs")}</p> : null}
        {logs.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>{t("atColumn")}</th>
                <th>{t("messageColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((row, index) => (
                <tr key={`${row.at ?? "log"}-${index}`}>
                  <td>{row.at ? formatDateTime(row.at, language, timeZone) : t("noneYet")}</td>
                  <td>{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </div>
  );
}
