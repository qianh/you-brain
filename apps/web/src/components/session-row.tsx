import { useState } from "react";
import type { ConclusionView, TodoView, TodaySession, TopicSessionLink } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { deviceLabel, driveFileUrl, formatDateTime, formatRelative, sourceLabel, type Language } from "../lib/format.js";
import type { NamedDevice } from "../lib/format.js";
import { useRelativeTime } from "./use-relative-time.js";
import { Chip } from "./chip.js";
import { Icon } from "./icons.js";
import { Row } from "./row.js";
import { SourceTile } from "./tile.js";
import { Tooltip } from "./tooltip.js";

export interface SessionCardModel {
  sessionKey: string;
  source: string;
  device: string;
  fileId: string | null;
  title: string;
  summary: string;
  updatedAt: string | null;
  startedAt?: string | null;
  topicName?: string | null;
  topicId?: string | null;
  msgCount?: number;
  conclusions?: readonly ConclusionView[];
  todos?: readonly TodoView[];
}

export function toSessionCard(session: TodaySession | TopicSessionLink): SessionCardModel {
  const card: SessionCardModel = {
    sessionKey: session.sessionKey,
    source: session.source,
    device: session.device,
    fileId: session.fileId,
    title: session.title,
    summary: session.summary,
    updatedAt: session.updatedAt,
  };
  if ("startedAt" in session) card.startedAt = session.startedAt;
  if ("topicName" in session) card.topicName = session.topicName;
  if ("topicId" in session) card.topicId = session.topicId;
  if ("msgCount" in session) card.msgCount = session.msgCount;
  if ("conclusions" in session) card.conclusions = session.conclusions;
  if ("todos" in session) card.todos = session.todos;
  return card;
}

function momentOf(session: SessionCardModel): string | null {
  if (session.updatedAt !== null && session.updatedAt !== "") return session.updatedAt;
  if (session.startedAt !== undefined && session.startedAt !== null && session.startedAt !== "") return session.startedAt;
  return null;
}

export function SessionRow({
  session,
  devices,
  timeZone,
  language,
  showTopic = false,
  variant = "compact",
  arrived = false,
}: {
  session: SessionCardModel;
  devices: readonly NamedDevice[];
  timeZone: string;
  language: Language;
  showTopic?: boolean;
  variant?: "compact" | "today";
  arrived?: boolean;
}) {
  if (variant === "today") {
    return (
      <TodaySessionRow
        session={session}
        devices={devices}
        timeZone={timeZone}
        language={language}
        showTopic={showTopic}
        arrived={arrived}
      />
    );
  }
  return (
    <CompactSessionRow session={session} devices={devices} timeZone={timeZone} language={language} showTopic={showTopic} />
  );
}

function CompactSessionRow({
  session,
  devices,
  timeZone,
  language,
  showTopic,
}: {
  session: SessionCardModel;
  devices: readonly NamedDevice[];
  timeZone: string;
  language: Language;
  showTopic: boolean;
}) {
  const { t } = useDaemon();
  const when = formatDateTime(momentOf(session), language, timeZone);
  const summary = session.summary || t("noSummary");
  return (
    <Row
      className="keep"
      icon={<SourceTile source={session.source} />}
      title={session.title || t("conversation")}
      titleText={session.title || t("conversation")}
      subtitle={
        <>
          <i className={session.fileId ? "dot dot-ok" : "dot dot-muted"} />
          <span>{sourceLabel(session.source)}</span>
          <span>{" · "}{deviceLabel(session.device, devices)}</span>
          {showTopic && session.topicName ? <span>{" · "}{session.topicName}</span> : null}
          <span>{" · "}{summary}</span>
        </>
      }
      trailing={
        <>
          <time dateTime={momentOf(session) ?? undefined}>{when}</time>
          {session.fileId ? (
            <a className="text-link" href={driveFileUrl(session.fileId)} target="_blank" rel="noreferrer">
              {t("openDrive")}
            </a>
          ) : (
            <span className="muted tiny">{t("noDrive")}</span>
          )}
        </>
      }
    />
  );
}

