import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { NotionBlockModel, NotionSegment } from "@you-brain/core/http/types.js";

import type { MessageKey } from "../../i18n/messages.js";
import { highlightCode } from "../../lib/highlight.js";
import { ConfirmDialog } from "../../components/dialog.js";
import {
  caretOffsetIn,
  domToSegments,
  extractTailFromCaret,
  segmentsToHtml,
  selectionInside,
  setCaretAtOffset,
} from "./dom-text.js";
import {
  BLOCK_KINDS,
  blockMarkdown,
  canMoveBlock,
  isEditableBlock,
  segmentsOf as safeSegmentsOf,
  type TurnIntoKind,
} from "./logic.js";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** 「/」菜单条目:kind + 字形图标 + 右侧 markdown 快捷符(对齐 Notion)。 */
interface SlashItem {
  kind: TurnIntoKind | "divider";
  labelKey: MessageKey;
  glyph: string;
  hint: string;
}

const SLASH_ITEMS: SlashItem[] = [
  { kind: "paragraph", labelKey: "knowledgeTypeParagraph", glyph: "T", hint: "" },
  { kind: "heading1", labelKey: "knowledgeTypeHeading1", glyph: "H₁", hint: "#" },
  { kind: "heading2", labelKey: "knowledgeTypeHeading2", glyph: "H₂", hint: "##" },
  { kind: "heading3", labelKey: "knowledgeTypeHeading3", glyph: "H₃", hint: "###" },
  { kind: "bulleted", labelKey: "knowledgeTypeBulleted", glyph: "bulleted", hint: "-" },
  { kind: "numbered", labelKey: "knowledgeTypeNumbered", glyph: "numbered", hint: "1." },
  { kind: "todo", labelKey: "knowledgeTypeTodo", glyph: "todo", hint: "[]" },
  { kind: "toggle", labelKey: "knowledgeTypeToggle", glyph: "toggle", hint: ">" },
  { kind: "quote", labelKey: "knowledgeTypeQuote", glyph: "“", hint: "\"" },
  { kind: "callout", labelKey: "knowledgeTypeCallout", glyph: "callout", hint: "" },
  { kind: "code", labelKey: "knowledgeTypeCode", glyph: "</>", hint: "```" },
  { kind: "divider", labelKey: "knowledgeTypeDivider", glyph: "—", hint: "---" },
];

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
}

