import { useEffect, useRef, useState, type ReactNode } from "react";

import type { NotionBlockModel } from "@you-brain/core/http/types.js";

import type { MessageKey } from "../../i18n/messages.js";
import {
  BLOCK_KINDS,
  blockMarkdown,
  canMoveBlock,
  isEditableBlock,
  type TurnIntoKind,
} from "./logic.js";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface BlockEditorCallbacks {
  update(blockId: string, markdown: string, kind?: TurnIntoKind, checked?: boolean): Promise<void>;
  remove(blockId: string): Promise<void>;
  move(blockId: string, direction: "up" | "down"): Promise<void>;
  duplicate(blockId: string): Promise<void>;
  toggleTodo(block: NotionBlockModel): Promise<void>;
  addBelow(afterBlockId: string | null, kind: TurnIntoKind | "divider"): Promise<void>;
  busy: boolean;
}

/** 悬停时显示的块操作手柄 + 菜单 + 「在下方添加块」。 */
export function EditableRow({
  block,
  editor,
  t,
  initialEditing = false,
  children,
}: {
  block: NotionBlockModel;
  editor: BlockEditorCallbacks;
  t: Translate;
  initialEditing?: boolean | undefined;
  children: ReactNode;
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState(initialEditing);

  // 新建的块通过 initialEditing 置真进入编辑态。
  useEffect(() => {
    if (initialEditing) setEditing(true);
  }, [initialEditing]);

  const editable = isEditableBlock(block);

  if (editing) {
    return (
      <EditPanel
        block={block}
        editor={editor}
        t={t}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="nb-row">
      <div className="nb-row-content">{children}</div>
      {editable ? (
        <>
          <button
            type="button"
            className="nb-handle"
            aria-label={t("knowledgeEdit")}
            onClick={() => {
              setPickerOpen(false);
              setMenuOpen((value) => !value);
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
              setPickerOpen((value) => !value);
            }}
          >
            ＋
          </button>
          {menuOpen ? (
            <BlockMenu
              block={block}
              editor={editor}
              t={t}
              onClose={() => setMenuOpen(false)}
              onEdit={() => {
                setMenuOpen(false);
                setEditing(true);
              }}
            />
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
        </>
      ) : null}
    </div>
  );
}

function EditPanel({
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
  const initial = blockMarkdown(block);
  const [value, setValue] = useState(initial);
  const [language, setLanguage] = useState(block.kind === "code" ? block.language || "plain text" : "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = editor.busy;

  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(value.length, value.length);
    // 初始 focus 只跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wrap = (token: string, tokenEnd = token): void => {
    const area = ref.current;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const selected = value.slice(start, end) || "";
    const next = `${value.slice(0, start)}${token}${selected}${tokenEnd}${value.slice(end)}`;
    setValue(next);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(start + token.length, end + token.length);
    });
  };

  const save = (): void => {
    if (busy) return;
    if (value.trim() === "" && block.kind !== "code") {
      // Notion 的习惯:清空文本 = 删除块。
      void editor.remove(block.id).then(onDone).catch(onDone);
      return;
    }
    const payload = block.kind === "code" ? value : value;
    void editor.update(block.id, payload).then(onDone).catch(() => undefined);
  };

  return (
    <div className="nb-edit">
      <div className="nb-edit-toolbar">
        {block.kind === "code" ? (
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
        ) : (
          <>
            <button type="button" onClick={() => wrap("**")} title="Bold (⌘B)"><strong>B</strong></button>
            <button type="button" onClick={() => wrap("*")} title="Italic (⌘I)"><em>I</em></button>
            <button type="button" onClick={() => wrap("~~")} title="Strike"><s>S</s></button>
            <button type="button" onClick={() => wrap("`")} title="Code">{"</>"}</button>
            <button
              type="button"
              title="Link"
              onClick={() => {
                const url = window.prompt("URL");
                if (url) wrap("[", `](${url})`);
              }}
            >
              🔗
            </button>
          </>
        )}
        <span className="nb-edit-hint">{t("knowledgeEditHint")}</span>
      </div>
      <textarea
        ref={ref}
        className="nb-edit-area"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          const mod = event.metaKey || event.ctrlKey;
          if (event.key === "Enter" && mod) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          } else if (mod && (event.key === "b" || event.key === "i")) {
            event.preventDefault();
            wrap(event.key === "b" ? "**" : "*");
          }
        }}
        rows={Math.min(14, Math.max(1, value.split("\n").length))}
      />
      <div className="nb-edit-actions">
        <button type="button" className="nb-btn primary" disabled={busy} onClick={save}>
          {busy ? t("knowledgeSaving") : t("knowledgeSave")}
        </button>
        <button type="button" className="nb-btn" disabled={busy} onClick={onDone}>
          {t("knowledgeCancel")}
        </button>
      </div>
    </div>
  );
}

function BlockMenu({
  block,
  editor,
  t,
  onClose,
  onEdit,
}: {
  block: NotionBlockModel;
  editor: BlockEditorCallbacks;
  t: Translate;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);
  const movable = canMoveBlock(block);
  const run = (action: () => Promise<void>): void => {
    onClose();
    void action().catch(() => undefined);
  };
  return (
    <>
      <div className="nb-scrim" onClick={onClose} role="presentation" />
      <div className="nb-menu" role="menu">
        <button type="button" role="menuitem" onClick={onEdit}>
          ✎ {t("knowledgeEdit")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => setTurnIntoOpen((value) => !value)}
        >
          ⇄ {t("knowledgeTurnInto")}
        </button>
        {turnIntoOpen ? (
          <div className="nb-menu-sub">
            {BLOCK_KINDS.filter((entry) => entry.kind !== "divider").map((entry) => (
              <button
                key={entry.kind}
                type="button"
                role="menuitem"
                onClick={() => run(() => editor.update(block.id, blockMarkdown(block), entry.kind as TurnIntoKind))}
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
    (entry) => (allowDivider || entry.kind !== "divider") &&
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
