import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import type { DeckTty7SessionsResponse } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { ConfirmDialog, Dialog } from "../components/dialog.js";
import { Icon } from "../components/icons.js";
import { IconButton } from "../components/button.js";
import { useToast } from "../components/toast.js";
import { Toggle } from "../components/toggle.js";
import type { TerminalReference } from "../lib/terminal-reference.js";
import { DeckTty7Terminal } from "./deck-tty7-terminal.js";

type Session = DeckTty7SessionsResponse["sessions"][number];

const SESSIONS_POLL_MS = 5_000;
const HARNESS_KEY = "you-brain.deck.tty7-harness";
const ACTIVE_ONLY_KEY = "you-brain.deck.tty7-active-only";
/** 展开的组（白名单）：默认全部收起，用户展开过的才展开。 */
const EXPANDED_KEY = "you-brain.deck.tty7-expanded";
const COLORS_KEY = "you-brain.deck.tty7-group-colors";

/** 组色板：中饱和、亮暗主题都可读，按 hue 取样。 */
const GROUP_PALETTE = ["#e5534b", "#de7d38", "#daaa3f", "#4cb782", "#39c5cf", "#539bf5", "#b083f0", "#ee5bc0"];

const STATUS_LABEL = {
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

function baseName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不了就不记，不影响使用。
  }
}

function readStoredSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function readStoredColors(key: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
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

/** 指挥台右侧的 tty7 会话面板：列会话、打开真实终端、在某个目录新开会话。 */
export function DeckTty7Panel({ onClose, openRequest, onOpenRequestHandled }: {
  onClose: () => void;
  openRequest?: TerminalReference | null;
  onOpenRequestHandled?: (request: TerminalReference) => void;
}) {
  const { client, t } = useDaemon();
  const { push } = useToast();
  const [view, setView] = useState<DeckTty7SessionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const selectedSessionRef = useRef<HTMLButtonElement>(null);
  const loadSequence = useRef(0);
  const pendingOpen = useRef<TerminalReference | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creationProject, setCreationProject] = useState<{ label: string; dirs: string[] } | null>(null);
  const newFormRef = useRef<HTMLFormElement>(null);
  const [cwd, setCwd] = useState("");
  const [harness, setHarness] = useState(() => readStored(HARNESS_KEY) ?? "claude");
  const [workspace, setWorkspace] = useState("");
  const [activeOnly, setActiveOnly] = useState(() => readStored(ACTIVE_ONLY_KEY) !== "0");
  /** 展开的组：默认全收起，记录用户展开过的。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => readStoredSet(EXPANDED_KEY));
  const [groupColors, setGroupColors] = useState<Record<string, string>>(() => readStoredColors(COLORS_KEY));
  /** 正在挑颜色的组名。 */
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const loadSessions = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const next = await client.deckTty7Sessions();
      if (sequence !== loadSequence.current) return;
      setView(next);
      setLoadError(null);
      const request = pendingOpen.current;
      if (request !== null) {
        pendingOpen.current = null;
        const target = next.sessions.find((session) => session.pane === request.pane &&
          session.workspaceId === request.workspaceId && session.tabId === request.tabId);
        setSelected(target?.pane ?? null);
        setActionError(target ? null : t("deckTty7ReferenceMissing"));
        onOpenRequestHandled?.(request);
      }
    } catch (error) {
      if (sequence === loadSequence.current) setLoadError(message(error));
    }
  }, [client, t, onOpenRequestHandled]);

  useEffect(() => {
    if (!openRequest) return;
    pendingOpen.current = openRequest;
    void loadSessions();
  }, [openRequest, loadSessions]);

  useEffect(() => {
    void loadSessions();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadSessions();
    }, SESSIONS_POLL_MS);
    return () => clearInterval(timer);
  }, [loadSessions]);

  const sessions = view?.sessions ?? [];
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
  const current = selected === null ? undefined : sessions.find((session) => session.pane === selected);
  // 不受侧栏搜索、活跃筛选影响；完整路径避免把不同位置的同名项目混在一起。
  const projectSessions = useMemo(() => {
    if (current === undefined || current.cwd === "") return [];
    const projectDir = current.cwd.replace(/\/+$/u, "") || "/";
    return sessions.filter((session) => session.cwd !== "" && (session.cwd.replace(/\/+$/u, "") || "/") === projectDir);
  }, [sessions, current]);
  useEffect(() => {
    selectedSessionRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, projectSessions.length]);
  const knownDirs = useMemo(
    () => [...new Set(sessions.map((session) => session.cwd).filter((dir) => dir !== ""))].sort(),
    [sessions],
  );

  useEffect(() => {
    if (!creating) return;
    const form = newFormRef.current;
    form?.scrollIntoView({ block: "nearest" });
    const field = creationProject?.dirs.length === 1 ? "harness" : "cwd";
    (form?.elements.namedItem(field) as HTMLElement | null)?.focus();
  }, [creating, creationProject]);

  const projectWorkspace = (dir: string): string => {
    const ids = new Set(sessions
      .filter((session) => session.cwd !== "" && (session.cwd.replace(/\/+$/u, "") || "/") === dir)
      .map((session) => session.workspaceId));
    return ids.size === 1 ? [...ids][0]! : "";
  };

  const createInProject = (label: string): void => {
    // 用完整会话列表定位目录，搜索不能替同名项目选定目标路径。
    const dirs = [...new Set(sessions
      .filter((session) => session.cwd !== "" && baseName(session.cwd) === label)
      .map((session) => session.cwd.replace(/\/+$/u, "") || "/"))].sort();
    if (dirs.length === 0) return;
    const dir = dirs.length === 1 ? dirs[0]! : "";
    setCreationProject({ label, dirs });
    setCwd(dir);
    setWorkspace(projectWorkspace(dir));
    setActionError(null);
    setColorPickerFor(null);
    setCreating(true);
  };

  const start = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || cwd.trim() === "") return;
    setBusy(true);
    setActionError(null);
    try {
      const created = await client.deckTty7Start({
        cwd: cwd.trim(),
        harness,
        ...(workspace === "" ? {} : { workspace }),
      });
      writeStored(HARNESS_KEY, harness);
      setCreating(false);
      setFilter("");
      await loadSessions();
      setSelected(created.pane);
    } catch (error) {
      setActionError(message(error));
    } finally {
      setBusy(false);
    }
  };

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

  const title = (session: Session): string =>
    session.tabLabel ?? (session.cwd === "" ? `%${session.pane}` : baseName(session.cwd));

  const deleteSession = async (): Promise<void> => {
    if (busy || pendingDelete === null) return;
    const pane = pendingDelete.pane;
    setBusy(true);
    try {
      await client.deckTty7Delete(pane);
      // 已发出的旧轮询不能把删除成功的会话重新放回列表。
      ++loadSequence.current;
      setView((before) => before === null ? null : { ...before, sessions: before.sessions.filter((session) => session.pane !== pane) });
      setSelected((before) => before === pane ? null : before);
      setPendingDelete(null);
      await loadSessions();
    } catch (error) {
      push({ message: t("deckTty7DeleteFailed", { detail: message(error) }), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const row = (session: Session) => (
    <li key={session.pane} className="deck-tty7-item">
      <button
        type="button"
        className={session.pane === selected ? "deck-tty7-row is-selected" : "deck-tty7-row"}
        onClick={() => {
          setSelected(session.pane);
          setActionError(null);
        }}
      >
        <span className="deck-tty7-row-title">
          <span className="deck-tty7-row-name">{title(session)}</span>
          {session.status !== null && (
            <span className={`deck-tty7-status is-${session.status}`} title={session.statusMessage ?? undefined}>
              {t(STATUS_LABEL[session.status])}
            </span>
          )}
          {session.agent !== null && <span className="chip">{session.agent}</span>}
          <span className="deck-tty7-pane">%{session.pane}</span>
        </span>
        <span className="deck-tty7-row-cwd">{session.cwd}</span>
      </button>
      <IconButton
        className="deck-tty7-delete"
        label={t("deckTty7DeleteSession", { name: title(session), pane: session.pane })}
        disabled={busy}
        onClick={() => setPendingDelete(session)}
      >
        <Icon name="trash" />
      </IconButton>
    </li>
  );

  return (
    <aside className="deck-tty7" aria-label={t("deckTty7Title")}>
      <header className="deck-tty7-head">
        <strong>{t("deckTty7Title")}</strong>
        <span className="deck-tty7-count">{view?.available === true ? sessions.length : ""}</span>
        <button type="button" className="btn small quiet" disabled={busy} onClick={() => {
          if (creating) {
            setCreating(false);
            return;
          }
          setCreationProject(null);
          setCwd("");
          setWorkspace("");
          setActionError(null);
          setCreating(true);
        }}>
          {creating ? t("deckTty7Cancel") : t("deckTty7New")}
        </button>
        <button type="button" className="btn small quiet" onClick={onClose} aria-label={t("deckTty7Hide")}>
          ✕
        </button>
      </header>

      {loadError !== null && <p className="deck-tty7-error">{loadError}</p>}
      {view !== null && !view.available && (
        <p className="deck-tty7-error">{t("deckTty7Unavailable", { detail: view.detail })}</p>
      )}

      {creating && view?.available === true && (
        <form ref={newFormRef} className="deck-tty7-new" onSubmit={(event) => void start(event)}>
          {creationProject !== null && <strong>{t("deckTty7NewInProject", { name: creationProject.label })}</strong>}
          <label className="field">
            <span className="field-label">{t("deckTty7Path")}</span>
            {creationProject !== null && creationProject.dirs.length > 1 ? (
              <select
                name="cwd"
                className="field-control"
                value={cwd}
                onChange={(event) => {
                  setCwd(event.target.value);
                  setWorkspace(projectWorkspace(event.target.value));
                }}
              >
                <option value="">{t("deckTty7ChooseProjectPath")}</option>
                {creationProject.dirs.map((dir) => <option key={dir} value={dir}>{dir}</option>)}
              </select>
            ) : <input
              name="cwd"
              className="field-control"
              list="deck-tty7-dirs"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder="/Users/…/project"
              spellCheck={false}
            />}
            <datalist id="deck-tty7-dirs">
              {knownDirs.map((dir) => (
                <option key={dir} value={dir} />
              ))}
            </datalist>
          </label>
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
        </form>
      )}

      {view?.available === true && (
        <>
          <input
            className="field-control deck-tty7-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
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
                    {items.some((session) => session.cwd !== "") && (
                      <IconButton
                        className="deck-tty7-group-new"
                        label={t("deckTty7NewInProject", { name: label })}
                        disabled={busy}
                        onClick={() => createInProject(label)}
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
        </>
      )}

      {current !== undefined && (
        <Dialog
          open
          onClose={() => setSelected(null)}
          title={title(current)}
          size="full"
          className="deck-tty7-full"
          // Esc 是终端的键（退出、清提示），直通模式下不拿来关弹框；关闭走按钮或点弹框外。
          closeOnEscape={false}
        >
          {projectSessions.length > 1 && (
            <nav className="deck-tty7-switcher" aria-label={t("deckTty7SwitchSession")}>
              <span className="deck-tty7-switcher-label">
                {t("deckTty7ProjectSessions", { count: projectSessions.length })}
              </span>
              <div className="deck-tty7-switcher-list">
                {projectSessions.map((session) => (
                  <button
                    key={session.pane}
                    ref={session.pane === selected ? selectedSessionRef : undefined}
                    type="button"
                    className={session.pane === selected ? "deck-tty7-switch is-selected" : "deck-tty7-switch"}
                    aria-pressed={session.pane === selected}
                    title={`${title(session)} · %${session.pane}`}
                    onClick={() => {
                      setSelected(session.pane);
                      setActionError(null);
                    }}
                  >
                    <span className="deck-tty7-pane">%{session.pane}</span>
                    <span className="deck-tty7-row-name">{title(session)}</span>
                    {session.status !== null && (
                      <span className={`deck-tty7-status is-${session.status}`} title={session.statusMessage ?? undefined}>
                        {t(STATUS_LABEL[session.status])}
                      </span>
                    )}
                    {session.agent !== null && <span className="chip">{session.agent}</span>}
                  </button>
                ))}
              </div>
            </nav>
          )}
          <div className="deck-tty7-meta">
            {current.status !== null && (
              <span className={`deck-tty7-status is-${current.status}`} title={current.statusMessage ?? undefined}>
                {t(STATUS_LABEL[current.status])}
              </span>
            )}
            {current.model !== null && <span className="deck-tty7-pane">{current.model}</span>}
            <span className="deck-tty7-pane">%{current.pane}</span>
            <button type="button" className="btn small quiet" onClick={() => setSelected(null)}>
              {t("deckTty7Close")}
            </button>
          </div>
          {current.status === "waiting" && current.statusMessage !== null && (
            <p className="deck-tty7-waiting">{current.statusMessage}</p>
          )}
          <DeckTty7Terminal key={current.pane} pane={current.pane} />
        </Dialog>
      )}
      {actionError !== null && <p className="deck-tty7-error">{actionError}</p>}
      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title={t("deckTty7Delete")}
        description={pendingDelete === null ? "" : t("deckTty7DeleteConfirm", { name: title(pendingDelete), pane: pendingDelete.pane })}
        confirmLabel={t("deckTty7Delete")}
        cancelLabel={t("deckTty7Cancel")}
        loading={busy}
        onClose={() => { if (!busy) setPendingDelete(null); }}
        onConfirm={() => void deleteSession()}
      />
    </aside>
  );
}
