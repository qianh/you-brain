import { useEffect, useMemo, useRef, useState } from "react";

import { IconButton } from "../components/button.js";
import { Icon } from "../components/icons.js";
import { InlineRename } from "../components/inline-rename.js";
import { Popover } from "../components/popover.js";
import { useDaemon } from "../daemon-context.js";
import { modLabel, shortcutMod } from "../lib/shortcuts.js";
import { DeckTty7NewForm, DeckTty7SessionList, readGroupColors } from "./deck-tty7-list.js";
import { baseName, sessionTitle, useSessionRename, type Session, type useTty7Sessions } from "./deck-tty7-sessions.js";
import { DeckTty7Terminal } from "./deck-tty7-terminal.js";
import { closeTab, cycleTab, hideScreen, openTab, terminalShortcut, type TerminalTabs } from "./deck-terminal-tabs.js";

/**
 * 整屏终端：盖住整个窗口，顶部一行是返回、本次打开过的会话标签、全部会话下拉。
 * 关标签和返回都只改变显示，不会结束 tty7 里的会话。
 */
export function DeckTerminalScreen({ tabs, sessions: shared, onTabsChange, onClose }: {
  tabs: TerminalTabs;
  /** 指挥台共享的会话数据。 */
  sessions: ReturnType<typeof useTty7Sessions>;
  onTabsChange: (next: TerminalTabs) => void;
  /** 返回：收起整屏终端，标签保留。 */
  onClose: () => void;
}) {
  const { t } = useDaemon();
  const { view, reload } = shared;
  const { rename, reportError } = useSessionRename(reload);
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  /** 下拉里的新建表单：null 为收起；label 为 null 表示不限项目。 */
  const [creating, setCreating] = useState<{ label: string | null } | null>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  // 与 shell.tsx 的 overlayTitlebar 同一个判断：macOS 桌面壳里窗口灯压在左上角。
  const overlayTitlebar = typeof window !== "undefined" && window.__TAURI__ !== undefined && /Mac/.test(navigator.platform);
  const mod = shortcutMod(typeof navigator === "undefined" ? "" : navigator.platform);

  const sessions = view?.sessions ?? [];
  const byPane = useMemo(() => new Map(sessions.map((session) => [session.pane, session])), [sessions]);
  const colors = readGroupColors();

  const closeMenu = (): void => {
    setMenuOpen(false);
    setCreating(null);
  };

  // 在捕获阶段处理，只认 terminalShortcut 里的三个组合；其余按键（含 Esc）原样交给 xterm。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const action = terminalShortcut(
        { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey },
        mod,
      );
      if (action === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "back") onTabsChange(hideScreen(tabs));
      else onTabsChange(cycleTab(tabs, action === "next" ? 1 : -1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mod, tabs, onTabsChange]);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tabs.active]);

  const tabLabel = (session: Session | undefined, pane: number): string =>
    session === undefined ? `%${pane}` : sessionTitle(session);

  const tabView = (pane: number) => {
    const session = byPane.get(pane);
    const name = tabLabel(session, pane);
    const active = pane === tabs.active;
    const color = session === undefined || session.cwd === "" ? undefined : colors[baseName(session.cwd)];
    const waitingNote = session?.status === "waiting" && session.statusMessage !== null ? session.statusMessage : null;
    return (
      <div
        key={pane}
        ref={active ? activeTabRef : undefined}
        role="tab"
        tabIndex={0}
        aria-selected={active}
        className={active ? "deck-term-tab is-active" : "deck-term-tab"}
        title={waitingNote === null ? name : `${name} · ${waitingNote}`}
        onClick={() => onTabsChange(openTab(tabs, pane))}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onTabsChange(openTab(tabs, pane));
          }
        }}
      >
        <span
          className="deck-term-tab-bar"
          style={color === undefined ? undefined : { background: color }}
          aria-hidden
        />
        {session?.status != null && <span className={`deck-term-dot is-${session.status}`} aria-hidden />}
        <InlineRename
          value={name}
          label={t("deckTerminalRename", { name })}
          onSubmit={(next) => rename(pane, next)}
          onError={reportError}
        />
        <button
          type="button"
          className="deck-term-tab-close"
          aria-label={t("deckTerminalCloseTab", { name })}
          title={t("deckTerminalCloseTab", { name })}
          onClick={(event) => {
            event.stopPropagation();
            onTabsChange(closeTab(tabs, pane));
          }}
        >
          <Icon name="x" />
        </button>
      </div>
    );
  };

  const menu = (
    <div className="deck-term-menu">
      {view === null ? null : !view.available ? (
        <p className="deck-tty7-error">{t("deckTty7Unavailable", { detail: view.detail })}</p>
      ) : creating !== null ? (
        <>
          <button type="button" className="btn small quiet deck-term-menu-back" onClick={() => setCreating(null)}>
            {t("deckTty7Cancel")}
          </button>
          <DeckTty7NewForm
            key={creating.label ?? ""}
            view={view}
            sessions={sessions}
            projectLabel={creating.label}
            reload={reload}
            onStarted={(pane) => {
              closeMenu();
              setFilter("");
              onTabsChange(openTab(tabs, pane));
            }}
          />
        </>
      ) : (
        <>
          <button type="button" className="btn small quiet deck-term-menu-new" onClick={() => setCreating({ label: null })}>
            <Icon name="plus" /> {t("deckTty7New")}
          </button>
          <DeckTty7SessionList
            compact
            sessions={sessions}
            filter={filter}
            onFilterChange={setFilter}
            onOpen={(pane) => {
              closeMenu();
              onTabsChange(openTab(tabs, pane));
            }}
            onRename={rename}
            onRenameError={reportError}
            onStart={(label) => setCreating({ label })}
            activePane={tabs.active}
          />
        </>
      )}
    </div>
  );

  return (
    <div className="deck-term-screen" role="region" aria-label={t("deckTerminalScreen")}>
      <div className="deck-term-bar" {...(overlayTitlebar ? { "data-tauri-drag-region": "" } : {})}>
        <button
          type="button"
          className="deck-term-back"
          title={`${t("deckTerminalBack")} (${modLabel(mod)}⇧D)`}
          onClick={onClose}
        >
          <Icon name="chevron-left" />
          <span>{t("deckTerminalBack")}</span>
        </button>
        <div
          className="deck-term-tabs"
          role="tablist"
          aria-label={t("deckTerminalTabs")}
          {...(overlayTitlebar ? { "data-tauri-drag-region": "" } : {})}
        >
          {tabs.open.map(tabView)}
        </div>
        <Popover
          open={menuOpen}
          onClose={closeMenu}
          label={t("deckTerminalAllSessions")}
          className="deck-term-popover"
          trigger={
            <IconButton
              label={t("deckTerminalAllSessions")}
              aria-expanded={menuOpen}
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            >
              <Icon name="chevron-down" />
            </IconButton>
          }
        >
          {menu}
        </Popover>
        {/* 字号控件的位置，下一步在这里放进去。 */}
        <div className="deck-term-font-slot" data-slot="font-size" />
      </div>
      <div className="deck-term-body">
        {tabs.active !== null && <DeckTty7Terminal key={tabs.active} pane={tabs.active} />}
      </div>
    </div>
  );
}
