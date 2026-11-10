import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { NotionBlockModel, NotionSegment } from "@you-brain/core/http/types.js";

import type { MessageKey } from "../../i18n/messages.js";
import { useImeGuard } from "../../lib/ime-guard.js";
import { renderMath } from "../../lib/math.js";
import { ConfirmDialog } from "../../components/dialog.js";
import { Icon } from "../../components/icons.js";
import {
  applyInlineMarkdown,
  caretOffsetIn,
  caretOnEdgeLine,
  domToSegments,
  equationHtml,
  extractTailFromCaret,
  mentionHtml,
  moveCaretToNeighbor,
  replaceSelection,
  segmentsToHtml,
  selectionInside,
  selectionOffsets,
  selectionSegments,
  selectOffsets,
  setCaretAtOffset,
  textBeforeCaret,
} from "./dom-text.js";
import { parseLocalPath } from "../../lib/local-path.js";
import { PagePicker, type MediaEditor } from "./block-media.js";
import { CodeBlock } from "./code-block.js";
import type { DatabaseOps } from "./database-view.js";
import { colorClass } from "./dom-text.js";
import { useBlockFocus, type FocusStore } from "./focus-store.js";
import { htmlToMarkdown, isStructuredHtml } from "./html-paste.js";
import { FormatBar, localDate, MentionMenu, searchEmoji, TEXT_COLORS, type InlineCommand, type MentionOption } from "./inline-format.js";
import {
  BLOCK_KINDS,
  blockMarkdown,
  canColorBlock,
  canMoveBlock,
  isEditableBlock,
  markdownShortcutKind,
  parseMarkdownBlocks,
  segmentsOf as safeSegmentsOf,
  turnIntoKindOf,
  caretAfterTextChange,
  type BlockPlacement,
  type PastedBlock,
  type TableOp,
  type TurnIntoKind,
} from "./logic.js";

/** 一段连续输入的停顿阈值与上限(毫秒):决定撤销一步的粒度。 */
const BURST_PAUSE_MS = 500;
const MAX_BURST_MS = 3000;
/** 页面在撤销前派发给正在编辑的行,要求它立刻提交未记录的输入。 */
export const COMMIT_EVENT = "nb-commit";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** 「/」菜单里除文本块外的插入项(媒体、嵌入、高级块)。 */
export type SpecialKind =
  | "table"
  | "page"
  | "linkToPage"
  | "image"
  | "video"
  | "audio"
  | "file"
  | "pdf"
  | "bookmark"
  | "embed"
  | "equation"
  | "toc"
  | "breadcrumb"
  | "columns2"
  | "columns3"
  | "columns4"
  | "tabs"
  | "databaseInline"
  | "databasePage";

export type SlashKind = TurnIntoKind | "divider" | SpecialKind;

/** 「/」菜单条目:kind + 字形图标 + 右侧 markdown 快捷符(对齐 Notion)。 */
interface SlashItem {
  kind: SlashKind;
  labelKey: MessageKey;
  glyph: string;
  hint: string;
  group: "basic" | "media" | "advanced";
  /** 英文别名,方便输入 /img、/h4 之类过滤。 */
  alias?: string;
}

const SLASH_ITEMS: SlashItem[] = [
  { kind: "paragraph", labelKey: "knowledgeTypeParagraph", glyph: "T", hint: "", group: "basic", alias: "text" },
  { kind: "heading1", labelKey: "knowledgeTypeHeading1", glyph: "H₁", hint: "#", group: "basic", alias: "h1" },
  { kind: "heading2", labelKey: "knowledgeTypeHeading2", glyph: "H₂", hint: "##", group: "basic", alias: "h2" },
  { kind: "heading3", labelKey: "knowledgeTypeHeading3", glyph: "H₃", hint: "###", group: "basic", alias: "h3" },
  { kind: "heading4", labelKey: "knowledgeTypeHeading4", glyph: "H₄", hint: "####", group: "basic", alias: "h4" },
  { kind: "bulleted", labelKey: "knowledgeTypeBulleted", glyph: "bulleted", hint: "-", group: "basic", alias: "bullet list" },
  { kind: "numbered", labelKey: "knowledgeTypeNumbered", glyph: "numbered", hint: "1.", group: "basic", alias: "number list" },
  { kind: "todo", labelKey: "knowledgeTypeTodo", glyph: "todo", hint: "[]", group: "basic", alias: "todo" },
  { kind: "toggle", labelKey: "knowledgeTypeToggle", glyph: "toggle", hint: ">", group: "basic", alias: "toggle" },
  { kind: "table", labelKey: "knowledgeTypeTable", glyph: "▦", hint: "", group: "basic", alias: "table" },
  { kind: "page", labelKey: "knowledgeTypePage", glyph: "📄", hint: "", group: "basic", alias: "page" },
  { kind: "databaseInline", labelKey: "knowledgeTypeDatabaseInline", glyph: "▦", hint: "", group: "basic", alias: "database db table view inline" },
  { kind: "databasePage", labelKey: "knowledgeTypeDatabasePage", glyph: "🗂", hint: "", group: "basic", alias: "database db full page" },
  { kind: "quote", labelKey: "knowledgeTypeQuote", glyph: "“", hint: "\"", group: "basic", alias: "quote" },
  { kind: "callout", labelKey: "knowledgeTypeCallout", glyph: "callout", hint: "", group: "basic", alias: "callout" },
  { kind: "divider", labelKey: "knowledgeTypeDivider", glyph: "—", hint: "---", group: "basic", alias: "divider" },
  { kind: "linkToPage", labelKey: "knowledgeTypeLinkToPage", glyph: "↗", hint: "", group: "basic", alias: "link to page" },
  { kind: "image", labelKey: "knowledgeTypeImage", glyph: "🖼", hint: "", group: "media", alias: "image img" },
  { kind: "video", labelKey: "knowledgeTypeVideo", glyph: "🎬", hint: "", group: "media", alias: "video" },
  { kind: "audio", labelKey: "knowledgeTypeAudio", glyph: "🎵", hint: "", group: "media", alias: "audio" },
  { kind: "file", labelKey: "knowledgeTypeFile", glyph: "📎", hint: "", group: "media", alias: "file" },
  { kind: "pdf", labelKey: "knowledgeTypePdf", glyph: "📕", hint: "", group: "media", alias: "pdf" },
  { kind: "bookmark", labelKey: "knowledgeTypeBookmark", glyph: "🔖", hint: "", group: "media", alias: "bookmark" },
  { kind: "embed", labelKey: "knowledgeTypeEmbed", glyph: "⧉", hint: "", group: "media", alias: "embed" },
  { kind: "code", labelKey: "knowledgeTypeCode", glyph: "</>", hint: "```", group: "advanced", alias: "code" },
  { kind: "equation", labelKey: "knowledgeTypeEquation", glyph: "∑", hint: "$$", group: "advanced", alias: "equation math tex" },
  { kind: "toc", labelKey: "knowledgeTypeToc", glyph: "≡", hint: "", group: "advanced", alias: "table of contents toc" },
  { kind: "breadcrumb", labelKey: "knowledgeTypeBreadcrumb", glyph: "›", hint: "", group: "advanced", alias: "breadcrumb" },
  { kind: "toggleHeading1", labelKey: "knowledgeTypeToggleHeading1", glyph: "▸H₁", hint: "", group: "advanced", alias: "toggle heading 1" },
  { kind: "toggleHeading2", labelKey: "knowledgeTypeToggleHeading2", glyph: "▸H₂", hint: "", group: "advanced", alias: "toggle heading 2" },
  { kind: "toggleHeading3", labelKey: "knowledgeTypeToggleHeading3", glyph: "▸H₃", hint: "", group: "advanced", alias: "toggle heading 3" },
  { kind: "columns2", labelKey: "knowledgeTypeColumns2", glyph: "▥", hint: "", group: "advanced", alias: "2 columns" },
  { kind: "columns3", labelKey: "knowledgeTypeColumns3", glyph: "▥", hint: "", group: "advanced", alias: "3 columns" },
  { kind: "columns4", labelKey: "knowledgeTypeColumns4", glyph: "▥", hint: "", group: "advanced", alias: "4 columns" },
  { kind: "tabs", labelKey: "knowledgeTypeTabs", glyph: "⊟", hint: "", group: "advanced", alias: "tabs" },
];

