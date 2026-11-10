import { useEffect, useRef, useState, type ReactNode } from "react";

import type { NotionBlockModel, NotionSegment } from "@you-brain/core/http/types.js";

import type { MessageKey } from "../../i18n/messages.js";
import { renderMath } from "../../lib/math.js";
import { isLocalPending, segmentsOf, segmentsText, plainSegments } from "./logic.js";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** 媒体/嵌入类块编辑需要的回调(BlockEditorCallbacks 的子集)。 */
export interface MediaEditor {
  /** 改块属性(链接、说明、公式……);占位块第一次确定内容时写进 Notion。 */
  patchBlock(block: NotionBlockModel, next: NotionBlockModel): void;
  /** 放弃还没写进 Notion 的占位块。 */
  discardPending(blockId: string): void;
  uploadFile(file: File): Promise<string>;
  mentionPages(query: string): Array<{ id: string; title: string; object: "page" | "database" }>;
  pageBlocks(): readonly NotionBlockModel[];
  pagePath(): Array<{ id: string; title: string; icon: string | null }>;
  pageTitle(id: string): { title: string; icon: string | null } | null;
  openPage(id: string): void;
}

type MediaKind = "image" | "video" | "audio" | "file" | "pdf";
type MediaBlock = Extract<NotionBlockModel, { kind: MediaKind }>;

const ACCEPT: Record<MediaKind, string> = {
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
  file: "*/*",
  pdf: "application/pdf",
};

/** 外链视频:YouTube/Bilibili 转成可嵌入的播放器地址,其余按直链播放。 */
export function videoEmbedUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./u, "");
    if (host === "youtu.be") return `https://www.youtube.com/embed/${parsed.pathname.slice(1)}`;
    if (host.endsWith("youtube.com")) {
      const id = parsed.searchParams.get("v") ?? (parsed.pathname.startsWith("/embed/") ? parsed.pathname.slice(7) : null);
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host.endsWith("bilibili.com")) {
      const match = /\/video\/(BV\w+)/u.exec(parsed.pathname);
      return match ? `https://player.bilibili.com/player.html?bvid=${match[1]}&autoplay=0` : null;
    }
    if (host === "vimeo.com") return `https://player.vimeo.com/video/${parsed.pathname.slice(1)}`;
  } catch {
    return null;
  }
  return null;
}

/** 补协议;明显不是链接的返回 null。 */
export function normalizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+/u.test(value)) return `https://${value}`;
  return null;
}

/** 选择来源的面板:上传文件 / 嵌入链接(Notion 同款两个标签页)。 */
function SourcePanel({
  kind,
  t,
  allowUpload,
  initialUrl,
  onUrl,
  onFile,
  onCancel,
}: {
  kind: string;
  t: Translate;
  allowUpload: boolean;
  initialUrl: string;
  onUrl: (url: string) => void;
  onFile?: ((file: File) => void) | undefined;
  onCancel: () => void;
}): ReactNode {
  const [tab, setTab] = useState<"upload" | "link">(allowUpload ? "upload" : "link");
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (tab === "link") input.current?.focus();
  }, [tab]);
  const submit = (): void => {
    const value = normalizeUrl(url);
    if (!value) {
      setError(t("knowledgeMediaBadLink"));
      return;
    }
    onUrl(value);
  };
  return (
    <div className="nb-source" onMouseDown={(event) => event.stopPropagation()}>
      <div className="nb-source-tabs">
        {allowUpload ? (
          <button type="button" className={tab === "upload" ? "is-on" : ""} onClick={() => setTab("upload")}>
            {t("knowledgeMediaUpload")}
          </button>
        ) : null}
        <button type="button" className={tab === "link" ? "is-on" : ""} onClick={() => setTab("link")}>
          {t("knowledgeMediaEmbedLink")}
        </button>
        <span className="nb-source-kind">{kind}</span>
        <button type="button" className="nb-source-close" aria-label={t("knowledgeCancel")} onClick={onCancel}>
          ✕
        </button>
      </div>
      {tab === "upload" && onFile ? (
        <label className="nb-source-upload">
          <input
            type="file"
            accept={ACCEPT[kind as MediaKind] ?? "*/*"}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onFile(file);
            }}
          />
          <span>{t("knowledgeMediaChooseFile")}</span>
          <small>{t("knowledgeMediaUploadLimit")}</small>
        </label>
      ) : (
        <form
          className="nb-source-link"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            ref={input}
            value={url}
            placeholder={t("knowledgeLinkPlaceholder")}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onCancel();
              // 回车自己处理:WebView 里表单的隐式提交不可靠;输入法选词的回车不算。
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button type="submit" className="nb-btn primary">
            {t("knowledgeMediaEmbed")}
          </button>
          {error ? <div className="nb-source-error">{error}</div> : null}
        </form>
      )}
    </div>
  );
}

