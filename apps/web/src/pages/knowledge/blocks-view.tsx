import { createContext, memo, useContext, useState, type ReactNode } from "react";

import type { NotionBlockModel, NotionSegment } from "@you-brain/core/http/types.js";

import type { MessageKey } from "../../i18n/messages.js";
import { Icon } from "../../components/icons.js";
import { highlightCode } from "../../lib/highlight.js";
import { renderMath } from "../../lib/math.js";
import { EditableRow, type BlockEditorCallbacks } from "./block-editor.js";
import {
  BreadcrumbView,
  EmojiPicker,
  EquationView,
  LinkCardView,
  LinkToPageView,
  MediaView,
  ReadOnlyNote,
  TocView,
} from "./block-media.js";
import { InlineDatabase } from "./database-view.js";
import { colorClass } from "./dom-text.js";
import { isEditableBlock, isReadOnlyBlock, segmentsText } from "./logic.js";
import { TableEditor } from "./table-editor.js";

/**
 * Read-only Notion block renderer.
 * Consumes the flattened block model produced by the daemon sync
 * (`packages/core/src/notion/model.ts`), never raw API payloads.
 * 传入 editor 时升级为可编辑(悬停手柄、turn-into、增删移动)。
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
  if (segment.equation !== undefined) {
    return (
      <span
        className={`nb-equation${colorClass ? ` ${colorClass}` : ""}`}
        title={segment.equation}
        dangerouslySetInnerHTML={{ __html: renderMath(segment.equation) }}
      />
    );
  }
  if (segment.mention) {
    const type = typeof segment.mention.type === "string" ? segment.mention.type : "";
    const target = (segment.mention[type] as { id?: unknown } | undefined)?.id;
    const cls = `nb-mention nb-mention-${type}${colorClass ? ` ${colorClass}` : ""}`;
    if ((type === "page" || type === "database") && typeof target === "string") {
      // 点击由知识库页面接管,在应用内打开(不整页跳转)。
      return (
        <a className={cls} href={`/knowledge?id=${encodeURIComponent(target)}`} data-page-link={target}>
          {segment.text}
        </a>
      );
    }
    if (segment.href) {
      return (
        <a className={cls} href={segment.href} target="_blank" rel="noreferrer">
          {segment.text}
        </a>
      );
    }
    return <span className={cls}>{segment.text}</span>;
  }
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

/**
 * 折叠块的展开状态变了就换一个值:行和块视图用它在展开/收起时重渲染。
 * 其余时候行靠 memo 跳过渲染。
 */
export const OpenStateContext = createContext<unknown>(null);

/** Renders sibling lists with correct numbering continuity. */
export function BlockList({
  blocks,
  t,
  assetBase,
  editor,
}: {
  blocks: readonly NotionBlockModel[];
  t: Translate;
  assetBase: (blockId: string) => string;
  editor?: BlockEditorCallbacks | undefined;
}): ReactNode {
  const out: ReactNode[] = [];
  let numberedIndex = 0;
  let prevEditableId: string | null = null;
  for (const block of blocks) {
    if (block.kind === "numbered") {
      numberedIndex += 1;
    } else {
      numberedIndex = 0;
    }
    if (editor) {
      out.push(
        <BlockRow
          key={`row-${block.id}`}
          block={block}
          editor={editor}
          t={t}
          assetBase={assetBase}
          prevEditableId={prevEditableId}
          numberedIndex={block.kind === "numbered" ? numberedIndex : undefined}
        />,
      );
      if (isEditableBlock(block)) prevEditableId = block.id;
      continue;
    }
    out.push(
      block.kind === "numbered" ? (
        <BlockView key={block.id} block={block} t={t} assetBase={assetBase} numberedIndex={numberedIndex} />
      ) : (
        <BlockView key={block.id} block={block} t={t} assetBase={assetBase} />
      ),
    );
  }
  return <>{out}</>;
}

