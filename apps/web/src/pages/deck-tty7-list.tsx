import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { DeckTty7SessionsResponse } from "@you-brain/core/http/types.js";

import { Button, IconButton } from "../components/button.js";
import { Icon } from "../components/icons.js";
import { InlineRename, type InlineRenameHandle } from "../components/inline-rename.js";
import { Toggle } from "../components/toggle.js";
import { useDaemon } from "../daemon-context.js";
import { prefs } from "../lib/prefs.js";
import { baseName, sessionTitle, type Session } from "./deck-tty7-sessions.js";

const HARNESS_KEY = "you-brain.deck.tty7-harness";
const ACTIVE_ONLY_KEY = "you-brain.deck.tty7-active-only";
/** 展开的组（白名单）：默认全部收起，用户展开过的才展开。 */
const EXPANDED_KEY = "you-brain.deck.tty7-expanded";
const COLORS_KEY = "you-brain.deck.tty7-group-colors";

/** 组色板：中饱和、亮暗主题都可读，按 hue 取样。 */
const GROUP_PALETTE = ["#e5534b", "#de7d38", "#daaa3f", "#4cb782", "#39c5cf", "#539bf5", "#b083f0", "#ee5bc0"];

export const STATUS_LABEL = {
  working: "deckTty7StatusWorking",
  waiting: "deckTty7StatusWaiting",
  done: "deckTty7StatusDone",
  idle: "deckTty7StatusIdle",
} as const;

/** 等你回复的排最前，其次是刚干完的；其余保持 tty7 的 tab 顺序。 */
const STATUS_RANK: Record<string, number> = { waiting: 0, done: 1 };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readStored(key: string): string | null {
  try {
    return prefs.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    prefs.setItem(key, value);
  } catch {
    // 存不了就不记，不影响使用。
  }
}