/** 图片、视频、音频、文件、PDF:展示 + 替换 + 改说明;占位块先选来源。 */
export function MediaView({
  block,
  t,
  editor,
  src,
}: {
  block: MediaBlock;
  t: Translate;
  editor: MediaEditor;
  /** 托管文件经代理的地址(过期链接回退外链)。 */
  src: string;
}): ReactNode {
  const pending = isLocalPending(block);
  const [replacing, setReplacing] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const caption = block.caption ?? [];
  const [captionDraft, setCaptionDraft] = useState(segmentsText(caption));
  useEffect(() => setCaptionDraft(segmentsText(block.caption ?? [])), [block.caption]);
  const label = t(`knowledgeType${block.kind[0]!.toUpperCase()}${block.kind.slice(1)}` as MessageKey);

  const setSource = (next: { url: string } | { uploadId: string; name: string }): void => {
    setReplacing(false);
    const base = { ...block, url: "url" in next ? next.url : "", uploadId: "uploadId" in next ? next.uploadId : undefined } as MediaBlock;
    const named = (base.kind === "file" || base.kind === "pdf") && "name" in next ? { ...base, name: next.name } : base;
    editor.patchBlock(block, { ...named, source: "uploadId" in next ? "file" : "external" } as NotionBlockModel);
  };
  const upload = (file: File): void => {
    setUploading(file.name);
    setError(null);
    editor
      .uploadFile(file)
      .then((uploadId) => {
        setUploading(null);
        setSource({ uploadId, name: file.name });
      })
      .catch((cause: unknown) => {
        setUploading(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  if (pending || replacing) {
    return (
      <div className="nb-media-pending">
        {uploading ? (
          <div className="nb-source-status">{t("knowledgeMediaUploading", { name: uploading })}</div>
        ) : (
          <SourcePanel
            kind={label}
            t={t}
            allowUpload
            initialUrl={pending ? "" : block.source === "external" ? block.url : ""}
            onUrl={(url) => setSource({ url })}
            onFile={upload}
            onCancel={() => (pending ? editor.discardPending(block.id) : setReplacing(false))}
          />
        )}
        {error ? <div className="nb-source-error">{error}</div> : null}
      </div>
    );
  }

  const url = block.url;
  let body: ReactNode;
  if (block.kind === "image") {
    body = <img className="nb-image" src={src || url} alt={segmentsText(caption)} loading="lazy" />;
  } else if (block.kind === "video") {
    const embed = videoEmbedUrl(url);
    body = embed ? (
      <iframe className="nb-video-embed" src={embed} title={label} allow="fullscreen; picture-in-picture" />
    ) : (
      <video className="nb-video" src={url} controls preload="metadata" />
    );
  } else if (block.kind === "audio") {
    body = <audio className="nb-audio" src={url} controls preload="metadata" />;
  } else if (block.kind === "pdf") {
    body = (
      <div className="nb-pdf">
        <iframe src={url} title={block.name} />
        <a href={url} target="_blank" rel="noreferrer">
          📄 {block.name}
        </a>
      </div>
    );
  } else {
    body = (
      <a className="nb-file" href={url} target="_blank" rel="noreferrer">
        📎 {block.name}
      </a>
    );
  }
  const saveCaption = (): void => {
    if (captionDraft === segmentsText(caption)) return;
    editor.patchBlock(block, { ...block, caption: captionDraft === "" ? [] : plainSegments(captionDraft) } as NotionBlockModel);
  };
  return (
    <figure className="nb-media nb-media-editable">
      {body}
      <div className="nb-media-tools">
        <button type="button" onClick={() => setReplacing(true)}>
          {t("knowledgeMediaReplace")}
        </button>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            {t("knowledgeMediaOpen")}
          </a>
        ) : null}
      </div>
      {block.kind !== "file" ? (
        <input
          className="nb-media-caption"
          value={captionDraft}
          placeholder={t("knowledgeMediaCaption")}
          onChange={(event) => setCaptionDraft(event.target.value)}
          onBlur={saveCaption}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
          }}
        />
      ) : null}
    </figure>
  );
}

