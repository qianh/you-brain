import { useState, type ReactNode } from "react";

import type { NotionBlockModel, NotionSegment } from "@you-brain/core/http/types.js";

import type { MessageKey } from "../../i18n/messages.js";

/**
 * Read-only Notion block renderer.
 * Consumes the flattened block model produced by the daemon sync
 * (`packages/core/src/notion/model.ts`), never raw API payloads.
 */

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function RichText({ segments }: { segments: readonly NotionSegment[] }): ReactNode {
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((segment, index) => (
        <RichSegment key={index} segment={segment} />
      ))}
    </>
  );
}

function RichSegment({ segment }: { segment: NotionSegment }): ReactNode {
  const colorClass = segmentColorClass(segment.color);
  let node: ReactNode = segment.text;
  if (segment.code) node = <code className="nb-inline-code">{node}</code>;
  if (segment.bold) node = <strong>{node}</strong>;
  if (segment.italic) node = <em>{node}</em>;
  if (segment.underline) node = <u>{node}</u>;
  if (segment.strikethrough) node = <s>{node}</s>;
  if (segment.href) {
    const external = /^https?:/iu.test(segment.href);
    node = (
      <a
        className="nb-link"
        href={segment.href}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {node}
      </a>
    );
  }
  if (colorClass) return <span className={colorClass}>{node}</span>;
  return node;
}

function segmentColorClass(color: string): string | null {
  if (color === "default") return null;
  if (color.endsWith("_background")) {
    const name = color.slice(0, -"_background".length);
    return `nb-bg nb-bg-${name}`;
  }
  return `nb-color-${color}`;
}

/** Renders sibling lists with correct numbering continuity. */
export function BlockList({
  blocks,
  t,
  assetBase,
}: {
  blocks: readonly NotionBlockModel[];
  t: Translate;
  assetBase: (blockId: string) => string;
}): ReactNode {
  const out: ReactNode[] = [];
  let numberedIndex = 0;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block) continue;
    if (block.kind === "numbered") {
      numberedIndex += 1;
    } else {
      numberedIndex = 0;
    }
    out.push(
      block.kind === "numbered" ? (
        <BlockView
          key={block.id}
          block={block}
          t={t}
          assetBase={assetBase}
          numberedIndex={numberedIndex}
        />
      ) : (
        <BlockView key={block.id} block={block} t={t} assetBase={assetBase} />
      ),
    );
  }
  return <>{out}</>;
}