export interface BlockEditorCallbacks {
  /** 保存块文本(segments 为空 = 清空并删块)。 */
  saveSegments(block: NotionBlockModel, segments: NotionSegment[]): Promise<void>;
  saveCode(blockId: string, text: string, language?: string): Promise<void>;
  remove(blockId: string): Promise<void>;
  move(blockId: string, direction: "up" | "down"): Promise<void>;
  duplicate(blockId: string): Promise<void>;
  toggleTodo(block: NotionBlockModel): Promise<void>;
  addBelow(afterBlockId: string | null, kind: TurnIntoKind | "divider"): Promise<void>;
  /** 回车分块:当前块保留 head,新块带 tail。 */
  split(block: NotionBlockModel, head: NotionSegment[], tail: NotionSegment[]): Promise<void>;
  merge(block: NotionBlockModel, prevId: string): Promise<void>;
  turnInto(block: NotionBlockModel, kind: TurnIntoKind): Promise<void>;
  busy: boolean;
  focus: FocusRequest | null;
  onFocusHandled(): void;
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashActive, setSlashActive] = useState(0);
  const [slashFlip, setSlashFlip] = useState(false);
  const [floatBar, setFloatBar] = useState<{ x: number; y: number } | null>(null);
  const [codeEditing, setCodeEditing] = useState(false);
  const codeWrapRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editable = isEditableBlock(block);
  const isCode = block.kind === "code";

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
    const html = segmentsToHtml(safeSegmentsOf(block));
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [block, isCode]);

  useEffect(() => {
    const el = ref.current;
    if (!el || editor.focus?.blockId !== block.id) return;
    el.focus();
    const at = editor.focus.at;
    setCaretAtOffset(el, at === "start" ? 0 : at === "end" ? el.textContent?.length ?? 0 : at);
    editor.onFocusHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.focus, block.id]);

  const flushSave = useCallback(() => {
    const el = ref.current;
    if (!el || !dirty.current || isCode) return;
    dirty.current = false;
    const segments = domToSegments(el);
    void editor.saveSegments(block, segments).catch(() => undefined);
  }, [block, editor, isCode]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushSave(), 900);
  }, [flushSave]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const el = ref.current;
    if (!el) return;
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
    if (mod && (event.key === "b" || event.key === "i")) {
      event.preventDefault();
      document.execCommand(event.key === "b" ? "bold" : "italic");
      dirty.current = true;
      scheduleSave();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      flushSave();
      const head = domToSegments(el);
      const tail = extractTailFromCaret(el);
      el.innerHTML = segmentsToHtml(head);
      dirty.current = false;
      void editor.split(block, head, tail);
      return;
    }
    if (event.key === "Backspace") {
      if (caretOffsetIn(el) === 0) {
        event.preventDefault();
        flushSave();
        if ((el.textContent ?? "") === "") {
          void editor.remove(block.id);
        } else if (prevEditableId) {
          void editor.merge(block, prevEditableId);
        }
      }
      return;
    }
    if (event.key === "Escape") el.blur();
  };

  const onInput = (): void => {
    dirty.current = true;
    scheduleSave();
    const el = ref.current;
    if (!el) return;
    // Notion 规则:正文中出现「/」即弹菜单,其后文本作为过滤词(空格结束)。
    const text = el.textContent ?? "";
    const at = text.lastIndexOf("/");
    if (at >= 0 && !text.slice(at + 1).includes(" ")) {
      setSlashOpen(true);
      setSlashQuery(text.slice(at + 1));
      setSlashActive(0);
    } else {
      setSlashOpen(false);
      setSlashQuery("");
    }
  };

  // 「/」菜单:继续输入即过滤,方向键选择,Enter/Tab 确认,Esc 关闭。
  const slashItems = useMemo(() => {
    const query = slashQuery.trim().toLowerCase();
    const group = t("knowledgeSlashGroupBasic");
    return SLASH_ITEMS.map((item) => ({ ...item, label: t(item.labelKey), group })).filter(
      (item) =>
        query === "" ||
        item.label.toLowerCase().includes(query) ||
        item.kind.toLowerCase().includes(query),
    );
  }, [slashQuery, t]);

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
    (kind: TurnIntoKind | "divider"): void => {
      const el = ref.current;
      let prefix = "";
      if (el) {
        const text = el.textContent ?? "";
        const at = text.lastIndexOf("/");
        prefix = at >= 0 ? text.slice(0, at) : text;
        if (prefix === "") el.innerHTML = "";
        else el.textContent = prefix;
        dirty.current = prefix !== "";
      }
      setSlashOpen(false);
      setSlashQuery("");
      if (prefix !== "") flushSave();
      if (kind === "divider") {
        void editor.addBelow(block.id, "divider");
        return;
      }
      if (kind === "paragraph") return;
      void editor.turnInto(block, kind);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [block, editor],
  );

  const onSelectionChange = (): void => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement !== el) {
      setFloatBar(null);
      return;
    }
    const selection = selectionInside(el);
    if (selection) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width > 0) setFloatBar({ x: rect.left + rect.width / 2, y: rect.top - 10 });
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

  const exec = (command: string, value?: string): void => {
    document.execCommand(command, false, value);
    dirty.current = true;
    scheduleSave();
  };

  // 代码编辑面板同时只开一个:点面板外或 Esc 就收起。
  useEffect(() => {
    if (!codeEditing) return;
    const onDown = (event: MouseEvent): void => {
      const wrap = codeWrapRef.current;
      if (wrap && !wrap.contains(event.target as Node)) setCodeEditing(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setCodeEditing(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [codeEditing]);

  if (codeEditing && block.kind === "code") {
    return (
      <div
        ref={codeWrapRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CodePanel block={block} editor={editor} t={t} onDone={() => setCodeEditing(false)} />
      </div>
    );
  }

  if (!editable || isCode) {
    return (
      <div className="nb-row nb-row-plain">
        <div className="nb-row-main">
          {/* 代码块的正文不在富文本编辑路径里,静态展示(带语法高亮);点正文或 ⋯→编辑 打开面板。 */}
          {isCode && block.kind === "code" ? (
            <figure className="nb-code" onClick={() => setCodeEditing(true)}>
              <figcaption>{block.language}</figcaption>
              <pre>
                <code dangerouslySetInnerHTML={{ __html: highlightCode(block.text, block.language) }} />
              </pre>
            </figure>
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
          <BlockMenu block={block} editor={editor} t={t} onClose={() => setMenuOpen(false)} />
        ) : null}
      </div>
    );
  }

  const kindClass = block.kind === "heading" ? `heading-${block.level}` : block.kind;
  return (
    <div className={`nb-row nb-row-${kindClass}`}>
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
          onInput={onInput}
          onBlur={() => {
            setFloatBar(null);
            flushSave();
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            document.execCommand("insertText", false, text);
            dirty.current = true;
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
        <BlockMenu block={block} editor={editor} t={t} onClose={() => setMenuOpen(false)} />
      ) : null}
      {pickerOpen ? (
        <KindPicker
          t={t}
          allowDivider={false}
          onPick={(kind) => {
            setPickerOpen(false);
            void editor.addBelow(block.id, kind);
          }}
          onClose={() => setPickerOpen(false)}
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
        <div
          className="nb-floatbar"
          style={{ left: floatBar.x, top: floatBar.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button type="button" title="Bold (⌘B)" onClick={() => exec("bold")}>
            <strong>B</strong>
          </button>
          <button type="button" title="Italic (⌘I)" onClick={() => exec("italic")}>
            <em>I</em>
          </button>
          <button type="button" title="Strike" onClick={() => exec("strikeThrough")}>
            <s>S</s>
          </button>
          <button
            type="button"
            title="Code"
            onClick={() => {
              const text = window.getSelection()?.toString() ?? "";
              exec("insertHTML", `<code>${escapeHtml(text)}</code>`);
            }}
          >
            {"</>"}
          </button>
          <button
            type="button"
            title="Link"
            onClick={() => {
              const url = window.prompt("URL");
              if (url) exec("createLink", url);
            }}
          >
            🔗
          </button>
        </div>
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
  void block;
  void editor;
  return (
    <>
      <button
        type="button"
        className="nb-handle"
        aria-label={t("knowledgeBlockMenu")}
        onClick={() => {
          setPickerOpen(false);
          setMenuOpen(!menuOpen);
        }}
      >
        ⋮⋮
      </button>
      <button
        type="button"
        className="nb-add-below"
        aria-label={t("knowledgeAddBelow")}
        onClick={() => {
          setMenuOpen(false);
          setPickerOpen(!pickerOpen);
        }}
      >
        ＋
      </button>
    </>
  );
}

function BlockMenu({
  block,
  editor,
  t,
  onClose,
}: {
  block: NotionBlockModel;
  editor: BlockEditorCallbacks;
  t: Translate;
  onClose: () => void;
}): ReactNode {
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);
  const [codeEditing, setCodeEditing] = useState(false);
  const [confirmChildren, setConfirmChildren] = useState(false);
  const movable = canMoveBlock(block);
  const run = (action: () => Promise<void>): void => {
    onClose();
    void action().catch(() => undefined);
  };
  if (codeEditing && block.kind === "code") {
    return <CodePanel block={block} editor={editor} t={t} onDone={onClose} />;
  }
  return (
    <>
      <div className="nb-scrim" onClick={onClose} role="presentation" />
      <div className="nb-menu" role="menu">
        {block.kind === "code" ? (
          <button type="button" role="menuitem" onClick={() => setCodeEditing(true)}>
            ✎ {t("knowledgeEdit")}
          </button>
        ) : null}
        {block.kind === "todo" ? (
          <button type="button" role="menuitem" onClick={() => run(() => editor.toggleTodo(block))}>
            ☑ {block.checked ? t("knowledgeUncheck") : t("knowledgeCheck")}
          </button>
        ) : null}
        {isEditableBlock(block) && block.kind !== "code" ? (
          <button type="button" role="menuitem" onClick={() => setTurnIntoOpen((value) => !value)}>
            ⇄ {t("knowledgeTurnInto")}
          </button>
        ) : null}
        {turnIntoOpen ? (
          <div className="nb-menu-sub">
            {BLOCK_KINDS.filter((entry) => entry.kind !== "divider").map((entry) => (
              <button
                key={entry.kind}
                type="button"
                role="menuitem"
                onClick={() => run(() => editor.turnInto(block, entry.kind as TurnIntoKind))}
              >
                {t(entry.labelKey as MessageKey)}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          role="menuitem"
          disabled={!movable || editor.busy}
          onClick={() => run(() => editor.duplicate(block.id))}
        >
          ⧉ {t("knowledgeDuplicate")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!movable || editor.busy}
          onClick={() => run(() => editor.move(block.id, "up"))}
        >
          ↑ {t("knowledgeMoveUp")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!movable || editor.busy}
          onClick={() => run(() => editor.move(block.id, "down"))}
        >
          ↓ {t("knowledgeMoveDown")}
        </button>
        <button
          type="button"
          role="menuitem"
          className="is-danger"
          disabled={editor.busy}
          onClick={() => {
            if (block.children.length > 0) {
              setConfirmChildren(true);
            } else {
              run(() => editor.remove(block.id));
            }
          }}
        >
          🗑 {t("knowledgeDelete")}
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
          run(() => editor.remove(block.id));
        }}
      />
    </>
  );
}

/** 代码块编辑面板(代码不参与富文本编辑)。 */
function CodePanel({
  block,
  editor,
  t,
  onDone,
}: {
  block: NotionBlockModel;
  editor: BlockEditorCallbacks;
  t: Translate;
  onDone: () => void;
}) {
  const [value, setValue] = useState(block.kind === "code" ? block.text : "");
  const [language, setLanguage] = useState(block.kind === "code" ? block.language || "plain text" : "");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const save = (): void => {
    if (editor.busy) return;
    if (value.trim() === "") {
      void editor.remove(block.id).then(onDone).catch(onDone);
      return;
    }
    void editor
      .saveCode(block.id, value, language)
      .then(onDone)
      .catch(() => undefined);
  };
  return (
    <div className="nb-edit">
      <div className="nb-edit-toolbar">
        <select
          className="nb-edit-language"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        >
          {["plain text", "bash", "shell", "typescript", "javascript", "python", "rust", "go", "sql", "json", "yaml", "markdown", "html", "css", "c", "c++", "java", "powershell", "diff", "docker"].map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </select>
        <span className="nb-edit-hint">{t("knowledgeEditHint")}</span>
      </div>
      <textarea
        ref={ref}
        className="nb-edit-area"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          }
        }}
        rows={Math.min(14, Math.max(2, value.split("\n").length))}
      />
      <div className="nb-edit-actions">
        <button type="button" className="nb-btn primary" disabled={editor.busy} onClick={save}>
          {editor.busy ? t("knowledgeSaving") : t("knowledgeSave")}
        </button>
        <button type="button" className="nb-btn" disabled={editor.busy} onClick={onDone}>
          {t("knowledgeCancel")}
        </button>
      </div>
    </div>
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
