import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { IconButton } from "../components/button.js";
import { Icon } from "../components/icons.js";
import { InlineRename } from "../components/inline-rename.js";
import { Popover } from "../components/popover.js";
import { useDaemon } from "../daemon-context.js";
import { usePageActive } from "../page-active.js";
import { loadChunk } from "../lib/load-chunk.js";
import { prefs } from "../lib/prefs.js";
import { modLabel, shortcutMod } from "../lib/shortcuts.js";
import { DeckReferencePicker } from "./deck-reference-picker.js";
import { FONT_MAX, FONT_MIN, FONT_SIZE_KEY, resolveAppearance, stepFontSize } from "./deck-terminal-font.js";
import { DeckTty7NewForm, DeckTty7SessionList, readGroupColors } from "./deck-tty7-list.js";
import { baseName, sessionTitle, useSessionRename, type Session, type useTty7Sessions } from "./deck-tty7-sessions.js";
import { closeTab, cycleTab, hideScreen, openTab, terminalShortcut, type TerminalTabs } from "./deck-terminal-tabs.js";
import { VIEWING_REPORT_MS, viewingTarget } from "./deck-terminal-viewing.js";

// xterm（约 470 KB）只在第一次打开整屏终端时加载。
const DeckTty7Terminal = lazy(() => loadChunk(() => import("./deck-tty7-terminal.js")).then((m) => ({ default: m.DeckTty7Terminal })));

/**
 * 整屏终端：盖住整个窗口，顶部一行是返回、本次打开过的会话标签、全部会话下拉。
 * 关标签和返回都只改变显示，不会结束 tty7 里的会话。
 */