/** 编辑模式下的一行:props 没变就不重渲染(装饰和子块都在行内部生成)。 */
const BlockRow = memo(function BlockRow({
  block,
  editor,
  t,
  assetBase,
  prevEditableId,
  numberedIndex,
}: {
  block: NotionBlockModel;
  editor: BlockEditorCallbacks;
  t: Translate;
  assetBase: (blockId: string) => string;
  prevEditableId: string | null;
  numberedIndex: number | undefined;
}): ReactNode {
  useContext(OpenStateContext);
  if (isEditableBlock(block)) {
    const foldable = isFoldable(block);
    const open = !foldable || editor.isOpen(block.id);
    const nested =
      foldable && open && block.children.length === 0 ? (
        <button type="button" className="nb-toggle-empty" onClick={() => editor.addChild(block.id)}>
          {t("knowledgeToggleEmpty")}
        </button>
      ) : open && block.children.length > 0 ? (
        <BlockList blocks={block.children} t={t} assetBase={assetBase} editor={editor} />
      ) : null;
    return (
      <EditableRow
        block={block}
        editor={editor}
        t={t}
        prevEditableId={prevEditableId}
        numberedIndex={numberedIndex}
        chrome={chromeFor(block, numberedIndex ?? 0, editor, t)}
      >
        {nested}
      </EditableRow>
    );
  }
  return (
    <EditableRow block={block} editor={editor} t={t} prevEditableId={prevEditableId}>
      <BlockView block={block} t={t} assetBase={assetBase} editor={editor} numberedIndex={numberedIndex} />
    </EditableRow>
  );
});

/** 折叠块与可折叠标题:箭头展开/收起子块。 */
export function isFoldable(block: NotionBlockModel): boolean {
  return block.kind === "toggle" || (block.kind === "heading" && block.toggleable === true);
}

function ToggleArrow({ block, editor, t }: { block: NotionBlockModel; editor: BlockEditorCallbacks; t: Translate }): ReactNode {
  const open = editor.isOpen(block.id);
  return (
    <button
      type="button"
      className={"nb-toggle-arrow" + (open ? " is-open" : "")}
      aria-label={open ? t("knowledgeToggleCollapse") : t("knowledgeToggleExpand")}
      aria-expanded={open}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => editor.toggleOpen(block.id)}
    >
      <Icon name="chevron-right" size={14} />
    </button>
  );
}

