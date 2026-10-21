import type { ReactNode } from "react";

import { useDaemon } from "../daemon-context.js";
import { parseInline, parseMarkdown } from "../lib/markdown.js";
import type { MessageKey } from "../i18n/messages.js";

export { Banner } from "./banner.js";

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
  const tone = status === "follow_up" ? "warn" : status === "active" ? "ok" : "muted";
  return (
    <span className="status-inline">
      <i className={`dot dot-${tone}`} />
      {t(key)}
    </span>
  );
}