export function BlockView({
  block,
  t,
  assetBase,
  numberedIndex,
}: {
  block: NotionBlockModel;
  t: Translate;
  assetBase: (blockId: string) => string;
  numberedIndex?: number;
}): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="nb-p">
          <RichText segments={block.segments} />
          {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} />}
        </p>
      );
    case "heading": {
      if (block.level === 1) return <h1 className="nb-h1"><RichText segments={block.segments} /></h1>;
      if (block.level === 2) return <h2 className="nb-h2"><RichText segments={block.segments} /></h2>;
      return <h3 className="nb-h3"><RichText segments={block.segments} /></h3>;
    }
    case "bulleted":
      return (
        <div className="nb-li nb-li-bullet">
          <span className="nb-bullet">•</span>
          <div className="nb-li-body">
            <RichText segments={block.segments} />
            {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} />}
          </div>
        </div>
      );
    case "numbered":
      return (
        <div className="nb-li nb-li-numbered">
          <span className="nb-number">{numberedIndex ?? 1}.</span>
          <div className="nb-li-body">
            <RichText segments={block.segments} />
            {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} />}
          </div>
        </div>
      );
    case "todo":
      return (
        <div className="nb-li nb-todo">
          <input type="checkbox" className="nb-checkbox" checked={block.checked} readOnly disabled />
          <div className={block.checked ? "nb-li-body is-checked" : "nb-li-body"}>
            <RichText segments={block.segments} />
            {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} />}
          </div>
        </div>
      );
    case "toggle":
      return (
        <details className="nb-toggle">
          <summary>
            <RichText segments={block.segments} />
          </summary>
          <div className="nb-toggle-body">
            <BlockList blocks={block.children} t={t} assetBase={assetBase} />
          </div>
        </details>
      );
    case "callout":
      return (
        <div className={`nb-callout ${block.color !== "default" ? `nb-bg-${bgName(block.color)}` : ""}`}>
          <span className="nb-callout-icon">{block.emoji ?? "💡"}</span>
          <div>
            <RichText segments={block.segments} />
            {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} />}
          </div>
        </div>
      );
    case "quote":
      return (
        <blockquote className="nb-quote">
          <RichText segments={block.segments} />
          {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} />}
        </blockquote>
      );
    case "code":
      return (
        <figure className="nb-code">
          <figcaption>{block.language}</figcaption>
          <pre>
            <code>{block.text}</code>
          </pre>
        </figure>
      );
    case "divider":
      return <hr className="nb-divider" />;
    case "image":
      return (
        <figure className="nb-media">
          <ProxiedImage blockId={block.id} url={block.url} assetBase={assetBase} alt="" />
          {block.caption.length > 0 && (
            <figcaption>
              <RichText segments={block.caption} />
            </figcaption>
          )}
        </figure>
      );
    case "file":
      return (
        <a className="nb-file" href={block.url} target="_blank" rel="noreferrer">
          📎 {block.name}
        </a>
      );
    case "pdf":
      return (
        <a className="nb-file" href={block.url} target="_blank" rel="noreferrer">
          📄 {block.name}
        </a>
      );
    case "bookmark":
      return (
        <a className="nb-bookmark" href={block.url} target="_blank" rel="noreferrer">
          <span className="nb-bookmark-url">{hostOf(block.url)}</span>
          <span className="nb-bookmark-title">
            <RichText segments={block.caption.length > 0 ? block.caption : [{ text: block.url, href: null, bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }]} />
          </span>
        </a>
      );
    case "embed":
    case "link_preview":
      return (
        <a className="nb-bookmark" href={block.url} target="_blank" rel="noreferrer">
          <span className="nb-bookmark-url">{hostOf(block.url)}</span>
          <span className="nb-bookmark-title">{block.url}</span>
        </a>
      );
    case "link_to_page":
    case "child_page": {
      const targetId = block.kind === "child_page" ? block.pageId : block.targetId;
      const title = block.kind === "child_page" ? block.title : "";
      const icon =
        block.kind === "link_to_page" && block.targetKind === "database" ? "🗂" : "📄";
      if (!targetId) {
        return (
          <div className="nb-page-link is-external">
            🔗 {title || t("knowledgeUntitled")}
          </div>
        );
      }
      return (
        <a className="nb-page-link" href={`/knowledge?id=${encodeURIComponent(targetId)}`}>
          {icon} {title || t("knowledgeUntitled")}
        </a>
      );
    }
    case "child_database":
      return (
        <a className="nb-page-link" href={`/knowledge?id=${encodeURIComponent(block.databaseId)}`}>
          🗂 {block.title || t("knowledgeUntitled")}
        </a>
      );
    case "table_of_contents":
      return <div className="nb-toc">≡ {t("knowledgeProperties")}</div>;
    case "breadcrumb":
      return null;
    case "equation":
      return <pre className="nb-equation"><code>{block.expression}</code></pre>;
    case "column_list":
      return (
        <div className="nb-columns">
          <BlockList blocks={block.children} t={t} assetBase={assetBase} />
        </div>
      );
    case "column":
      return (
        <div className="nb-column" {...(block.widthRatio ? { style: { flexBasis: `${Math.round(block.widthRatio * 100)}%` } } : {})}>
          <BlockList blocks={block.children} t={t} assetBase={assetBase} />
        </div>
      );
    case "table":
      return (
        <table className="nb-table">
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => {
                  const CellTag = rowIndex === 0 && block.hasHeader ? "th" : "td";
                  return (
                    <CellTag key={cellIndex}>
                      <RichText segments={cell} />
                    </CellTag>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "synced":
      return (
        <div className="nb-synced">
          <BlockList blocks={block.children} t={t} assetBase={assetBase} />
        </div>
      );
    case "unknown":
      return <div className="nb-unknown">{t("knowledgeUnknownBlock", { type: block.type })}</div>;
    default:
      return null;
  }
}

function ProxiedImage({
  blockId,
  url,
  assetBase,
  alt,
}: {
  blockId: string;
  url: string;
  assetBase: (blockId: string) => string;
  alt: string;
}): ReactNode {
  const [source, setSource] = useState(assetBase(blockId));
  if (source === "") return null;
  return (
    <img
      className="nb-image"
      src={source}
      alt={alt}
      loading="lazy"
      onError={() => {
        // Notion-hosted files can 404 through the proxy when the signed URL
        // expired; external images are allowed to load directly.
        if (url.startsWith("http") && source !== url) setSource(url);
        else setSource("");
      }}
    />
  );
}

function bgName(color: string): string {
  return color.endsWith("_background") ? color.slice(0, -"_background".length) : color;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