function CalloutIcon({ block, editor, t }: { block: Extract<NotionBlockModel, { kind: "callout" }>; editor: BlockEditorCallbacks; t: Translate }): ReactNode {
  const [picking, setPicking] = useState(false);
  return (
    <span className="nb-callout-icon-wrap">
      <button type="button" className="nb-callout-icon" onMouseDown={(event) => event.preventDefault()} onClick={() => setPicking(true)}>
        {block.emoji ?? "💡"}
      </button>
      {picking ? (
        <EmojiPicker
          t={t}
          onPick={(emoji) => {
            setPicking(false);
            editor.patchBlock(block, { ...block, emoji });
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </span>
  );
}

function chromeFor(
  block: NotionBlockModel,
  numberedIndex: number,
  editor: BlockEditorCallbacks,
  t: Translate,
): ReactNode {
  if (block.kind === "heading" && block.toggleable) return <ToggleArrow block={block} editor={editor} t={t} />;
  switch (block.kind) {
    case "bulleted":
      return <span className="nb-bullet">•</span>;
    case "numbered":
      return <span className="nb-number">{numberedIndex}.</span>;
    case "todo":
      return (
        <input
          type="checkbox"
          className="nb-checkbox"
          checked={block.checked}
          onChange={() => void editor.toggleTodo(block)}
        />
      );
    case "callout":
      return <CalloutIcon block={block} editor={editor} t={t} />;
    case "toggle":
      return <ToggleArrow block={block} editor={editor} t={t} />;
    default:
      return null;
  }
}

/** 标签页:标签是子段落,选中的标签显示它的子块(可编辑)。 */
function TabsView({
  block,
  t,
  assetBase,
  editor,
}: {
  block: NotionBlockModel;
  t: Translate;
  assetBase: (blockId: string) => string;
  editor?: BlockEditorCallbacks | undefined;
}): ReactNode {
  const [active, setActive] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const tabs = block.children;
  const current = tabs[Math.min(active, Math.max(0, tabs.length - 1))];
  return (
    <div className="nb-tabs">
      <div className="nb-tabs-bar" role="tablist">
        {tabs.map((tab, index) =>
          renaming === tab.id && editor && tab.kind === "paragraph" ? (
            <input
              key={tab.id}
              className="nb-tab-rename"
              autoFocus
              defaultValue={segmentsText(tab.segments)}
              aria-label={t("knowledgeTabRename")}
              onBlur={(event) => {
                setRenaming(null);
                const next = event.target.value.trim();
                if (next !== "" && next !== segmentsText(tab.segments)) {
                  editor.patchBlock(tab, { ...tab, segments: [{ text: next, href: null, bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }] });
                }
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab === current}
              className={tab === current ? "is-on" : ""}
              title={editor ? t("knowledgeTabRename") : undefined}
              onClick={() => setActive(index)}
              // 双击标签改名(WKWebView 不支持 window.prompt,用行内输入框)。
              onDoubleClick={() => editor && tab.kind === "paragraph" && setRenaming(tab.id)}
            >
              {tab.kind === "paragraph" && tab.icon ? `${tab.icon} ` : ""}
              {tab.kind === "paragraph" ? segmentsText(tab.segments) || t("knowledgeUntitled") : t("knowledgeUntitled")}
            </button>
          ),
        )}
      </div>
      {current ? (
        current.children.length > 0 ? (
          <BlockList blocks={current.children} t={t} assetBase={assetBase} editor={editor} />
        ) : editor ? (
          <button type="button" className="nb-toggle-empty" onClick={() => editor.addChild(current.id)}>
            {t("knowledgeTabEmpty")}
          </button>
        ) : null
      ) : null}
    </div>
  );
}

export const BlockView = memo(function BlockView({
  block,
  t,
  assetBase,
  editor,
  numberedIndex,
}: {
  block: NotionBlockModel;
  t: Translate;
  assetBase: (blockId: string) => string;
  editor?: BlockEditorCallbacks | undefined;
  numberedIndex?: number | undefined;
}): ReactNode {
  useContext(OpenStateContext);
  if (editor) {
    switch (block.kind) {
      case "image":
      case "video":
      case "audio":
      case "file":
      case "pdf":
        return <MediaView block={block} t={t} editor={editor} src={block.kind === "image" && block.source !== "external" && block.url !== "" ? assetBase(block.id) : ""} />;
      case "bookmark":
      case "embed":
        return <LinkCardView block={block} t={t} editor={editor} />;
      case "equation":
        return <EquationView block={block} t={t} editor={editor} />;
      case "table_of_contents":
        return <TocView t={t} editor={editor} />;
      case "breadcrumb":
        return <BreadcrumbView t={t} editor={editor} />;
      case "link_to_page":
        return <LinkToPageView block={block} t={t} editor={editor} />;
      default:
        break;
    }
  }
  const readOnly = editor && isReadOnlyBlock(block) && block.kind !== "child_page" && block.kind !== "child_database" ? <ReadOnlyNote t={t} /> : null;
  const tone = block.color ? colorClass(block.color) : "";
  switch (block.kind) {
    case "tab":
      return <TabsView block={block} t={t} assetBase={assetBase} editor={editor} />;
    case "video":
    case "audio":
      return (
        <figure className="nb-media">
          {block.kind === "video" ? <video className="nb-video" src={block.url} controls preload="metadata" /> : <audio className="nb-audio" src={block.url} controls preload="metadata" />}
        </figure>
      );
    case "paragraph":
      return (
        <p className={`nb-p ${tone}`}>
          <RichText segments={block.segments} />
          {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} editor={editor} />}
        </p>
      );
    case "heading": {
      if (block.level === 1) return <h1 className={`nb-h1 ${tone}`}><RichText segments={block.segments} /></h1>;
      if (block.level === 2) return <h2 className={`nb-h2 ${tone}`}><RichText segments={block.segments} /></h2>;
      if (block.level === 3) return <h3 className={`nb-h3 ${tone}`}><RichText segments={block.segments} /></h3>;
      return <h4 className={`nb-h4 ${tone}`}><RichText segments={block.segments} /></h4>;
    }
    case "bulleted":
      return (
        <div className="nb-li nb-li-bullet">
          <span className="nb-bullet">•</span>
          <div className="nb-li-body">
            <RichText segments={block.segments} />
            {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} editor={editor} />}
          </div>
        </div>
      );
    case "numbered":
      return (
        <div className="nb-li nb-li-numbered">
          <span className="nb-number">{numberedIndex ?? 1}.</span>
          <div className="nb-li-body">
            <RichText segments={block.segments} />
            {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} editor={editor} />}
          </div>
        </div>
      );
    case "todo":
      return (
        <div className="nb-li nb-todo">
          <input
            type="checkbox"
            className="nb-checkbox"
            checked={block.checked}
            readOnly={!editor}
            disabled={!editor}
            onChange={() => editor?.toggleTodo(block)}
          />
          <div className={block.checked ? "nb-li-body is-checked" : "nb-li-body"}>
            <RichText segments={block.segments} />
            {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} editor={editor} />}
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
            <BlockList blocks={block.children} t={t} assetBase={assetBase} editor={editor} />
          </div>
        </details>
      );
    case "callout":
      return (
        <div className={`nb-callout ${block.color !== "default" ? `nb-bg-${bgName(block.color)}` : ""}`}>
          <span className="nb-callout-icon">{block.emoji ?? "💡"}</span>
          <div>
            <RichText segments={block.segments} />
            {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} editor={editor} />}
          </div>
        </div>
      );
    case "quote":
      return (
        <blockquote className="nb-quote">
          <RichText segments={block.segments} />
          {block.children.length > 0 && <BlockList blocks={block.children} t={t} assetBase={assetBase} editor={editor} />}
        </blockquote>
      );
    case "code":
      return (
        <figure className="nb-code">
          <figcaption>{block.language}</figcaption>
          <pre>
            <code dangerouslySetInnerHTML={{ __html: highlightCode(block.text, block.language) }} />
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
          {readOnly}
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
        <a className="nb-page-link" href={`/knowledge?id=${encodeURIComponent(targetId)}`} data-page-link={targetId}>
          {icon} {title || t("knowledgeUntitled")}
        </a>
      );
    }
    case "child_database":
      if (editor) return <InlineDatabase databaseId={block.databaseId} title={block.title} ops={editor.databaseOps} t={t} untitled={t("knowledgeUntitled")} />;
      return (
        <a className="nb-page-link" href={`/knowledge?id=${encodeURIComponent(block.databaseId)}`} data-page-link={block.databaseId}>
          🗂 {block.title || t("knowledgeUntitled")}
        </a>
      );
    case "table_of_contents":
      return <div className="nb-toc">≡ {t("knowledgeTypeToc")}</div>;
    case "breadcrumb":
      return null;
    case "equation":
      return <div className="nb-equation nb-equation-block" dangerouslySetInnerHTML={{ __html: renderMath(block.expression, true) }} />;
    case "column_list":
      return (
        <div className="nb-columns">
          <BlockList blocks={block.children} t={t} assetBase={assetBase} editor={editor} />
        </div>
      );
    case "column":
      return (
        <div className="nb-column" {...(block.widthRatio ? { style: { flexBasis: `${Math.round(block.widthRatio * 100)}%` } } : {})}>
          <BlockList blocks={block.children} t={t} assetBase={assetBase} editor={editor} />
        </div>
      );
    case "table":
      if (editor) return <TableEditor block={block} editor={editor} t={t} />;
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
          {readOnly}
          {/* 同步块的内容 Notion 接口改不了:只读展示。 */}
          <BlockList blocks={block.children} t={t} assetBase={assetBase} />
        </div>
      );
    case "unknown":
      return (
        <div className="nb-unknown">
          {t("knowledgeUnknownBlock", { type: block.type })}
          {readOnly}
        </div>
      );
    default:
      return null;
  }
});

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