/** 书签与嵌入:展示 + 改链接;占位块先填链接。 */
export function LinkCardView({
  block,
  t,
  editor,
}: {
  block: Extract<NotionBlockModel, { kind: "bookmark" | "embed" }>;
  t: Translate;
  editor: MediaEditor;
}): ReactNode {
  const pending = isLocalPending(block);
  const [editing, setEditing] = useState(false);
  const label = t(block.kind === "bookmark" ? "knowledgeTypeBookmark" : "knowledgeTypeEmbed");
  if (pending || editing) {
    return (
      <SourcePanel
        kind={label}
        t={t}
        allowUpload={false}
        initialUrl={block.url}
        onUrl={(url) => {
          setEditing(false);
          editor.patchBlock(block, { ...block, url });
        }}
        onCancel={() => (pending ? editor.discardPending(block.id) : setEditing(false))}
      />
    );
  }
  const host = hostOf(block.url);
  const video = block.kind === "embed" ? videoEmbedUrl(block.url) : null;
  return (
    <div className="nb-linkcard">
      {block.kind === "embed" ? (
        <iframe className="nb-embed-frame" src={video ?? block.url} title={host} sandbox="allow-scripts allow-same-origin allow-popups allow-forms" />
      ) : null}
      <a className="nb-bookmark" href={block.url} target="_blank" rel="noreferrer">
        <span className="nb-bookmark-url">{host}</span>
        <span className="nb-bookmark-title">{segmentsText(block.kind === "bookmark" ? block.caption : (block.caption ?? [])) || block.url}</span>
      </a>
      <div className="nb-media-tools">
        <button type="button" onClick={() => setEditing(true)}>
          {t("knowledgeMediaEditLink")}
        </button>
      </div>
    </div>
  );
}

/** 公式块:展示 LaTeX,点一下编辑(⌘Enter 保存,Esc 取消)。 */
export function EquationView({
  block,
  t,
  editor,
}: {
  block: Extract<NotionBlockModel, { kind: "equation" }>;
  t: Translate;
  editor: MediaEditor;
}): ReactNode {
  const pending = isLocalPending(block);
  const [editing, setEditing] = useState(pending);
  const [value, setValue] = useState(block.expression);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  const done = (): void => {
    const next = value.trim();
    setEditing(false);
    if (next === "") {
      if (pending) editor.discardPending(block.id);
      else setValue(block.expression);
      return;
    }
    if (next !== block.expression) editor.patchBlock(block, { ...block, expression: next });
  };
  if (editing) {
    return (
      <div className="nb-equation-block-edit" onMouseDown={(event) => event.stopPropagation()}>
        <textarea
          ref={area}
          value={value}
          placeholder={t("knowledgeEquationPlaceholder")}
          rows={Math.max(2, value.split("\n").length)}
          onChange={(event) => setValue(event.target.value)}
          onBlur={done}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              done();
            } else if (event.key === "Escape") {
              event.preventDefault();
              if (pending) editor.discardPending(block.id);
              setValue(block.expression);
              setEditing(false);
            }
          }}
        />
        {value.trim() !== "" ? (
          <div className="nb-equation-preview" dangerouslySetInnerHTML={{ __html: renderMath(value, true) }} />
        ) : null}
        <span className="nb-edit-hint">{t("knowledgeEquationHint")}</span>
      </div>
    );
  }
  return (
    <div
      className="nb-equation nb-equation-block"
      role="button"
      tabIndex={0}
      title={block.expression}
      onClick={() => setEditing(true)}
      dangerouslySetInnerHTML={{ __html: renderMath(block.expression, true) }}
    />
  );
}