export function DeckTerminalScreen({ tabs, sessions: shared, onTabsChange, onClose, shown }: {
  tabs: TerminalTabs;
  /** 指挥台共享的会话数据。 */
  sessions: ReturnType<typeof useTty7Sessions>;
  onTabsChange: (next: TerminalTabs) => void;
  /** 返回：收起整屏终端，标签保留。 */
  onClose: () => void;
  /** false 时整屏隐藏但已打开的标签保持挂载，切回时不再重连。 */
  shown: boolean;
}) {
  const { t, client } = useDaemon();
  const pageActive = usePageActive();
  const { view, reload } = shared;
  const { rename, reportError } = useSessionRename(reload);
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  /** 下拉里的新建表单：null 为收起；label 为 null 表示不限项目。 */
  const [creating, setCreating] = useState<{ label: string | null } | null>(null);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const pasteSeqRef = useRef(0);
  const [pendingPaste, setPendingPaste] = useState<{ pane: number; seq: number; text: string } | null>(null);
  const handlePasteHandled = useCallback((seq: number) => {
    setPendingPaste((current) => (current?.seq === seq ? null : current));
  }, []);
  const activeTabRef = useRef<HTMLDivElement>(null);
  // 用户调过的字号；null 表示没调过，跟随 tty7。偏好只在改动时写，不在这里反复读。
  const [storedSize, setStoredSize] = useState<string | null>(() => prefs.getItem(FONT_SIZE_KEY));
  // 与 shell.tsx 的 overlayTitlebar 同一个判断：macOS 桌面壳里窗口灯压在左上角。
  const overlayTitlebar = typeof window !== "undefined" && window.__TAURI__ !== undefined && /Mac/.test(navigator.platform);
  const mod = shortcutMod(typeof navigator === "undefined" ? "" : navigator.platform);

  const sessions = view?.sessions ?? [];
  const byPane = useMemo(() => new Map(sessions.map((session) => [session.pane, session])), [sessions]);
  const colors = readGroupColors();
  const tty7Appearance = view?.appearance ?? null;
  const appearance = useMemo(
    () => resolveAppearance(storedSize, tty7Appearance),
    [storedSize, tty7Appearance?.fontFamily, tty7Appearance?.fontSize, tty7Appearance?.lineHeight],
  );
  const fontSize = appearance.fontSize;

  const setFontSize = (size: number): void => {
    prefs.setItem(FONT_SIZE_KEY, String(size));
    setStoredSize(String(size));
  };
  const resetFontSize = (): void => {
    prefs.removeItem(FONT_SIZE_KEY);
    setStoredSize(null);
  };

  const closeMenu = (): void => {
    setMenuOpen(false);
    setCreating(null);
  };

  // 在捕获阶段处理，只认 terminalShortcut 里的组合；其余按键（含 Esc 与裸 @）原样交给 xterm。
  useEffect(() => {
    if (!shown) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      const action = terminalShortcut(
        { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey },
        mod,
      );
      if (action === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "back") onTabsChange(hideScreen(tabs));
      else if (action === "reference") setRefPickerOpen(true);
      else if (action === "fontUp") setFontSize(stepFontSize(fontSize, 1));
      else if (action === "fontDown") setFontSize(stepFontSize(fontSize, -1));
      else if (action === "fontReset") resetFontSize();
      else onTabsChange(cycleTab(tabs, action === "next" ? 1 : -1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, mod, tabs, onTabsChange, fontSize]);

  // 告诉 daemon 正在看哪个会话，这个会话完成时不弹通知。窗口失焦、页面隐藏、切到别的菜单或离开时报 null。
  // 失败一律静默：上报不能影响终端使用。
  useEffect(() => {
    let last: number | null = null;
    const send = (pane: number | null): void => {
      void client.deckTty7Viewing(pane).catch(() => undefined);
    };
    const sync = (): void => {
      const target = viewingTarget(
        shown && pageActive ? tabs.active : null,
        document.hasFocus(),
        document.visibilityState === "visible",
      );
      if (target !== null) {
        send(target);
        last = target;
      } else if (last !== null) {
        send(null);
        last = null;
      }
    };
    sync();
    const timer = window.setInterval(sync, VIEWING_REPORT_MS);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      if (last !== null) send(null);
    };
  }, [client, tabs.active, shown, pageActive]);

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
        className={[
          "deck-term-tab",
          active ? "is-active" : "",
          session?.status === "working" && !session.hibernated ? "is-working" : "",
        ].filter(Boolean).join(" ")}
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
    <div
      className={["deck-term-screen", shown ? "" : "is-collapsed"].filter(Boolean).join(" ")}
      role="region"
      aria-label={t("deckTerminalScreen")}
      aria-hidden={!shown}
    >
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
        {/* 按下时不抢焦点（preventDefault），点完仍可直接在终端里打字。 */}
        <div className="deck-term-bar-right">
          <button
            type="button"
            className="deck-term-ref-btn"
            title={t("deckRefButtonTitle", { shortcut: `${modLabel(mod)}⇧2` })}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setRefPickerOpen(true)}
          >
            {t("deckRefButton")}
          </button>
          <div className="deck-term-font-slot" role="group" aria-label={t("deckTerminalFontSize")}>
            <button
              type="button"
              className="deck-term-font-btn"
              aria-label={t("deckTerminalFontSmaller")}
              title={`${t("deckTerminalFontSmaller")} (${modLabel(mod)}-)`}
              disabled={fontSize <= FONT_MIN}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setFontSize(stepFontSize(fontSize, -1))}
            >A−</button>
            <button
              type="button"
              className="deck-term-font-btn deck-term-font-size"
              aria-label={t("deckTerminalFontReset", { size: fontSize })}
              title={`${t("deckTerminalFontReset", { size: fontSize })} (${modLabel(mod)}0)`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={resetFontSize}
            >{fontSize}</button>
            <button
              type="button"
              className="deck-term-font-btn"
              aria-label={t("deckTerminalFontLarger")}
              title={`${t("deckTerminalFontLarger")} (${modLabel(mod)}=)`}
              disabled={fontSize >= FONT_MAX}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setFontSize(stepFontSize(fontSize, 1))}
            >A+</button>
          </div>
        </div>
      </div>
      <div className="deck-term-body">
        <Suspense fallback={null}>
          {tabs.open.map((pane) => (
            <DeckTty7Terminal
              key={pane}
              pane={pane}
              appearance={appearance}
              active={shown && pane === tabs.active}
              pendingPaste={pendingPaste?.pane === pane ? pendingPaste : null}
              onPasteHandled={handlePasteHandled}
            />
          ))}
        </Suspense>
      </div>
      <DeckReferencePicker
        open={refPickerOpen}
        mode="terminal"
        onClose={() => setRefPickerOpen(false)}
        onInsert={(mentionText) => {
          if (tabs.active === null) return;
          pasteSeqRef.current += 1;
          setPendingPaste({ pane: tabs.active, seq: pasteSeqRef.current, text: mentionText });
        }}
        onOpenTerminal={(pane) => onTabsChange(openTab(tabs, pane))}
      />
    </div>
  );
}