function readStoredSet(key: string): Set<string> {
  try {
    const raw = prefs.getItem(key);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/** 项目（cwd 目录名）→ 用户给该组选的颜色；标签条和会话列表共用。 */
export function readGroupColors(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(prefs.getItem(COLORS_KEY) ?? "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, color] of Object.entries(parsed)) {
      if (typeof color === "string") out[name] = color;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 会话列表：按项目分组，组可收起、可选色，支持筛选和「只看活跃」。
 * 右侧面板和整屏终端的下拉共用；compact 用于下拉（不带删除，更紧凑）。
 */
export function DeckTty7SessionList({ sessions, filter, onFilterChange, onOpen, onRename, onRenameError, onDelete, onStart, compact = false, activePane = null, busy = false }: {
  sessions: readonly Session[];
  filter: string;
  onFilterChange: (value: string) => void;
  onOpen: (pane: number) => void;
  /** 改名（点行上的铅笔按钮进入编辑）；不传则不显示铅笔。 */
  onRename?: (pane: number, name: string) => Promise<void>;
  onRenameError?: (error: unknown) => void;
  onDelete?: (session: Session) => void;
  /** 在某个项目下新建会话（传项目名）；不传项目名表示不限项目。 */
  onStart?: (projectLabel: string) => void;
  compact?: boolean;
  /** 当前显示的会话，用于高亮。 */
  activePane?: number | null;
  busy?: boolean;
}) {
  const { t } = useDaemon();
  const [activeOnly, setActiveOnly] = useState(() => readStored(ACTIVE_ONLY_KEY) !== "0");
  /** 展开的组：默认全收起，记录用户展开过的。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => readStoredSet(EXPANDED_KEY));
  const [groupColors, setGroupColors] = useState<Record<string, string>>(() => readGroupColors());
  /** 正在挑颜色的组名。 */
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  /** 各行的改名句柄：铅笔按钮用它让该行进入编辑，不触发打开。 */
  const renamers = useRef(new Map<number, InlineRenameHandle>());

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const ordered = sessions
      .map((session, index) => ({ session, index }))
      .sort((a, b) => (STATUS_RANK[a.session.status ?? ""] ?? 2) - (STATUS_RANK[b.session.status ?? ""] ?? 2) || a.index - b.index)
      .map((item) => item.session);
    // 默认只看活跃的：有 agent 状态上报、或当前没在 tty7 里休眠的会话。
    const active = activeOnly
      ? ordered.filter((session) => session.status !== null || !session.hibernated)
      : ordered;
    if (needle === "") return active;
    return active.filter((session) =>
      [session.tabLabel ?? "", session.agent ?? "", session.status ?? "", session.cwd, `%${session.pane}`].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    );
  }, [sessions, filter, activeOnly]);
  /** 按项目（cwd 目录名）分组；组内等待回复的在前。 */
  const groups = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of visible) {
      const label = session.cwd === "" ? t("deckTty7GroupOther") : baseName(session.cwd);
      const list = map.get(label);
      if (list === undefined) map.set(label, [session]);
      else list.push(session);
    }
    const rank = (items: Session[]): number => Math.min(...items.map((item) => STATUS_RANK[item.status ?? ""] ?? 2));
    return [...map.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0]));
  }, [visible, t]);
  // 项目运行状态不受搜索条件影响，收起分组后也保留提示。
  const workingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (session.status !== "working" || session.hibernated) continue;
      const label = session.cwd === "" ? t("deckTty7GroupOther") : baseName(session.cwd);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  }, [sessions, t]);

  const toggleGroup = (label: string): void => {
    setColorPickerFor(null);
    setExpanded((before) => {
      const next = new Set(before);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      writeStored(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const setGroupColor = (label: string, color: string | undefined): void => {
    setGroupColors((before) => {
      const next = { ...before };
      if (color === undefined) delete next[label];
      else next[label] = color;
      writeStored(COLORS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const row = (session: Session) => {
    const title = sessionTitle(session);
    const open = (): void => onOpen(session.pane);
    return (
      <li key={session.pane} className="deck-tty7-item">
        {/* 用 div 而不是 button：行内要放改名输入框，button 里不能放输入框。 */}
        <div
          role="button"
          tabIndex={0}
          className={[
            "deck-tty7-row",
            session.pane === activePane ? "is-selected" : "",
            session.status === "working" && !session.hibernated ? "is-working" : "",
          ].filter(Boolean).join(" ")}
          onClick={open}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          }}
        >
          <span className="deck-tty7-row-title">
            <span className="deck-tty7-row-name">
              {onRename === undefined ? title : (
                <InlineRename
                  value={title}
                  label={t("deckTerminalRename", { name: title })}
                  controlRef={(handle) => {
                    if (handle === null) renamers.current.delete(session.pane);
                    else renamers.current.set(session.pane, handle);
                  }}
                  onSubmit={(next) => onRename(session.pane, next)}
                  {...(onRenameError === undefined ? {} : { onError: onRenameError })}
                />
              )}
            </span>
            {session.status !== null && (
              <span className={`deck-tty7-status is-${session.status}`} title={session.statusMessage ?? undefined}>
                {t(STATUS_LABEL[session.status])}
              </span>
            )}
            {session.agent !== null && <span className="chip">{session.agent}</span>}
          </span>
          <span className="deck-tty7-row-cwd">{session.cwd}</span>
        </div>
        {onRename !== undefined && (
          <IconButton
            className="deck-tty7-rename"
            label={t("deckTty7RenameSession", { name: title, pane: session.pane })}
            onClick={() => renamers.current.get(session.pane)?.startEditing()}
          >
            <Icon name="pencil" />
          </IconButton>
        )}
        {onDelete !== undefined && (
          <IconButton
            className="deck-tty7-delete"
            label={t("deckTty7DeleteSession", { name: title, pane: session.pane })}
            disabled={busy}
            onClick={() => onDelete(session)}
          >
            <Icon name="trash" />
          </IconButton>
        )}
      </li>
    );
  };

  return (
    <div className={compact ? "deck-tty7-listbox is-compact" : "deck-tty7-listbox"}>
      <input
        className="field-control deck-tty7-filter"
        value={filter}
        onChange={(event) => onFilterChange(event.target.value)}
        placeholder={t("deckTty7Filter")}
        spellCheck={false}
      />
      <div className="deck-tty7-active">
        <Toggle
          checked={activeOnly}
          label={t("deckTty7ActiveOnly")}
          onChange={(value) => {
            setActiveOnly(value);
            writeStored(ACTIVE_ONLY_KEY, value ? "1" : "0");
          }}
        />
        <span>{t("deckTty7ActiveOnly")}</span>
      </div>
      <ul className="deck-tty7-list">
        {groups.map(([label, items]) => {
          // 搜索时强制展开，免得目标会话被收起的组挡住。
          const isOpen = expanded.has(label) || filter.trim() !== "";
          const color = groupColors[label];
          const workingCount = workingCounts.get(label) ?? 0;
          const workingHint = workingCount > 0 ? t("deckTty7GroupWorking", { count: workingCount }) : undefined;
          return (
            <Fragment key={label}>
              <li className="deck-tty7-group-head">
                <button
                  type="button"
                  className={["deck-tty7-group", color === undefined ? "" : "with-color", workingCount > 0 ? "is-working" : ""].filter(Boolean).join(" ")}
                  style={color === undefined ? undefined : ({ "--group-color": color } as CSSProperties)}
                  aria-expanded={isOpen}
                  aria-label={workingHint === undefined ? undefined : `${label} · ${items.length} · ${workingHint}`}
                  title={workingHint}
                  onClick={() => toggleGroup(label)}
                >
                  <span
                    className="deck-tty7-group-dot"
                    role="button"
                    aria-label={t("deckTty7PickColor")}
                    title={t("deckTty7PickColor")}
                    onClick={(event) => {
                      // 色点只管颜色，不触发展开/收起。
                      event.stopPropagation();
                      setColorPickerFor(colorPickerFor === label ? null : label);
                    }}
                  />
                  <span className="deck-tty7-group-arrow" aria-hidden>
                    {isOpen ? "▾" : "▸"}
                  </span>
                  <span className="deck-tty7-group-name">{label}</span>
                  <span className="deck-tty7-group-count">{items.length}</span>
                </button>
                {onStart !== undefined && items.some((session) => session.cwd !== "") && (
                  <IconButton
                    className="deck-tty7-group-new"
                    label={t("deckTty7NewInProject", { name: label })}
                    disabled={busy}
                    onClick={() => onStart(label)}
                  >
                    <Icon name="plus" />
                  </IconButton>
                )}
              </li>
              {colorPickerFor === label && (
                <li className="deck-tty7-colors">
                  {GROUP_PALETTE.map((swatch) => (
                    <button
                      key={swatch}
                      type="button"
                      className={swatch === color ? "deck-tty7-swatch is-active" : "deck-tty7-swatch"}
                      style={{ background: swatch }}
                      aria-label={swatch}
                      onClick={() => setGroupColor(label, swatch)}
                    />
                  ))}
                  <button
                    type="button"
                    className="deck-tty7-swatch is-clear"
                    aria-label={t("deckTty7ClearColor")}
                    title={t("deckTty7ClearColor")}
                    onClick={() => setGroupColor(label, undefined)}
                  >
                    ✕
                  </button>
                </li>
              )}
              {isOpen && items.map(row)}
            </Fragment>
          );
        })}
        {visible.length === 0 && <li className="deck-tty7-empty">{t("deckTty7Empty")}</li>}
      </ul>
    </div>
  );
}

/**
 * 新建会话的表单：面板和下拉共用。projectLabel 不为空时只在该项目的目录里选。
 * 成功后重新加载会话列表，再把新会话的 pane 交给 onStarted。
 */
export function DeckTty7NewForm({ view, sessions, projectLabel, reload, onStarted }: {
  view: DeckTty7SessionsResponse;
  sessions: readonly Session[];
  projectLabel: string | null;
  reload: () => Promise<DeckTty7SessionsResponse | null>;
  onStarted: (pane: number) => void;
}) {
  const { client, t } = useDaemon();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [harness, setHarness] = useState(() => readStored(HARNESS_KEY) ?? "claude");
  // 用完整会话列表定位项目目录，搜索不能替同名项目选定目标路径。
  const dirs = useMemo(() => projectLabel === null ? [] : [...new Set(sessions
    .filter((session) => session.cwd !== "" && baseName(session.cwd) === projectLabel)
    .map((session) => session.cwd.replace(/\/+$/u, "") || "/"))].sort(), [sessions, projectLabel]);
  const workspaceOf = (dir: string): string => {
    const ids = new Set(sessions
      .filter((session) => session.cwd !== "" && (session.cwd.replace(/\/+$/u, "") || "/") === dir)
      .map((session) => session.workspaceId));
    return ids.size === 1 ? [...ids][0]! : "";
  };
  const [cwd, setCwd] = useState(() => dirs.length === 1 ? dirs[0]! : "");
  const [workspace, setWorkspace] = useState(() => dirs.length === 1 ? workspaceOf(dirs[0]!) : "");
  const knownDirs = useMemo(
    () => [...new Set(sessions.map((session) => session.cwd).filter((dir) => dir !== ""))].sort(),
    [sessions],
  );
  const chooseCwd = async (): Promise<void> => {
    const open = window.__TAURI__?.dialog?.open;
    if (!open) return;
    try {
      const picked = await open({ directory: true, multiple: false, title: t("deckTty7ChooseProjectPath") });
      const dir = typeof picked === "string" ? picked : Array.isArray(picked) ? picked[0] : null;
      if (dir) {
        setCwd(dir);
        setWorkspace(workspaceOf(dir));
      }
    } catch {
      // 用户取消或对话框打不开:保持输入框原样。
    }
  };

  useEffect(() => {
    const form = formRef.current;
    form?.scrollIntoView({ block: "nearest" });
    const field = dirs.length === 1 ? "harness" : "cwd";
    (form?.elements.namedItem(field) as HTMLElement | null)?.focus();
  }, [dirs.length]);

  const start = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || cwd.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const created = await client.deckTty7Start({
        cwd: cwd.trim(),
        harness,
        ...(workspace === "" ? {} : { workspace }),
      });
      writeStored(HARNESS_KEY, harness);
      await reload();
      onStarted(created.pane);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} className="deck-tty7-new" onSubmit={(event) => void start(event)}>
      {projectLabel !== null && <strong>{t("deckTty7NewInProject", { name: projectLabel })}</strong>}
      <div className="field">
        <span className="field-label">{t("deckTty7Path")}</span>
        {projectLabel !== null && dirs.length > 1 ? (
          <select
            name="cwd"
            className="field-control"
            value={cwd}
            onChange={(event) => {
              setCwd(event.target.value);
              setWorkspace(workspaceOf(event.target.value));
            }}
          >
            <option value="">{t("deckTty7ChooseProjectPath")}</option>
            {dirs.map((dir) => <option key={dir} value={dir}>{dir}</option>)}
          </select>
        ) : <div className="field-row">
          <input
            name="cwd"
            className="field-control"
            list="deck-tty7-dirs"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="/Users/…/project"
            spellCheck={false}
          />
          <Button variant="secondary" size="sm" onClick={() => void chooseCwd()}>
            {t("deckTty7Browse")}
          </Button>
        </div>}
        <datalist id="deck-tty7-dirs">
          {knownDirs.map((dir) => (
            <option key={dir} value={dir} />
          ))}
        </datalist>
      </div>
      <label className="field">
        <span className="field-label">{t("deckTty7Harness")}</span>
        <select name="harness" className="field-control" value={harness} onChange={(event) => setHarness(event.target.value)}>
          {view.harnesses.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {view.workspaces.length > 1 && (
        <label className="field">
          <span className="field-label">{t("deckTty7Workspace")}</span>
          <select className="field-control" value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
            <option value="">{t("deckTty7WorkspaceAuto")}</option>
            {view.workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className="btn primary" disabled={busy || cwd.trim() === ""}>
        {t("deckTty7Start")}
      </button>
      {error !== null && <p className="deck-tty7-error">{error}</p>}
    </form>
  );
}
