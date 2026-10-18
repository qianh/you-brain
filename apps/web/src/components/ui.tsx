import type { ReactNode } from "react";
import type { TopicSessionLink, TodaySession } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { deviceLabel, driveFileUrl, formatDateTime, sourceLabel, type Language } from "../lib/format.js";
import type { NamedDevice } from "../lib/format.js";
import { parseInline, parseMarkdown } from "../lib/markdown.js";
import type { MessageKey } from "../i18n/messages.js";

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Banner({
  tone,
  children,
}: {
  tone: "warn" | "bad" | "ok" | "info";
  children: ReactNode;
}) {
  return <div className={`banner banner-${tone}`}>{children}</div>;
}

export function InlineText({ text }: { text: string }) {
  const nodes = parseInline(text);
  return (
    <>
      {nodes.map((node, index) => {
        const key = `${node.kind}-${index}`;
        if (node.kind === "strong") return <strong key={key}>{node.text}</strong>;
        if (node.kind === "em") return <em key={key}>{node.text}</em>;
        if (node.kind === "code") return <code key={key}>{node.text}</code>;
        if (node.kind === "link" && node.href) {
          return (
            <a key={key} href={node.href} target="_blank" rel="noreferrer">
              {node.text}
            </a>
          );
        }
        return <span key={key}>{node.text}</span>;
      })}
    </>
  );
}

export function MarkdownView({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return null;
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "heading" && block.level === 1) {
          return (
            <h2 key={key}>
              <InlineText text={block.text} />
            </h2>
          );
        }
        if (block.kind === "heading" && block.level === 2) {
          return (
            <h3 key={key}>
              <InlineText text={block.text} />
            </h3>
          );
        }
        if (block.kind === "heading") {
          return (
            <h4 key={key}>
              <InlineText text={block.text} />
            </h4>
          );
        }
        if (block.kind === "list" && block.ordered) {
          return (
            <ol key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <InlineText text={item} />
                </li>
              ))}
            </ol>
          );
        }
        if (block.kind === "list") {
          return (
            <ul key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <InlineText text={item} />
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === "quote") {
          return (
            <blockquote key={key}>
              <InlineText text={block.text} />
            </blockquote>
          );
        }
        if (block.kind === "code") {
          return <pre key={key}><code>{block.text}</code></pre>;
        }
        if (block.kind === "rule") return <hr key={key} />;
        return (
          <p key={key}>
            <InlineText text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

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

export function SessionCard({
  session,
  devices,
  timeZone,
  language,
  compact = false,
  showTopic = false,
}: {
  session: SessionCardModel;
  devices: readonly NamedDevice[];
  timeZone: string;
  language: Language;
  compact?: boolean;
  showTopic?: boolean;
}) {
  const { t } = useDaemon();
  const when = formatDateTime(session.updatedAt ?? session.startedAt ?? null, language, timeZone);
  return (
    <article className={compact ? "session compact" : "session"}>
      <div className="session-meta">
        <span className="pill">{sourceLabel(session.source)}</span>
        <span>{deviceLabel(session.device, devices)}</span>
        <time dateTime={session.updatedAt ?? undefined}>{when}</time>
      </div>
      {showTopic && session.topicName ? <p className="session-topic">{session.topicName}</p> : null}
      <h3>{session.title || t("conversation")}</h3>
      <p className="summary-text">{session.summary || t("noSummary")}</p>
      {session.fileId ? (
        <a className="text-link" href={driveFileUrl(session.fileId)} target="_blank" rel="noreferrer">
          {t("openDrive")}
        </a>
      ) : (
        <span className="muted">{t("noDrive")}</span>
      )}
    </article>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function StatusText({ status }: { status: string }) {
  const { t } = useDaemon();
  const key: MessageKey =
    status === "follow_up"
      ? "statusFollowUp"
      : status === "done"
        ? "statusDone"
        : status === "parked"
          ? "statusParked"
          : "statusActive";
  return <span className={`status-pill status-${status}`}>{t(key)}</span>;
}