const SLASH_GROUP_LABEL: Record<SlashItem["group"], MessageKey> = {
  basic: "knowledgeSlashGroupBasic",
  media: "knowledgeSlashGroupMedia",
  advanced: "knowledgeSlashGroupAdvanced",
};

const TEXT_KINDS = new Set<string>(BLOCK_KINDS.map((entry) => entry.kind));

/** 上次用过的文字颜色(⌘⇧H 复用,Notion 同款)。 */
let lastColor = "yellow_background";

function isVideoUrl(url: string): boolean {
  return /youtube\.com\/watch|youtu\.be\/|bilibili\.com\/video|vimeo\.com\/\d|\.(mp4|mov|webm|m4v)(\?|$)/iu.test(url);
}

function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/iu.test(url);
}

/** 「/」菜单过滤:中文名、kind、英文别名都能搜;查询里可以有空格(如 /toggle heading)。 */
function filterSlash(query: string, t: Translate): Array<SlashItem & { label: string; groupLabel: string }> {
  // 每个词都要在名称、kind 或英文别名里出现(Notion 同款:/toggle h2、/db inline 都能找到)。
  const words = query.trim().toLowerCase().split(/\s+/u).filter((word) => word !== "");
  return SLASH_ITEMS.map((item) => ({ ...item, label: t(item.labelKey), groupLabel: t(SLASH_GROUP_LABEL[item.group]) })).filter((item) => {
    const haystack = `${item.label} ${item.kind} ${item.alias ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** 菜单里的 16px 线性图标(其余用字形文本)。 */
function SlashGlyph({ glyph }: { glyph: string }): ReactNode {
  if (glyph === "bulleted" || glyph === "numbered" || glyph === "todo" || glyph === "toggle" || glyph === "callout") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
        {glyph === "bulleted" ? (
          <>
            <circle cx="3" cy="4" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="3" cy="12" r="0.9" fill="currentColor" stroke="none" />
            <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
          </>
        ) : null}
        {glyph === "numbered" ? (
          <>
            <text x="1.2" y="6" fontSize="4.6" fill="currentColor" stroke="none">1</text>
            <text x="1.2" y="10.4" fontSize="4.6" fill="currentColor" stroke="none">2</text>
            <text x="1.2" y="14.6" fontSize="4.6" fill="currentColor" stroke="none">3</text>
            <path d="M6.5 4.5h7M6.5 9h7M6.5 13.5h7" />
          </>
        ) : null}
        {glyph === "todo" ? (
          <>
            <rect x="2.5" y="2.5" width="5.4" height="5.4" rx="1.2" />
            <path d="M3.8 5.2l1.3 1.3 2.2-2.4" />
            <path d="M10.5 5.2h3.5M2.5 10.8h11.5" />
          </>
        ) : null}
        {glyph === "toggle" ? (
          <>
            <path d="M4 4.6l4.6 3.4L4 11.4z" fill="currentColor" stroke="none" />
            <path d="M10.5 8h3.5" />
          </>
        ) : null}
        {glyph === "callout" ? (
          <>
            <circle cx="8" cy="8" r="5.6" />
            <path d="M8 7.4v3.4" />
            <circle cx="8" cy="5.2" r="0.8" fill="currentColor" stroke="none" />
          </>
        ) : null}
      </svg>
    );
  }
  return <span className="nb-slash-glyph-text">{glyph}</span>;
}

export interface FocusRequest {
  blockId: string;
  at: "start" | "end" | number;
  /** 聚焦后直接打开「/」菜单(＋ 按钮)。 */
  slash?: boolean;
  /**
   * 撤销/重做后:按块模型重画这一行(它正有焦点,平时不会被外部更新覆盖)。
   * at 是撤销前的光标;文字变了就落在变化处(prevText 是撤销前的文字)。
   */
  refresh?: boolean;
  prevText?: string;
}

export interface BlockEditorCallbacks extends MediaEditor {
  /** 保存块文本(segments 为空 = 清空并删块)。 */
  saveSegments(block: NotionBlockModel, segments: NotionSegment[]): Promise<void>;
  saveCode(blockId: string, text: string, language?: string): Promise<void>;
  /** focusId:删完后光标去哪(Backspace 删空块时落到上一块末尾)。 */
  remove(blockId: string, focusId?: string | null): Promise<void>;
  move(blockId: string, direction: "up" | "down"): Promise<void>;
  duplicate(blockId: string): Promise<void>;
  toggleTodo(block: NotionBlockModel): Promise<void>;
  addBelow(afterBlockId: string | null, kind: TurnIntoKind | "divider", openSlash?: boolean): Promise<void>;
  /** 「/」菜单里的媒体、嵌入与高级块;replace = 用它替换当前空段落。 */
  insertSpecial(block: NotionBlockModel, kind: SpecialKind, replace: boolean): void;
  /** 折叠块/可折叠标题是否展开。 */
  isOpen(blockId: string): boolean;
  toggleOpen(blockId: string): void;
  /** 在块里新增第一个子块(空折叠块、空标签页)。 */
  addChild(parentId: string): void;
  /** Esc:退出编辑并选中这个块(之后可整块删除、复制、移动)。 */
  selectBlock(blockId: string, extend?: boolean): void;
  /** 菜单作用的块:这个块在多选里就是全部选中的块,否则只有它。 */
  targetsFor(blockId: string): string[];
  setColor(blockIds: string[], color: string): void;
  removeBlocks(blockIds: string[]): void;
  duplicateBlocks(blockIds: string[]): void;
  copyBlocks(blockIds: string[]): void;
  /** 标题的「可折叠」开关。 */
  setToggleable(block: NotionBlockModel, on: boolean): void;
  /** 粘贴图片等文件:上传后插成媒体块。 */
  pasteFiles(block: NotionBlockModel, files: File[]): void;
  /** @ 提及的候选人(工作区成员)。 */
  mentionUsers(query: string): Array<{ id: string; name: string }>;
  /** 点击行内代码形式的本地路径:桌面端交给系统打开。 */
  openLocalPath(path: string): void;
  /** 粘贴链接后选「书签/嵌入/视频/图片」:用这个链接替换当前段落。 */
  insertLinkBlock(block: NotionBlockModel, kind: "bookmark" | "embed" | "video" | "image", url: string): void;
  /** 内嵌数据库的读写。 */
  databaseOps: DatabaseOps;
  /** 「移动到」另一个页面(放到末尾)。 */
  moveToPage(blockIds: string[], pageId: string): void;
  /** 拖拽排序/多块移动:把一组块(带子树)移到 target。 */
  relocateBlocks(blockIds: string[], target: BlockPlacement): void;
  /** 回车分块:当前块保留 head,新块带 tail。 */
  split(block: NotionBlockModel, head: NotionSegment[], tail: NotionSegment[]): Promise<void>;
  merge(block: NotionBlockModel, prevId: string): Promise<void>;
  /**
   * 粘贴多块 Markdown:head 非空表示当前块保留 head、items 插在它后面、tail 另起一段;
   * head 为 null 表示当前块是空的,直接被 items 替换。
   */
  /** Tab:缩进成上一个兄弟的子块;Shift+Tab:退回父块的下一个兄弟。caret 是光标偏移,换位后恢复。 */
  indent(block: NotionBlockModel, caret?: number): Promise<void>;
  outdent(block: NotionBlockModel, caret?: number): Promise<void>;
  paste(block: NotionBlockModel, head: NotionSegment[] | null, items: PastedBlock[], tail: NotionSegment[]): Promise<void>;
  turnInto(block: NotionBlockModel, kind: TurnIntoKind): Promise<void>;
  /** 正文第一行再往上:光标回到页面标题。 */
  focusTitle(): void;
  /** 表格编辑:本地先应用,再排队写回 Notion。 */
  tableEdit(block: NotionBlockModel, op: TableOp): void;
  /** @ 提及的候选页面(按标题过滤)。 */
  mentionPages(query: string): Array<{ id: string; title: string; object: "page" | "database" }>;
  /** 光标焦点请求:按块订阅,只有目标行会重渲染。 */
  focusStore: FocusStore;
}

/** 可编辑块的行内容器:contentEditable,回车分块、退格合并、/ 唤菜单、划词格式栏。 */
export function EditableRow({
  block,
  editor,
  t,
  prevEditableId,
  numberedIndex,
  chrome,
  children,
}: {
  block: NotionBlockModel;
  editor: BlockEditorCallbacks;
  t: Translate;
  prevEditableId: string | null;
  numberedIndex?: number | undefined;
  /** 块文本之外的装饰(checkbox、序号、emoji)。 */
  chrome?: ReactNode;
  children?: ReactNode;
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  /** 打开块菜单时直接展开的子菜单(⌘⇧P = 移动到)。 */
  const [menuSub, setMenuSub] = useState<"move" | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashActive, setSlashActive] = useState(0);
  const [slashFlip, setSlashFlip] = useState(false);
  const [floatBar, setFloatBar] = useState<{ x: number; y: number; panel?: "link" } | null>(null);
  /** 格式栏打开时的选区:链接输入框会抢走焦点,应用前要还原。 */
  const savedRange = useRef<{ start: number; end: number } | null>(null);
  /** 行内菜单:@ 提及(页面、人、日期)、[[ 链接页面、: emoji。 */
  const [mention, setMention] = useState<{ query: string; active: number; flip: boolean; trigger: "@" | "[[" | ":" } | null>(null);
  /** 粘贴单个链接后的选择(Notion:保持链接 / 网页书签 / 嵌入)。 */
  const [urlMenu, setUrlMenu] = useState<{ url: string; x: number; y: number } | null>(null);
  const [equationEdit, setEquationEdit] = useState<{ node: HTMLElement; x: number; y: number; value: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ime = useImeGuard();
  const editable = isEditableBlock(block);
  const isCode = block.kind === "code";
  const focus = useBlockFocus(editor.focusStore, block.id);

  useEffect(() => {
    const el = ref.current;
    if (!el || isCode) return;
    el.innerHTML = segmentsToHtml(safeSegmentsOf(block));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id]);

  useEffect(() => {
    const el = ref.current;
    if (!el || isCode) return;
    if (document.activeElement === el) return;
    // 焦点在这一行的格式栏里(正在输入链接、公式):还在编辑这一行,别重画。
    if (document.activeElement?.closest(".nb-floatbar") && savedRange.current) return;
    const html = segmentsToHtml(safeSegmentsOf(block));
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [block, isCode]);

  useEffect(() => {
    if (focus === null) return;
    // 代码块没有行内编辑区:被要求聚焦(刚插入/刚转成代码块)就直接打开代码编辑面板。
    // 代码块的聚焦由 CodeBlock 自己处理。
    if (isCode) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (focus.refresh) {
      const html = segmentsToHtml(safeSegmentsOf(block));
      if (el.innerHTML !== html) el.innerHTML = html;
      const text = el.textContent ?? "";
      const caret = focus.prevText !== undefined && focus.prevText !== text ? caretAfterTextChange(focus.prevText, text) : focus.at;
      setCaretAtOffset(el, caret === "start" ? 0 : caret === "end" ? text.length : Math.min(caret, text.length));
      editor.focusStore.clear();
      return;
    }
    if (focus.slash) {
      // ＋ 按钮:新行里放一个「/」并打开菜单(Notion 同款)。
      el.textContent = "/";
      setCaretAtOffset(el, 1);
      setSlashOpen(true);
      setSlashQuery("");
      setSlashActive(0);
      editor.focusStore.clear();
      return;
    }
    const at = focus.at;
    setCaretAtOffset(el, at === "start" ? 0 : at === "end" ? el.textContent?.length ?? 0 : at);
    editor.focusStore.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, block.id]);

  const flushSave = useCallback(() => {
    const el = ref.current;
    if (!el || !dirty.current || isCode) return;
    dirty.current = false;
    const segments = domToSegments(el);
    void editor.saveSegments(block, segments).catch(() => undefined);
  }, [block, editor, isCode]);

  // 一段连续输入记成一步撤销:停顿约 0.5 秒就提交(⌘Z 一次撤销这一段);一直不停也最多 3 秒一步。
  const burstStart = useRef<number | null>(null);
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const now = Date.now();
    burstStart.current ??= now;
    const wait = now - burstStart.current >= MAX_BURST_MS ? 0 : BURST_PAUSE_MS;
    const tick = (): void => {
      // 组词中的拼音还不是内容,等输入法落字再存。
      if (ime.isComposingNow()) saveTimer.current = setTimeout(tick, 400);
      else {
        burstStart.current = null;
        flushSave();
      }
    };
    saveTimer.current = setTimeout(tick, wait);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushSave]);

  // ⌘Z/⌘⇧Z 前由页面发来:把这一行还没提交的输入立刻记成一步,不用让它失焦。
  const commitNow = useRef<() => void>(() => undefined);
  commitNow.current = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    burstStart.current = null;
    flushSave();
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCommit = (): void => commitNow.current();
    el.addEventListener(COMMIT_EVENT, onCommit);
    return () => el.removeEventListener(COMMIT_EVENT, onCommit);
  }, []);

  // 卸载(切页、块被替换)时,没落盘的输入补发一次,不丢字。
  const latest = useRef({ block, editor });
  latest.current = { block, editor };
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (el && dirty.current && !isCode) {
        dirty.current = false;
        void latest.current.editor.saveSegments(latest.current.block, domToSegments(el)).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const el = ref.current;
    if (!el) return;
    // 输入法组词期间的 Enter/方向键是在选词,不是分块/移动光标。
    if (ime.isComposing(event)) return;
    if (mention) {
      const count = mentionOptions.length;
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
      if (count > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMention({ ...mention, active: (mention.active + step + count) % count });
        return;
      }
      if (count > 0 && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        const option = mentionOptions[Math.min(mention.active, count - 1)];
        if (option) pickMention(option);
        return;
      }
    }
    if (slashOpen) {
      const count = slashItems.length;
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashOpen(false);
        return;
      }
      if (count > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSlashActive((value) => Math.min(value + 1, count - 1));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSlashActive((value) => Math.max(value - 1, 0));
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const item = slashItems[Math.min(slashActive, count - 1)];
          if (item) pickSlash(item.kind);
          return;
        }
      }
    }
    const mod = event.metaKey || event.ctrlKey;
    // Notion 快捷键:⌘⌥0~8 转换类型(正文、标题 1~3、待办、无序、有序、折叠、代码)。
    if (mod && event.altKey && /^Digit[0-8]$/u.test(event.code)) {
      const target = (["paragraph", "heading1", "heading2", "heading3", "todo", "bulleted", "numbered", "toggle", "code"] as const)[Number(event.code.slice(5))];
      event.preventDefault();
      if (target && target !== turnIntoKindOf(block)) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        flushSave();
        void editor.turnInto(block, target);
      }
      return;
    }
    // ⌘⌥9:把这一行变成子页面(Notion 同款,标题就是这一行的文字)。
    if (mod && event.altKey && event.code === "Digit9") {
      event.preventDefault();
      flushSave();
      editor.insertSpecial(block, "page", true);
      return;
    }
    // ⌘Enter:勾选/取消待办,展开/收起折叠块。
    if (mod && event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (block.kind === "todo") void editor.toggleTodo(block);
      else if (block.kind === "toggle" || (block.kind === "heading" && block.toggleable)) editor.toggleOpen(block.id);
      return;
    }
    // ⌘⇧H:用上次的颜色标记选中文字。
    if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === "h" && selectionInside(el)) {
      event.preventDefault();
      savedRange.current = selectionOffsets(el);
      applyColor(lastColor);
      return;
    }
    // ⌘⇧P:移动到另一个页面(Notion 同款)。
    if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      event.stopPropagation();
      flushSave();
      setMenuSub("move");
      setMenuOpen(true);
      return;
    }
    // ⌘/:打开这一块的菜单(转换类型、颜色、复制、删除……)。
    if (mod && !event.shiftKey && event.key === "/") {
      event.preventDefault();
      flushSave();
      setMenuOpen(true);
      return;
    }
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      const command: InlineCommand | null =
        key === "u" && !event.shiftKey
          ? "underline"
          : key === "s" && event.shiftKey
            ? "strikeThrough"
            : key === "e" && event.shiftKey
              ? "equation"
              : key === "e"
                ? "code"
                : null;
      if (command) {
        event.preventDefault();
        applyInline(command);
        return;
      }
      if (key === "k" && !event.shiftKey) {
        // 选中文字时 ⌘K 是加链接(不再交给全局的命令面板);没选中时照旧打开命令面板。
        const selection = selectionInside(el);
        if (selection) {
          event.preventDefault();
          event.stopPropagation();
          const rect = selection.getRangeAt(0).getBoundingClientRect();
          savedRange.current = selectionOffsets(el);
          setFloatBar({ x: rect.left + rect.width / 2, y: rect.top - 10, panel: "link" });
          return;
        }
      }
    }
    if (mod && (event.key === "b" || event.key === "i")) {
      event.preventDefault();
      document.execCommand(event.key === "b" ? "bold" : "italic");
      dirty.current = true;
      scheduleSave();
      return;
    }
    if (event.key === "Tab" && !mod && !event.altKey) {
      // 缩进/反缩进(Notion 同款);没法缩进时也要吞掉 Tab,别让焦点跳出编辑区。
      event.preventDefault();
      const caret = caretOffsetIn(el) ?? undefined;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      flushSave();
      void (event.shiftKey ? editor.outdent(block, caret) : editor.indent(block, caret));
      return;
    }
    if (event.key === "Enter" && (event.shiftKey || mod)) {
      // Shift+Enter = 块内软换行(Notion 同款);其余带修饰键的 Enter 不做任何事,别让浏览器塞 div。
      event.preventDefault();
      if (event.shiftKey && !mod) {
        document.execCommand("insertLineBreak");
        dirty.current = true;
        scheduleSave();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // 有选中文字时,回车先替换掉选区(与 Notion 一致),再从光标处分块。
      if (window.getSelection()?.isCollapsed === false) document.execCommand("delete");
      // 先把光标之后的内容切走,剩下的才是 head(顺序反了会把尾巴复制一份)。
      const tail = extractTailFromCaret(el);
      const head = domToSegments(el);
      el.innerHTML = segmentsToHtml(head);
      dirty.current = false;
      void editor.split(block, head, tail);
      return;
    }
    if (event.key === "Backspace" && !event.metaKey && !event.altKey) {
      if (caretOffsetIn(el) === 0) {
        event.preventDefault();
        if (saveTimer.current) clearTimeout(saveTimer.current);
        if (block.kind !== "paragraph") {
          // Notion:块首退格先退回普通段落,再按一次才并入上一块。
          flushSave();
          void editor.turnInto(block, "paragraph");
        } else if ((el.textContent ?? "") === "") {
          dirty.current = false;
          void editor.remove(block.id, prevEditableId);
        } else if (prevEditableId) {
          flushSave();
          void editor.merge(block, prevEditableId);
        }
      }
      return;
    }
    // 方向键在块首/块尾继续走进相邻块(各块是独立的编辑区,浏览器不会自动跨过去)。
    if (!event.shiftKey && !mod && !event.altKey) {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const dir = event.key === "ArrowUp" ? -1 : 1;
        if (!caretOnEdgeLine(el, dir)) return;
        if (moveCaretToNeighbor(el, dir, { keepX: true })) {
          event.preventDefault();
        } else if (dir < 0) {
          // 已经是正文第一行:回到标题(Notion 同款)。
          event.preventDefault();
          editor.focusTitle();
        }
        return;
      }
      if (event.key === "ArrowLeft" && caretOffsetIn(el) === 0) {
        if (moveCaretToNeighbor(el, -1, { keepX: false })) event.preventDefault();
        return;
      }
      if (event.key === "ArrowRight" && caretOffsetIn(el) === (el.textContent?.length ?? 0)) {
        if (moveCaretToNeighbor(el, 1, { keepX: false })) event.preventDefault();
        return;
      }
    }
    if (event.key === "Escape") {
      // Notion:Esc 退出编辑并选中整块。
      event.preventDefault();
      flushSave();
      el.blur();
      editor.selectBlock(block.id);
    }
  };

  const onInput = (): void => {
    const el = ref.current;
    if (!el) return;
    if (!ime.isComposingNow()) {
      // 行内 Markdown:**粗体**、*斜体*、`代码`、~~删除线~~、$$公式$$ 输完闭合符号立刻生效。
      if (applyInlineMarkdown(el)) {
        dirty.current = true;
        scheduleSave();
      }
      // @ 提及、[[ 链接页面、: emoji:光标前出现触发符就弹出菜单。
      const before = textBeforeCaret(el);
      const at = /(?:^|\s)@([^\s@]{0,30})$/u.exec(before);
      const link = /\[\[([^\]\n]{0,40})$/u.exec(before);
      const emoji = /(?:^|\s):([a-z\u4e00-\u9fa5_]{1,20})$/iu.exec(before);
      const found = link
        ? { trigger: "[[" as const, query: link[1] ?? "" }
        : at
          ? { trigger: "@" as const, query: at[1] ?? "" }
          : emoji
            ? { trigger: ":" as const, query: emoji[1] ?? "" }
            : null;
      if (found) {
        const row = el.closest(".nb-row");
        const flip = row ? window.innerHeight - row.getBoundingClientRect().bottom < 350 : false;
        setMention((current) => ({
          ...found,
          active: current && current.query === found.query && current.trigger === found.trigger ? current.active : 0,
          flip,
        }));
      } else if (mention) {
        setMention(null);
      }
    }
    const text = el.textContent ?? "";
    // Notion 的 Markdown 快捷输入:空段落里输入「# 」「- 」「1. 」「[] 」「> 」「" 」「```」直接转块。
    if (block.kind === "paragraph" && !ime.isComposingNow()) {
      if (text === "---") {
        // 「---」直接变分隔线(Notion 同款)。
        if (saveTimer.current) clearTimeout(saveTimer.current);
        el.innerHTML = "";
        dirty.current = false;
        void editor.addBelow(block.id, "divider");
        void editor.remove(block.id);
        return;
      }
      if (text === "$$") {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        el.innerHTML = "";
        dirty.current = false;
        editor.insertSpecial(block, "equation", true);
        return;
      }
      const shortcut = text === "```" ? "code" : markdownShortcutKind(text);
      if (shortcut) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        el.innerHTML = "";
        dirty.current = false;
        setSlashOpen(false);
        void editor.turnInto(block, shortcut);
        return;
      }
    }
    dirty.current = true;
    scheduleSave();
    // Notion 规则:正文中出现「/」即弹菜单,其后文本作为过滤词;带空格时还有匹配项就继续过滤。
    const at = text.lastIndexOf("/");
    const query = at >= 0 ? text.slice(at + 1) : "";
    if (at >= 0 && query.length <= 40 && (!query.includes(" ") || filterSlash(query, t).length > 0)) {
      setSlashOpen(true);
      setSlashQuery(text.slice(at + 1));
      setSlashActive(0);
    } else {
      setSlashOpen(false);
      setSlashQuery("");
    }
  };

  // 「/」菜单:继续输入即过滤,方向键选择,Enter/Tab 确认,Esc 关闭。
  const slashItems = useMemo(
    () => filterSlash(slashQuery, t).map((item) => ({ ...item, group: item.groupLabel })),
    [slashQuery, t],
  );

  useEffect(() => {
    if (!slashOpen) return;
    // 菜单贴行弹出;行下方放不下就翻到行上方。
    const row = ref.current?.closest(".nb-row");
    if (!row) return;
    const rect = row.getBoundingClientRect();
    setSlashFlip(window.innerHeight - rect.bottom < 350);
    const onDown = (event: MouseEvent): void => {
      const menu = row.querySelector(".nb-slash-menu");
      if (menu && !menu.contains(event.target as Node) && !ref.current?.contains(event.target as Node)) {
        setSlashOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [slashOpen]);

  const pickSlash = useCallback(
    (kind: SlashKind): void => {
      const el = ref.current;
      let prefix = "";
      if (el) {
        const text = el.textContent ?? "";
        const at = text.lastIndexOf("/");
        prefix = at >= 0 ? text.slice(0, at) : text;
        if (prefix === "") el.innerHTML = "";
        else el.textContent = prefix;
        dirty.current = true;
      }
      setSlashOpen(false);
      setSlashQuery("");
      flushSave();
      if (kind === "divider") {
        void editor.addBelow(block.id, "divider");
        // 空段落里选分隔线 = 用分隔线替掉这一行(Notion 同款),不留空行。
        if (prefix === "" && block.kind === "paragraph") void editor.remove(block.id);
        return;
      }
      if (kind === "paragraph") return;
      if (!TEXT_KINDS.has(kind)) {
        editor.insertSpecial(block, kind as SpecialKind, prefix === "" && block.kind === "paragraph");
        return;
      }
      void editor.turnInto(block, kind as TurnIntoKind);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [block, editor],
  );

  const onSelectionChange = (): void => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement !== el) {
      // 焦点在格式栏自己的输入框里(链接、公式)时,格式栏要留着。
      if (document.activeElement?.closest(".nb-floatbar")) return;
      setFloatBar(null);
      return;
    }
    const selection = selectionInside(el);
    if (selection) {
      const range = selection.getRangeAt(0);
      savedRange.current = selectionOffsets(el);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0) setFloatBar((current) => ({ x: rect.left + rect.width / 2, y: rect.top - 10, ...(current?.panel ? { panel: current.panel } : {}) }));
    } else {
      setFloatBar(null);
    }
  };

  useEffect(() => {
    const handler = (): void => onSelectionChange();
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 先把选区还原(链接输入框等会抢走焦点),再执行格式命令。 */
  const restoreSelection = (): void => {
    const el = ref.current;
    const range = savedRange.current;
    if (!el || !range) return;
    el.focus();
    selectOffsets(el, range.start, range.end);
  };

  const applyInline = (command: InlineCommand): void => {
    const el = ref.current;
    if (!el) return;
    if (command === "code") {
      const segments = selectionSegments(el);
      if (!segments || segments.length === 0) return;
      const allCode = segments.every((segment) => segment.code);
      replaceSelection(segments.map((segment) => ({ ...segment, code: !allCode })));
    } else if (command === "equation") {
      const text = (selectionSegments(el) ?? []).map((segment) => segment.text).join("");
      if (text.trim() === "") return;
      document.execCommand("insertHTML", false, `${equationHtml(text)}\u200B`);
    } else {
      document.execCommand(command);
    }
    dirty.current = true;
    scheduleSave();
  };

  /** 用路径替换当前选区,并存成行内代码(后面补一个零宽字符,让光标落在代码之外)。 */
  const insertPathCode = (path: string): void => {
    const escaped = path.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    document.execCommand("insertHTML", false, `<code>${escaped}</code>\u200B`);
    dirty.current = true;
    scheduleSave();
  };

  const applyLocalPath = (path: string): void => {
    restoreSelection();
    insertPathCode(path);
    setFloatBar(null);
  };

  const applyLink = (url: string | null): void => {
    restoreSelection();
    document.execCommand(url ? "createLink" : "unlink", false, url ?? undefined);
    setFloatBar(null);
    dirty.current = true;
    scheduleSave();
  };

  const applyColor = (color: string): void => {
    const el = ref.current;
    if (!el) return;
    restoreSelection();
    const segments = selectionSegments(el);
    if (!segments || segments.length === 0) return;
    replaceSelection(segments, color);
    if (color !== "default") lastColor = color;
    setFloatBar(null);
    dirty.current = true;
    scheduleSave();
  };

  const mentionOptions = useMemo((): MentionOption[] => {
    if (!mention) return [];
    const query = mention.query.trim().toLowerCase();
    if (mention.trigger === ":") {
      return searchEmoji(query).map(({ emoji, name }) => ({ key: `emoji-${emoji}`, label: `${emoji} ${name}`, hint: "", mention: { type: "emoji", emoji } }));
    }
    const pages = editor.mentionPages(mention.query).map((page) => ({
      key: page.id,
      label: page.title,
      hint: "",
      mention: page.object === "database" ? { type: "database", database: { id: page.id } } : { type: "page", page: { id: page.id } },
    }));
    const dates = [
      { offset: 0, label: t("knowledgeMentionToday") },
      { offset: 1, label: t("knowledgeMentionTomorrow") },
      { offset: -1, label: t("knowledgeMentionYesterday") },
    ]
      .map(({ offset, label }) => ({ date: localDate(offset), label }))
      .filter(({ date, label }) => query === "" || label.toLowerCase().includes(query) || date.includes(query) || "date".includes(query))
      .map(({ date, label }) => ({ key: `date-${date}`, label, hint: date, mention: { type: "date", date: { start: date } } }));
    if (mention.trigger === "[[") return pages;
    const people = editor.mentionUsers(mention.query).map((user) => ({
      key: `user-${user.id}`,
      label: user.name,
      hint: "",
      mention: { type: "user", user: { id: user.id } },
    }));
    return [...people, ...pages, ...dates];
  }, [editor, mention, t]);

  const pickMention = (option: MentionOption): void => {
    const el = ref.current;
    if (!el || !mention) return;
    // 删掉「触发符 + 关键字」再插入(提及整体不可编辑),后面补一个空格方便继续打字。
    for (let index = 0; index < mention.query.length + mention.trigger.length; index += 1) document.execCommand("delete");
    if (option.mention.type === "emoji") {
      document.execCommand("insertText", false, String(option.mention.emoji ?? ""));
    } else {
      const label = option.mention.type === "date" ? `@${option.hint}` : option.mention.type === "user" ? `@${option.label}` : option.label;
      // 空格和提及一起插入:光标落在空格后面。分两次插时光标会卡在不可编辑的提及里,后面打的字会丢。
      document.execCommand("insertHTML", false, `${mentionHtml(label, option.mention)}\u00a0`);
    }
    setMention(null);
    dirty.current = true;
    scheduleSave();
  };

  /** 公式编辑框确认:改写公式节点;清空即删除。 */
  const submitEquation = (): void => {
    if (!equationEdit) return;
    const value = equationEdit.value.trim();
    if (value === "") equationEdit.node.remove();
    else {
      equationEdit.node.dataset.equation = value;
      equationEdit.node.innerHTML = renderMath(value);
    }
    setEquationEdit(null);
    dirty.current = true;
    flushSave();
  };

  const exec = (command: string, value?: string): void => {
    document.execCommand(command, false, value);
    dirty.current = true;
    scheduleSave();
  };

  if (!editable || isCode) {
    return (
      <div className={`nb-row nb-row-plain nb-row-${block.kind}`} data-block-id={block.id}>
        <div className="nb-row-main">
          {/* 代码块的正文不在富文本编辑路径里,静态展示(带语法高亮);点正文或 ⋯→编辑 打开面板。 */}
          {isCode && block.kind === "code" ? (
            <CodeBlock
              block={block}
              t={t}
              focusRequested={focus !== null}
              onFocusHandled={editor.focusStore.clear}
              onSave={(text, language) => {
                if (text !== block.text || language !== block.language) void editor.saveCode(block.id, text, language);
              }}
              onEmptyBackspace={() => void editor.turnInto(block, "paragraph")}
              onEscape={() => editor.selectBlock(block.id)}
            />
          ) : null}
          {children}
        </div>
        <BlockHandles
          block={block}
          editor={editor}
          t={t}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          pickerOpen={pickerOpen}
          setPickerOpen={setPickerOpen}
        />
        {menuOpen ? (
          <BlockMenu
          block={block}
          editor={editor}
          t={t}
          initialSub={menuSub}
          onClose={() => {
            setMenuOpen(false);
            setMenuSub(null);
          }}
        />
        ) : null}
      </div>
    );
  }

  const kindClass = block.kind === "heading" ? `heading-${block.level}` : block.kind;
  const tone = block.kind !== "callout" && block.color ? ` ${colorClass(block.color)}` : "";
  const calloutTone = block.kind === "callout" && block.color !== "default" ? ` ${colorClass(block.color)}` : "";
  return (
    <div
      data-block-id={block.id}
      className={`nb-row nb-row-${kindClass}${tone}${calloutTone}${block.kind === "heading" && block.toggleable ? " is-toggle-heading" : ""}`}
      onMouseDown={(event) => {
        // 点在行本身的空白处(复选框与正文之间的缝、行尾右侧等):光标落到这一行末尾。
        const el = ref.current;
        if (event.target !== event.currentTarget || !el) return;
        event.preventDefault();
        el.focus();
        setCaretAtOffset(el, el.textContent?.length ?? 0);
      }}
    >
      {chrome}
      <div className="nb-row-main">
        <div
          ref={ref}
          className={`nb-editable nb-editable-${kindClass}`}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          data-placeholder={t("knowledgeEditablePlaceholder")}
          onKeyDown={onKeyDown}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={(event) => {
            ime.onCompositionEnd(event);
            // 组词结束后补一次输入处理:组词期间跳过的快捷输入/「/」菜单在这里生效。
            onInput();
          }}
          onInput={onInput}
          onClick={(event) => {
            // 行内代码里是本地路径:点击打开(选中文字拖选时不触发)。
            const codeNode = (event.target as HTMLElement).closest<HTMLElement>("code");
            if (codeNode && ref.current?.contains(codeNode) && window.getSelection()?.isCollapsed !== false) {
              const localPath = parseLocalPath(codeNode.textContent ?? "");
              if (localPath) {
                editor.openLocalPath(localPath);
                return;
              }
            }
            const node = (event.target as HTMLElement).closest<HTMLElement>(".nb-equation");
            if (!node || !ref.current?.contains(node)) return;
            const rect = node.getBoundingClientRect();
            setEquationEdit({ node, x: rect.left, y: rect.bottom + 6, value: node.dataset.equation ?? "" });
          }}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (!(next instanceof Element && next.closest(".nb-floatbar"))) setFloatBar(null);
            setMention(null);
            flushSave();
          }}
          onPaste={(event) => {
            event.preventDefault();
            const el = ref.current;
            if (!el) return;
            const files = Array.from(event.clipboardData.files);
            if (files.length > 0) {
              // 粘贴截图/图片文件:上传后插成图片(其余文件插成附件)。
              flushSave();
              editor.pasteFiles(block, files);
              return;
            }
            const plainText = event.clipboardData.getData("text/plain").trim();
            const pastedPath = parseLocalPath(plainText);
            if (pastedPath) {
              // 粘贴本地路径(含 file://):Notion 不收 file 链接,存成行内代码,点击打开。
              insertPathCode(pastedPath);
              return;
            }
            if (/^https?:\/\/\S+$/iu.test(plainText)) {
              // 粘贴单个链接:选中文字时变成链接;空行里粘贴后给出「书签 / 嵌入」选项(Notion 同款)。
              if (window.getSelection()?.isCollapsed === false && selectionInside(el)) {
                document.execCommand("createLink", false, plainText);
              } else {
                const wasEmpty = (el.textContent ?? "").trim() === "";
                document.execCommand("insertHTML", false, `<a href="${plainText.replaceAll('"', "%22")}">${plainText.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</a>\u200B`);
                if (wasEmpty && block.kind === "paragraph") {
                  const rect = el.getBoundingClientRect();
                  setUrlMenu({ url: plainText, x: rect.left, y: rect.bottom + 4 });
                }
              }
              dirty.current = true;
              scheduleSave();
              return;
            }
            const html = event.clipboardData.getData("text/html");
            // 网页、文档复制来的富文本:按块结构转换(标题、列表、表格、图片、代码……)。
            const text = html && isStructuredHtml(html) ? htmlToMarkdown(html) : event.clipboardData.getData("text/plain");
            const items = parseMarkdownBlocks(text);
            if (items.length <= 1 && (items[0]?.kind ?? "paragraph") === "paragraph") {
              // 单行:行内 Markdown(**粗体** 等)直接转成格式粘到光标处。
              const segments = items[0]?.segments ?? [];
              const formatted = segments.some(
                (segment) => segment.bold || segment.italic || segment.code || segment.strikethrough || segment.href,
              );
              if (formatted) document.execCommand("insertHTML", false, segmentsToHtml(segments));
              else document.execCommand("insertText", false, segments.map((segment) => segment.text).join("") || text);
              dirty.current = true;
              scheduleSave();
              return;
            }
            // 多行 Markdown:拆成多个块(标题/列表/待办/引用/代码/分隔线),不再挤成一行。
            if (window.getSelection()?.isCollapsed === false) document.execCommand("delete");
            if (saveTimer.current) clearTimeout(saveTimer.current);
            let head: NotionSegment[] | null = null;
            let tail: NotionSegment[] = [];
            if ((el.textContent ?? "") !== "") {
              tail = extractTailFromCaret(el);
              head = domToSegments(el);
              el.innerHTML = segmentsToHtml(head);
            }
            dirty.current = false;
            void editor.paste(block, head, items, tail);
          }}
        />
        {children ? <div className="nb-row-children">{children}</div> : null}
      </div>
      <BlockHandles
        block={block}
        editor={editor}
        t={t}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen}
      />
      {menuOpen ? (
        <BlockMenu
          block={block}
          editor={editor}
          t={t}
          initialSub={menuSub}
          onClose={() => {
            setMenuOpen(false);
            setMenuSub(null);
          }}
        />
      ) : null}

      {slashOpen ? (
        <div
          className={"nb-slash-menu" + (slashFlip ? " is-flip" : "")}
          onMouseDown={(event) => event.preventDefault()}
        >
          {slashItems.length === 0 ? (
            <div className="nb-slash-empty">{t("knowledgeSlashEmpty")}</div>
          ) : (
            <>
              {slashItems.map((item, index) => {
                const showGroup = index === 0 || slashItems[index - 1]?.group !== item.group;
                return (
                  <Fragment key={item.kind}>
                    {showGroup ? <div className="nb-slash-group">{item.group}</div> : null}
                    <button
                      type="button"
                      role="menuitem"
                      ref={
                        index === Math.min(slashActive, slashItems.length - 1)
                          ? (el) => {
                              // 方向键移动时,选中项始终滚进可视区(Notion 同款)。
                              if (el) el.scrollIntoView({ block: "nearest" });
                            }
                          : undefined
                      }
                      className={"nb-slash-item" + (index === Math.min(slashActive, slashItems.length - 1) ? " is-active" : "")}
                      onMouseEnter={() => setSlashActive(index)}
                      onClick={() => pickSlash(item.kind)}
                    >
                      <span className="nb-slash-glyph">
                        <SlashGlyph glyph={item.glyph} />
                      </span>
                      <span className="nb-slash-label">{item.label}</span>
                      {item.hint !== "" ? <span className="nb-slash-hint">{item.hint}</span> : null}
                    </button>
                  </Fragment>
                );
              })}
              <button type="button" className="nb-slash-footer" onClick={() => setSlashOpen(false)}>
                <span>{t("knowledgeSlashClose")}</span>
                <span className="esc">esc</span>
              </button>
            </>
          )}
        </div>
      ) : null}
      {floatBar ? (
        <FormatBar
          key={floatBar.panel ?? "bar"}
          x={floatBar.x}
          y={floatBar.y}
          t={t}
          initialPanel={floatBar.panel}
          currentHref={(ref.current ? selectionSegments(ref.current) : null)?.find((segment) => segment.href)?.href ?? null}
          onCommand={applyInline}
          onLink={applyLink}
          onLocalPath={applyLocalPath}
          onColor={applyColor}
        />
      ) : null}
      {mention ? (
        <MentionMenu
          options={mentionOptions}
          active={Math.min(mention.active, Math.max(0, mentionOptions.length - 1))}
          flip={mention.flip}
          t={t}
          onHover={(index) => setMention({ ...mention, active: index })}
          onPick={pickMention}
        />
      ) : null}
      {urlMenu ? (
        <>
          <div className="nb-scrim" onClick={() => setUrlMenu(null)} role="presentation" />
          <div className="nb-menu nb-url-menu" role="menu" style={{ position: "fixed", left: urlMenu.x, top: urlMenu.y }}>
            <button type="button" role="menuitem" autoFocus onClick={() => setUrlMenu(null)}>
              🔗 {t("knowledgeUrlKeep")}
            </button>
            {(["bookmark", "embed", ...(isVideoUrl(urlMenu.url) ? (["video"] as const) : []), ...(isImageUrl(urlMenu.url) ? (["image"] as const) : [])] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="menuitem"
                onClick={() => {
                  const url = urlMenu.url;
                  setUrlMenu(null);
                  dirty.current = false;
                  if (saveTimer.current) clearTimeout(saveTimer.current);
                  editor.insertLinkBlock(block, kind, url);
                }}
              >
                {kind === "bookmark" ? "🔖" : kind === "embed" ? "⧉" : kind === "video" ? "🎬" : "🖼"} {t(kind === "bookmark" ? "knowledgeTypeBookmark" : kind === "embed" ? "knowledgeTypeEmbed" : kind === "video" ? "knowledgeTypeVideo" : "knowledgeTypeImage")}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {equationEdit ? (
        <form
          className="nb-floatbar nb-floatbar-panel nb-equation-edit"
          style={{ left: equationEdit.x, top: equationEdit.y }}
          onSubmit={(event) => {
            event.preventDefault();
            submitEquation();
          }}
        >
          <input
            autoFocus
            value={equationEdit.value}
            placeholder={t("knowledgeEquationPlaceholder")}
            onChange={(event) => setEquationEdit({ ...equationEdit, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEquationEdit(null);
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitEquation();
              }
            }}
            onBlur={() => setEquationEdit(null)}
          />
        </form>
      ) : null}
    </div>
  );
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function BlockHandles({
  block,
  editor,
  t,
  menuOpen,
  setMenuOpen,
  pickerOpen,
  setPickerOpen,
}: {
  block: NotionBlockModel;
  editor: BlockEditorCallbacks;
  t: Translate;
  menuOpen: boolean;
  setMenuOpen: (value: boolean) => void;
  pickerOpen: boolean;
  setPickerOpen: (value: boolean) => void;
}): ReactNode {
  return (
    <>
      <button
        type="button"
        className="nb-handle"
        aria-label={t("knowledgeBlockMenu")}
        {...(canMoveBlock(block) ? { "data-drag-handle": block.id } : {})}
        onClick={(event) => {
          if (event.shiftKey) {
            // Shift+点手柄:加入多选。
            editor.selectBlock(block.id, true);
            return;
          }
          setPickerOpen(false);
          setMenuOpen(!menuOpen);
        }}
      >
        <Icon name="grip" size={14} />
      </button>
      <button
        type="button"
        className="nb-add-below"
        aria-label={t("knowledgeAddBelow")}
        onClick={() => {
          setMenuOpen(false);
          setPickerOpen(false);
          // Notion:＋ 在下方新起一行并打开「/」菜单。
          void editor.addBelow(block.id, "paragraph", true);
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </>
  );
}

function BlockMenu({
  block,
  editor,
  t,
  initialSub,
  onClose,
}: {
  block: NotionBlockModel;
  editor: BlockEditorCallbacks;
  t: Translate;
  initialSub?: "move" | null | undefined;
  onClose: () => void;
}): ReactNode {
  const [sub, setSub] = useState<"turn" | "color" | "move" | null>(initialSub ?? null);
  const [confirmChildren, setConfirmChildren] = useState(false);
  const targets = editor.targetsFor(block.id);
  const many = targets.length > 1;
  const movable = canMoveBlock(block);
  const current = turnIntoKindOf(block);
  const run = (action: () => void | Promise<void>): void => {
    onClose();
    void Promise.resolve(action()).catch(() => undefined);
  };
  return (
    <>
      <div className="nb-scrim" onClick={onClose} role="presentation" />
      <div className="nb-menu" role="menu">
        {many ? <div className="nb-menu-note">{t("knowledgeSelectedCount", { count: targets.length })}</div> : null}

        {block.kind === "todo" && !many ? (
          <button type="button" role="menuitem" onClick={() => run(() => editor.toggleTodo(block))}>
            ☑ {block.checked ? t("knowledgeUncheck") : t("knowledgeCheck")}
          </button>
        ) : null}
        {isEditableBlock(block) && !many ? (
          <button type="button" role="menuitem" onClick={() => setSub(sub === "turn" ? null : "turn")}>
            ⇄ {t("knowledgeTurnInto")}
          </button>
        ) : null}
        {sub === "turn" ? (
          <div className="nb-menu-sub">
            {BLOCK_KINDS.filter((entry) => entry.kind !== "divider").map((entry) => (
              <button
                key={entry.kind}
                type="button"
                role="menuitem"
                className={entry.kind === current ? "is-current" : ""}
                onClick={() => run(() => editor.turnInto(block, entry.kind as TurnIntoKind))}
              >
                {t(entry.labelKey as MessageKey)}
                {entry.kind === current ? " ✓" : ""}
              </button>
            ))}
          </div>
        ) : null}
        {block.kind === "heading" && !many ? (
          <button
            type="button"
            role="menuitem"
            disabled={block.toggleable === true && block.children.length > 0}
            title={block.toggleable === true && block.children.length > 0 ? t("knowledgeToggleableHasChildren") : undefined}
            onClick={() => run(() => editor.setToggleable(block, block.toggleable !== true))}
          >
            ▸ {block.toggleable ? t("knowledgeToggleableOff") : t("knowledgeToggleableOn")}
          </button>
        ) : null}
        {canColorBlock(block) || block.kind === "callout" ? (
          <button type="button" role="menuitem" onClick={() => setSub(sub === "color" ? null : "color")}>
            <span className="nb-color-swatch">A</span> {t("knowledgeFormatColor")}
          </button>
        ) : null}
        {sub === "color" ? (
          <div className="nb-menu-sub nb-menu-colors">
            <div className="nb-floatbar-group">{t("knowledgeColorText")}</div>
            {TEXT_COLORS.map((color) => (
              <button key={color} type="button" role="menuitem" onClick={() => run(() => editor.setColor(targets, color))}>
                <span className={`nb-color-swatch ${colorClass(color)}`}>A</span>
                {t(`knowledgeColor${color[0]!.toUpperCase()}${color.slice(1)}` as MessageKey)}
              </button>
            ))}
            <div className="nb-floatbar-group">{t("knowledgeColorBackground")}</div>
            {TEXT_COLORS.filter((color) => color !== "default").map((color) => (
              <button key={`${color}-bg`} type="button" role="menuitem" onClick={() => run(() => editor.setColor(targets, `${color}_background`))}>
                <span className={`nb-color-swatch ${colorClass(`${color}_background`)}`}>A</span>
                {t(`knowledgeColor${color[0]!.toUpperCase()}${color.slice(1)}` as MessageKey)}
              </button>
            ))}
          </div>
        ) : null}
        <button type="button" role="menuitem" disabled={!movable} onClick={() => setSub(sub === "move" ? null : "move")}>
          ↪ {t("knowledgeMoveTo")}
          <span className="nb-menu-key">⌘⇧P</span>
        </button>
        {sub === "move" ? (
          <PagePicker
            t={t}
            editor={editor}
            onPick={(page) => {
              if (page.object !== "page") return;
              run(() => editor.moveToPage(targets, page.id));
            }}
            onCancel={() => setSub(null)}
          />
        ) : null}
        <button type="button" role="menuitem" onClick={() => run(() => editor.copyBlocks(targets))}>
          ⎘ {t("knowledgeCopyMarkdown")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!movable}
          title={movable ? undefined : t("knowledgeCannotMove")}
          onClick={() => run(() => editor.duplicateBlocks(targets))}
        >
          ⧉ {t("knowledgeDuplicate")}
          <span className="nb-menu-key">⌘D</span>
        </button>
        {!many ? (
          <>
            <button type="button" role="menuitem" disabled={!movable} onClick={() => run(() => editor.move(block.id, "up"))}>
              ↑ {t("knowledgeMoveUp")}
              <span className="nb-menu-key">⌘⇧↑</span>
            </button>
            <button type="button" role="menuitem" disabled={!movable} onClick={() => run(() => editor.move(block.id, "down"))}>
              ↓ {t("knowledgeMoveDown")}
              <span className="nb-menu-key">⌘⇧↓</span>
            </button>
          </>
        ) : null}
        <button
          type="button"
          role="menuitem"
          className="is-danger"
          onClick={() => {
            if (!many && block.children.length > 0) setConfirmChildren(true);
            else run(() => editor.removeBlocks(targets));
          }}
        >
          🗑 {t("knowledgeDelete")}
          <span className="nb-menu-key">⌫</span>
        </button>
      </div>
      <ConfirmDialog
        open={confirmChildren}
        tone="danger"
        title={t("knowledgeDelete")}
        description={t("knowledgeDeleteConfirm")}
        confirmLabel={t("knowledgeDelete")}
        cancelLabel={t("cancel")}
        onClose={() => {
          setConfirmChildren(false);
          onClose();
        }}
        onConfirm={() => {
          setConfirmChildren(false);
          run(() => editor.removeBlocks(targets));
        }}
      />
    </>
  );
}

export function KindPicker({
  t,
  allowDivider,
  onPick,
  onClose,
}: {
  t: Translate;
  allowDivider: boolean;
  onPick: (kind: TurnIntoKind | "divider") => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const items = BLOCK_KINDS.filter(
    (entry) =>
      (allowDivider || entry.kind !== "divider") &&
      t(entry.labelKey as MessageKey).toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <>
      <div className="nb-scrim" onClick={onClose} role="presentation" />
      <div className="nb-menu nb-menu-picker" role="menu">
        <input
          className="nb-menu-filter"
          type="text"
          autoFocus
          placeholder="/"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter" && items[0]) {
              onPick(items[0].kind);
            }
          }}
        />
        {items.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onPick(entry.kind);
            }}
          >
            {t(entry.labelKey as MessageKey)}
          </button>
        ))}
      </div>
    </>
  );
}

export { blockMarkdown };
