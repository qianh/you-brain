import { useState } from "react";

import { useDaemon } from "../daemon-context.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { BrandMark, Icon } from "../components/icons.js";
import { Row } from "../components/row.js";
import { ShowMore } from "../components/show-more.js";
import { attentionLevel, consolidationView, panelProblems, syncDot } from "../lib/copy.js";
import { formatDateTime, formatDay } from "../lib/format.js";
import { groupSessionsByTopic } from "../lib/group.js";
import { browserWindowBridge, openFullWindow, quitShell } from "../lib/window.js";

export function PanelPage() {
  const { t, language, today, reminders, status, timeZone } = useDaemon();
  const [openError, setOpenError] = useState<string | null>(null);
  const sessions = today?.sessions ?? [];
  const groups = groupSessionsByTopic(sessions, t("unassigned"));
  const problems = status ? panelProblems(status, language) : [];
  const level = status ? attentionLevel(status, problems) : "ok";
  const consolidationOff = consolidationView(status?.consolidation) === "disabled";
  const sync = formatDateTime(status?.sync.lastSyncAt ?? null, language, timeZone);
  const tone = level === "bad" ? "bad" : level === "warn" ? "warn" : "ok";
  const syncTone = syncDot(status?.sync);
  return (
    <div className="panel-frame">
      <header className="panel-top">
        <span className="brand">
          <BrandMark size={20} />
          <span>{t("brand")}</span>
        </span>
        <span className="panel-status">
          <i className={`dot dot-${tone}`} />
          <strong>{level === "ok" ? t("healthy") : t("attention")}</strong>
        </span>
      </header>
      <div className="panel-scroll">
        <Card>
          <Row
            icon={<Icon name="calendar" />}
            title={t("panelToday")}
            subtitle={today ? formatDay(today.date, language) : t("todayHint")}
            trailing={<strong>{t("panelSessionCount", { count: sessions.length })}</strong>}
          />
          {groups.length === 0 ? <EmptyState title={t("emptyToday")} icon="calendar" /> : null}
          <ShowMore items={groups} limit={5}>
            {(group) => (
              <Row
                key={group.topicId ?? "none"}
                icon={<Icon name="book" />}
                title={group.topicName}
                subtitle={
                  <>
                    <i className="dot dot-ok" />
                    <span>{group.sessions[0]?.title || t("noSummary")}</span>
                  </>
                }
                trailing={<span>{t("groupLabel", { count: group.sessions.length })}</span>}
              />
            )}
          </ShowMore>
        </Card>
        <Card>
          <Row
            icon={<Icon name="pulse" />}
            title={t("panelStatus")}
            subtitle={
              <>
                <i className={`dot dot-${syncTone}`} />
                <span>{status?.sync.lastSyncAt ? sync : t("neverSynced")}</span>
              </>
            }
            trailing={<span>{t("lastSync")}</span>}
          />
          {consolidationOff ? <p className="muted tiny panel-note">{t("consolidationDisabled")}</p> : null}
          {problems.length === 0 ? <p className="muted tiny panel-note">{t("allClear")}</p> : null}
          {problems.map((problem) => (
            <div key={problem} className="banner banner-warn panel-banner">
              {problem}
            </div>
          ))}
          {reminders.length === 0 ? (
            <Row icon={<Icon name="inbox" />} title={t("reminders")} subtitle={t("emptyReminders")} />
          ) : (
            reminders.map((reminder) => (
              <Row
                key={reminder.reminderId}
                icon={<Icon name="alert" />}
                title={reminder.text}
                subtitle={`${reminder.kind} · ${formatDateTime(reminder.issuedAt, language, timeZone)}`}
              />
            ))
          )}
        </Card>
      </div>
      <footer className="panel-footer">
        {openError ? <p className="form-error">{openError}</p> : null}
        <p className="panel-hint">{t("panelWindowHint")}</p>
        <div className="panel-actions">
          <button
            type="button"
            className="btn text"
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
          <button
            type="button"
            className="btn text"
            onClick={() => {
              void quitShell({ ...browserWindowBridge(), close: () => window.close() });
            }}
          >
            {t("quit")}
          </button>
        </div>
      </footer>
    </div>
  );
}
