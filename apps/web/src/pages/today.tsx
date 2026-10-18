import { useState } from "react";

import { useDaemon } from "../daemon-context.js";
import { Empty, SessionCard, toSessionCard } from "../components/ui.js";
import { formatDay } from "../lib/format.js";
import { groupSessionsByTopic, sortSessionsByTime } from "../lib/group.js";

export function TodayPage() {
  const { t, language, today, devices, timeZone } = useDaemon();
  const [mode, setMode] = useState<"topic" | "time">("topic");
  const sessions = today?.sessions ?? [];
  const groups = groupSessionsByTopic(sessions, t("unassigned"));
  const byTime = sortSessionsByTime(sessions);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("today")}</h1>
          <p>{today ? formatDay(today.date, language) : t("todayHint")}</p>
        </div>
        <div className="segmented" role="tablist" aria-label={t("today")}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "topic"}
            className={mode === "topic" ? "on" : ""}
            onClick={() => setMode("topic")}
          >
            {t("byTopic")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "time"}
            className={mode === "time" ? "on" : ""}
            onClick={() => setMode("time")}
          >
            {t("byTime")}
          </button>
        </div>
      </header>
      {sessions.length === 0 ? <Empty>{t("emptyToday")}</Empty> : null}
      {mode === "topic"
        ? groups.map((group) => (
            <section key={group.topicId ?? "none"} className="stack">
              <h2 className="group-title">
                <span className="topic-label">{group.topicName}</span>
                <span className="topic-count">{t("groupLabel", { count: group.sessions.length })}</span>
              </h2>
              {group.sessions.map((session) => (
                <SessionCard
                  key={session.sessionKey}
                  session={toSessionCard(session)}
                  devices={devices}
                  timeZone={timeZone}
                  language={language}
                />
              ))}
            </section>
          ))
        : byTime.map((session) => (
            <SessionCard
              key={session.sessionKey}
              session={toSessionCard(session)}
              devices={devices}
              timeZone={timeZone}
              language={language}
              showTopic
            />
          ))}
    </div>
  );
}
