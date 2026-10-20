import { useState } from "react";

import { useDaemon } from "../daemon-context.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { Segmented } from "../components/segmented.js";
import { SessionRow, toSessionCard } from "../components/session-row.js";
import { ShowMore } from "../components/show-more.js";
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
        <Segmented
          label={t("today")}
          value={mode}
          options={[
            { value: "topic", label: t("byTopic") },
            { value: "time", label: t("byTime") },
          ]}
          onChange={(value) => setMode(value === "time" ? "time" : "topic")}
        />
      </header>
      {sessions.length === 0 ? <EmptyState title={t("emptyToday")} icon="calendar" /> : null}
      {sessions.length > 0 && mode === "topic"
        ? groups.map((group) => (
            <section key={group.topicId ?? "none"} className="stack">
              <h2 className="group-label">
                <span>{group.topicName}</span>
                <span>{t("groupLabel", { count: group.sessions.length })}</span>
              </h2>
              <Card>
                <ShowMore items={group.sessions}>
                  {(session) => (
                    <SessionRow
                      key={session.sessionKey}
                      session={toSessionCard(session)}
                      devices={devices}
                      timeZone={timeZone}
                      language={language}
                    />
                  )}
                </ShowMore>
              </Card>
            </section>
          ))
        : null}
      {sessions.length > 0 && mode === "time" ? (
        <Card>
          <ShowMore items={byTime}>
            {(session) => (
              <SessionRow
                key={session.sessionKey}
                session={toSessionCard(session)}
                devices={devices}
                timeZone={timeZone}
                language={language}
                showTopic
              />
            )}
          </ShowMore>
        </Card>
      ) : null}
    </div>
  );
}
