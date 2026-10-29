import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { NotionBlockModel, NotionSegment } from "@you-brain/core/http/types.js";

import type { MessageKey } from "../../i18n/messages.js";
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

export interface FocusRequest {
  blockId: string;
  at: "start" | "end" | number;
}

export interface BlockEditorCallbacks {
  /** 保存块文本(segments 为空 = 清空并删块)。 */
  saveSegments(block: NotionBlockModel, segments: NotionSegment[]): Promise<void>;
  saveCode(blockId: string, text: string): Promise<void>;
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
  const [floatBar, setFloatBar] = useState<{ x: number; y: number } | null>(null);
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
    if (el && (el.textContent ?? "") === "/") setSlashOpen(true);
  };

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

  if (!editable || isCode) {
    return (
      <div className="nb-row nb-row-plain">
        <div className="nb-row-main">{children}</div>
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
        <KindPicker
          t={t}
          allowDivider={false}
          onPick={(kind) => {
            setSlashOpen(false);
            const el = ref.current;
            if (el) {
              el.innerHTML = "";
              dirty.current = false;
            }
            if (kind !== "divider") void editor.turnInto(block, kind);
          }}
          onClose={() => setSlashOpen(false)}
        />
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
            const hasChildren = block.children.length > 0;
            if (!hasChildren || window.confirm(t("knowledgeDeleteConfirm"))) {
              run(() => editor.remove(block.id));
            } else {
              onClose();
            }
          }}
        >
          🗑 {t("knowledgeDelete")}
        </button>
      </div>
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
      .saveCode(block.id, value)
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
          {["plain text", "typescript", "javascript", "python", "rust", "go", "sql", "json", "bash", "markdown"].map((lang) => (
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
