import type { TopicSessionLink, TodaySession } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { deviceLabel, driveFileUrl, formatDateTime, sourceLabel, type Language } from "../lib/format.js";
import type { NamedDevice } from "../lib/format.js";
import { SourceMark } from "./icons.js";
import { Row } from "./row.js";

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
}

export function toSessionCard(session: TodaySession | TopicSessionLink): SessionCardModel {
  return {
    sessionKey: session.sessionKey,
    source: session.source,
    device: session.device,
    fileId: session.fileId,
    title: session.title,
    summary: session.summary,
    updatedAt: session.updatedAt,
    ...("startedAt" in session ? { startedAt: session.startedAt } : {}),
    ...("topicName" in session ? { topicName: session.topicName } : {}),
  };
}

export function SessionRow({
  session,
  devices,
  timeZone,
  language,
  showTopic = false,
}: {
  session: SessionCardModel;
  devices: readonly NamedDevice[];
  timeZone: string;
  language: Language;
  showTopic?: boolean;
}) {
  const { t } = useDaemon();
  const when = formatDateTime(session.updatedAt ?? session.startedAt ?? null, language, timeZone);
  const summary = session.summary || t("noSummary");
  return (
    <Row
      className="keep"
      icon={<SourceMark source={session.source} />}
      title={session.title || t("conversation")}
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
          <time dateTime={session.updatedAt ?? session.startedAt ?? undefined}>{when}</time>
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
