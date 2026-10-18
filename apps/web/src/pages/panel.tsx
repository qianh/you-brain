import { useState } from "react";

import { useDaemon } from "../daemon-context.js";
import { Empty, SessionCard, toSessionCard } from "../components/ui.js";
import { attentionLevel, panelProblems } from "../lib/copy.js";
import { formatDateTime, formatDay } from "../lib/format.js";
import { groupSessionsByTopic } from "../lib/group.js";
import { browserWindowBridge, openFullWindow } from "../lib/window.js";

export function PanelPage() {
  const { t, language, today, reminders, status, devices, timeZone } = useDaemon();
  const [openError, setOpenError] = useState<string | null>(null);
  const groups = groupSessionsByTopic(today?.sessions ?? [], t("unassigned"));
  const problems = status ? panelProblems(status, language) : [];
  const level = status ? attentionLevel(status, problems) : "ok";
  const sync = formatDateTime(status?.sync.lastSyncAt ?? null, language, timeZone);
  return (
    <div className="panel-frame">
      <header className="panel-head">
        <div>
          <strong>{t("brand")}</strong>
          <small>{today ? formatDay(today.date, language) : t("tagline")}</small>
        </div>
        <span className={`dot dot-${level}`} title={level === "ok" ? t("healthy") : t("attention")} />
      </header>
      <div className="panel-scroll">
        <section className="panel-section">
        <h2>{t("panelToday")}</h2>
        {groups.length === 0 ? <Empty>{t("emptyToday")}</Empty> : null}
        {groups.map((group) => (
          <div key={group.topicId ?? "none"} className="topic-block">
            <h3>
              {group.topicName}
              <span>{t("groupLabel", { count: group.sessions.length })}</span>
            </h3>
            {group.sessions.map((session) => (
              <SessionCard
                key={session.sessionKey}
                session={toSessionCard(session)}
                devices={devices}
                timeZone={timeZone}
                language={language}
                compact
              />
            ))}
          </div>
        ))}
        </section>
        <section className="panel-section">
        <h2>{t("reminders")}</h2>
        {reminders.length === 0 ? <Empty>{t("emptyReminders")}</Empty> : null}
        {reminders.map((reminder) => (
          <article key={reminder.reminderId} className="reminder">
            <strong>{reminder.text}</strong>
            <small>
              {reminder.kind} · {formatDateTime(reminder.issuedAt, language, timeZone)}
            </small>
          </article>
        ))}
        </section>
        <section className="panel-section">
        <h2>{t("panelStatus")}</h2>
        <p className="sync-line">
          <span>{t("lastSync")}</span>
          <strong>{status?.sync.lastSyncAt ? sync : t("neverSynced")}</strong>
        </p>
        {problems.length === 0 ? <p className="muted">{t("allClear")}</p> : null}
        {problems.length > 0 ? (
          <ul className="problem-list">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        </section>
      </div>
      <footer className="panel-footer">
        {openError ? <p className="form-error">{openError}</p> : null}
        <button
          type="button"
          className="btn primary wide"
          onClick={() => {
            setOpenError(null);
            void openFullWindow(browserWindowBridge())
              .then((mode) => {
                if (mode === "blocked") setOpenError(t("popupBlocked"));
              })
              .catch(() => setOpenError(t("popupBlocked")));
          }}
        >
          {t("openWindow")}
        </button>
        <p className="muted tiny">{t("panelWindowHint")}</p>
      </footer>
    </div>
  );
}