function TodaySessionRow({
  session,
  devices,
  timeZone,
  language,
  showTopic,
  arrived,
}: {
  session: SessionCardModel;
  devices: readonly NamedDevice[];
  timeZone: string;
  language: Language;
  showTopic: boolean;
  arrived: boolean;
}) {
  const { t } = useDaemon();
  const [open, setOpen] = useState(false);
  const iso = momentOf(session);
  const relative = useRelativeTime(iso, language, timeZone);
  const absolute = formatDateTime(iso, language, timeZone);
  const title = session.title || t("conversation");
  const conclusions = session.conclusions ?? [];
  const todos = session.todos ?? [];
  const detailId = `session-detail-${session.sessionKey}`;
  const classes = ["today-session", arrived ? "is-arrived" : "", open ? "is-open" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-session-key={session.sessionKey}>
      <button
        type="button"
        className="today-session-open"
        data-session-row=""
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="row-lead">
          <SourceTile source={session.source} />
        </span>
        <span className="today-session-copy">
          <span className="row-title" title={title}>
            {title}
          </span>
          <span className="today-meta">
            <Tooltip content={session.fileId ? t("todayOnDrive") : t("todayPendingDrive")}>
              <i className={session.fileId ? "dot dot-ok" : "dot dot-muted"} />
            </Tooltip>
            <span className="today-meta-text">
              {sourceLabel(session.source)}
              {" · "}
              {deviceLabel(session.device, devices)}
              {" · "}
              <time dateTime={iso ?? undefined} title={absolute}>
                {relative}
              </time>
            </span>
          </span>
          {session.summary ? <span className="today-summary">{session.summary}</span> : null}
        </span>
        <span className="today-session-side">
          {showTopic ? (
            <Chip className="today-topic-chip">{session.topicName || t("unassigned")}</Chip>
          ) : null}
          {typeof session.msgCount === "number" ? <Chip>{t("todayMsgCount", { count: session.msgCount })}</Chip> : null}
          <span className="today-drive-slot" aria-hidden="true" />
          <span className={open ? "row-chevron is-open" : "row-chevron"}>
            <Icon name="chevron-down" />
          </span>
        </span>
      </button>
      <span className="today-drive">
        {session.fileId ? (
          <Tooltip content={t("openDrive")}>
            <a
              className="icon-btn"
              href={driveFileUrl(session.fileId)}
              target="_blank"
              rel="noreferrer"
              aria-label={t("openDrive")}
            >
              <Icon name="external-link" />
            </a>
          </Tooltip>
        ) : (
          <Tooltip content={t("todayPendingDrive")}>
            <button type="button" className="icon-btn" disabled aria-label={t("todayPendingDrive")}>
              <Icon name="external-link" />
            </button>
          </Tooltip>
        )}
      </span>
      {open ? (
        <div className="today-detail" id={detailId}>
          <SessionDetail
            conclusions={conclusions}
            todos={todos}
            language={language}
            timeZone={timeZone}
            english={language === "en"}
          />
        </div>
      ) : null}
    </div>
  );
}

function SessionDetail({
  conclusions,
  todos,
  language,
  timeZone,
  english,
}: {
  conclusions: readonly ConclusionView[];
  todos: readonly TodoView[];
  language: Language;
  timeZone: string;
  english: boolean;
}) {
  const { t } = useDaemon();
  if (conclusions.length === 0 && todos.length === 0) {
    return <p className="today-quiet">{t("todayNoRefined")}</p>;
  }
  const kicker = english ? "today-kicker en" : "today-kicker";
  return (
    <>
      {conclusions.length > 0 ? (
        <section>
          <p className={kicker}>{t("conclusions")}</p>
          <ul className="today-points">
            {conclusions.map((item) => (
              <li key={item.conclusionId} className="today-point">
                <i className="today-bullet" aria-hidden="true" />
                <span className="today-point-text">{item.text}</span>
                <time dateTime={item.ts} title={formatDateTime(item.ts, language, timeZone)}>
                  {formatRelative(item.ts, language, timeZone)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {todos.length > 0 ? (
        <section>
          <p className={kicker}>{t("todos")}</p>
          <ul className="today-points">
            {todos.map((item) => (
              <li key={item.todoId} className={item.status === "open" ? "today-todo" : `today-todo is-${item.status}`}>
                <i className="dot" aria-hidden="true" />
                <span className="today-todo-text">{item.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