/** 目录:当前页面的标题列表,点击滚到对应标题。 */
export function TocView({ t, editor }: { t: Translate; editor: MediaEditor }): ReactNode {
  const headings: Array<{ id: string; level: number; text: string }> = [];
  const walk = (list: readonly NotionBlockModel[]): void => {
    for (const block of list) {
      if (block.kind === "heading") headings.push({ id: block.id, level: block.level, text: segmentsText(block.segments) });
      if (block.kind !== "toggle") walk(block.children);
    }
  };
  walk(editor.pageBlocks());
  if (headings.length === 0) return <div className="nb-toc is-empty">{t("knowledgeTocEmpty")}</div>;
  return (
    <nav className="nb-toc">
      {headings.map((heading) => (
        <button
          key={heading.id}
          type="button"
          style={{ paddingLeft: `${(heading.level - 1) * 18}px` }}
          onClick={() =>
            document
              .querySelector(`[data-block-id="${CSS.escape(heading.id)}"]`)
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        >
          {heading.text || t("knowledgeUntitled")}
        </button>
      ))}
    </nav>
  );
}

/** 面包屑:从根页面到当前页面的路径。 */
export function BreadcrumbView({ t, editor }: { t: Translate; editor: MediaEditor }): ReactNode {
  const path = editor.pagePath();
  return (
    <nav className="nb-breadcrumb">
      {path.map((node, index) => (
        <span key={node.id}>
          {index > 0 ? <span className="nb-breadcrumb-sep">/</span> : null}
          <button type="button" onClick={() => editor.openPage(node.id)}>
            {node.icon ?? "📄"} {node.title || t("knowledgeUntitled")}
          </button>
        </span>
      ))}
    </nav>
  );
}

/** 页面链接:占位块先选页面;已有的点击在应用内打开。 */
export function LinkToPageView({
  block,
  t,
  editor,
}: {
  block: Extract<NotionBlockModel, { kind: "link_to_page" }>;
  t: Translate;
  editor: MediaEditor;
}): ReactNode {
  if (isLocalPending(block)) {
    return (
      <PagePicker
        t={t}
        editor={editor}
        onPick={(page) => editor.patchBlock(block, { ...block, targetId: page.id, targetKind: page.object })}
        onCancel={() => editor.discardPending(block.id)}
      />
    );
  }
  const target = block.targetId ? editor.pageTitle(block.targetId) : null;
  return (
    <button type="button" className="nb-page-link" onClick={() => block.targetId && editor.openPage(block.targetId)}>
      ↗ {target?.icon ?? (block.targetKind === "database" ? "🗂" : "📄")} {target?.title || t("knowledgeUntitled")}
    </button>
  );
}

export function PagePicker({
  t,
  editor,
  onPick,
  onCancel,
}: {
  t: Translate;
  editor: MediaEditor;
  onPick: (page: { id: string; object: "page" | "database" }) => void;
  onCancel: () => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const options = editor.mentionPages(query);
  return (
    <div className="nb-source nb-page-picker" onMouseDown={(event) => event.stopPropagation()}>
      <input
        autoFocus
        value={query}
        placeholder={t("knowledgeLinkToPageSearch")}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") onCancel();
          else if (event.key === "ArrowDown") setActive((value) => Math.min(value + 1, options.length - 1));
          else if (event.key === "ArrowUp") setActive((value) => Math.max(value - 1, 0));
          else if (event.key === "Enter") {
            event.preventDefault();
            const option = options[active];
            if (option) onPick(option);
          }
        }}
      />
      {options.length === 0 ? <div className="nb-slash-empty">{t("knowledgeMentionEmpty")}</div> : null}
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          className={"nb-slash-item" + (index === active ? " is-active" : "")}
          onMouseEnter={() => setActive(index)}
          onClick={() => onPick(option)}
        >
          <span className="nb-slash-glyph">{option.object === "database" ? "🗂" : "📄"}</span>
          <span className="nb-slash-label">{option.title}</span>
        </button>
      ))}
    </div>
  );
}

const EMOJI = [
  "💡", "📌", "⚠️", "❗", "❓", "✅", "❌", "🔥", "⭐", "📝", "📎", "📄", "📁", "📊", "📈", "🗂",
  "🧠", "🎯", "🚀", "🛠", "⚙️", "🔒", "🔑", "💬", "📣", "📅", "⏰", "🧪", "🐛", "💰", "🏠", "🌱",
  "😀", "😎", "🤔", "👍", "👀", "🙏", "❤️", "🎉", "📚", "✏️", "🔗", "🧩", "🗒", "🌐", "☕", "🍀",
];

/** emoji 选择器:常用 emoji + 自己输入任意一个;可移除。 */
export function EmojiPicker({
  t,
  onPick,
  onRemove,
  onClose,
}: {
  t: Translate;
  onPick: (emoji: string) => void;
  onRemove?: (() => void) | undefined;
  onClose: () => void;
}): ReactNode {
  const [custom, setCustom] = useState("");
  return (
    <>
      <div className="nb-scrim" onClick={onClose} role="presentation" />
      <div className="nb-emoji-picker" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="nb-emoji-head">
          <input
            autoFocus
            value={custom}
            placeholder={t("knowledgeEmojiCustom")}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "Enter" && !event.nativeEvent.isComposing && custom.trim() !== "") {
                event.preventDefault();
                onPick([...custom.trim()][0] ?? custom.trim());
              }
            }}
          />
          {onRemove ? (
            <button type="button" onClick={onRemove}>
              {t("knowledgeEmojiRemove")}
            </button>
          ) : null}
        </div>
        <div className="nb-emoji-grid">
          {EMOJI.map((emoji) => (
            <button key={emoji} type="button" onClick={() => onPick(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** 接口不支持编辑的块:看得到内容,悬停说明只读原因。 */
export function ReadOnlyNote({ t }: { t: Translate }): ReactNode {
  return <span className="nb-readonly-note">{t("knowledgeReadOnlyBlock")}</span>;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 段落文本(标签页标签用)。 */
export function labelOf(block: NotionBlockModel): NotionSegment[] {
  return segmentsOf(block);
}
