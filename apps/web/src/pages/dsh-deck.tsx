import { prefs } from "../lib/prefs.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, IconButton } from "../components/button.js";
import { Icon } from "../components/icons.js";
import { Page } from "../components/page.js";
import { Segmented } from "../components/segmented.js";
import { Spinner } from "../components/spinner.js";
import { useToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import { parseDeckPane } from "../lib/route.js";
import { isTextEntry, modLabel, shortcutMod } from "../lib/shortcuts.js";
import { usePageActive } from "../page-active.js";
import { useRoute } from "../router.js";
import { createDshCookiePreparer } from "../lib/dsh-cookies.js";
import { terminalReferenceMessage, type TerminalReference } from "../lib/terminal-reference.js";
import { isReferenceShortcut } from "./deck-reference-logic.js";
import { DeckReferencePicker } from "./deck-reference-picker.js";
import { DeckTerminalScreen } from "./deck-terminal-screen.js";
import { EMPTY_TABS, hideScreen, openTab, pruneTabs, type TerminalTabs } from "./deck-terminal-tabs.js";
import { DeckTty7Panel } from "./deck-tty7.js";
import { initialDeckView, useTty7Sessions, waitingCount, type DeckViewId } from "./deck-tty7-sessions.js";
import { DeckT3Panel } from "./deck-t3.js";
import { DeckMusePanel } from "./deck-muse.js";

type DshWebView =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "ready"; url: string }
  | { state: "error"; error: string };

const POLL_MS = 1_000;
const TTY7_OPEN_KEY = "you-brain.deck.tty7-open";
const DECK_VIEW_KEY = "you-brain.deck.view";
const DECK_VIEWS = [
  { value: "t3", label: "T3" },
  { value: "dsh", label: "DSH" },
  { value: "muse", label: "Muse" },
];

/**
 * 指挥台：左边切换 T3 / DSH / Muse，右边共用可收起的 tty7 会话面板（ADR-0004）。
 */
export function DshDeckPage() {
  const { client, t } = useDaemon();
  const { href, navigate } = useRoute();
  const { push } = useToast();
  const pageActive = usePageActive();
  const [activePage, setActivePage] = useState<DeckViewId>(() => {
    try { return initialDeckView(prefs.getItem(DECK_VIEW_KEY)); } catch { return initialDeckView(null); }
  });
  const sessions = useTty7Sessions();
  const waiting = waitingCount(sessions.view?.sessions ?? []);
  // 整屏终端的标签只在本次运行内有效，不写偏好。
  const [tabs, setTabs] = useState<TerminalTabs>(EMPTY_TABS);
  const openPane = useCallback((pane: number) => setTabs((current) => openTab(current, pane)), []);
  const requestedPane = parseDeckPane(href);
  const reloadSessions = sessions.reload;
  useEffect(() => {
    if (requestedPane === null || !pageActive) return;
    navigate("/deck", "replace");
    void reloadSessions().then((fresh) => {
      if (fresh === null) return;
      if (!fresh.available || !fresh.sessions.some((item) => item.pane === requestedPane)) {
        push({ message: t("deckTty7ReferenceMissing"), tone: "danger" });
        return;
      }
      openPane(requestedPane);
    });
  }, [requestedPane, pageActive, navigate, reloadSessions, openPane, push, t]);
  const [t3Visited, setT3Visited] = useState(activePage === "t3");
  const [t3SettingsOpen, setT3SettingsOpen] = useState(false);
  const [t3ReloadVersion, setT3ReloadVersion] = useState(0);
  const [t3RefPickerOpen, setT3RefPickerOpen] = useState(false);
  const t3Frame = useRef<HTMLIFrameElement>(null);
  const mod = shortcutMod(typeof navigator === "undefined" ? "" : navigator.platform);
  const [museVisited, setMuseVisited] = useState(activePage === "muse");
  const [museSettingsOpen, setMuseSettingsOpen] = useState(false);
  const [museReconnectVersion, setMuseReconnectVersion] = useState(0);
  const [view, setView] = useState<DshWebView>({ state: "starting" });
  const [attempt, setAttempt] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  // 每次拿到新的会话列表，就去掉 tty7 里已经不存在的会话标签。
  // 列表不可用（tty7 没起、读取失败）时不动标签，免得一次故障把标签全清掉。
  const sessionView = sessions.view;
  useEffect(() => {
    if (sessionView === null || !sessionView.available) return;
    const live = new Set(sessionView.sessions.map((session) => session.pane));
    setTabs((current) => pruneTabs(current, live));
  }, [sessionView]);
  const [terminalRequest, setTerminalRequest] = useState<TerminalReference | null>(null);
  const terminalRequestHandled = useCallback((request: TerminalReference) => {
    setTerminalRequest((current) => current === request ? null : current);
  }, []);
  const prepareCookies = useMemo(() => createDshCookiePreparer(
    typeof window === "undefined" ? undefined : window.__TAURI__?.core?.invoke,
  ), []);
  const [tty7Open, setTty7Open] = useState(() => {
    try {
      return prefs.getItem(TTY7_OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });

  const load = useCallback(async (retry: boolean): Promise<DshWebView> => {
    try {
      const next = (await client.deckDsh(retry)) as DshWebView;
      if (next.state === "ready") await prepareCookies(next.url);
      return next;
    } catch (error) {
      return { state: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }, [client, prepareCookies]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 第一次请求带 retry（点了重试，或进入页面时清掉上次的错误）；之后的轮询不带。
    const tick = async (retry: boolean): Promise<void> => {
      const next = await load(retry);
      if (cancelled) return;
      setView(next);
      // 启动中继续轮询；ready / error 即停（重试按钮会重新触发 effect）。
      if (next.state === "starting" || next.state === "stopped") timer = setTimeout(() => void tick(false), POLL_MS);
    };
    void tick(true);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, attempt]);

  // 就绪后每 3 秒确认一次：DSH 崩溃被自动拉起、或设置页里订阅登录成功后被 daemon 重启，
  // 都会换新的端口和令牌，旧地址的 iframe 会失效，要跟着换。
  const readyUrl = view.state === "ready" ? view.url : null;
  useEffect(() => {
    if (readyUrl === null) return;
    const receive = (event: MessageEvent): void => {
      const message = terminalReferenceMessage(event, frame.current?.contentWindow, readyUrl);
      if (message === null) return;
      if (message.type === "ready") {
        frame.current?.contentWindow?.postMessage({ type: "u-brain:terminal-reference:host" }, new URL(readyUrl).origin);
      } else {
        setTty7Open(true);
        setTerminalRequest(message);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [readyUrl]);

  // 切到别的菜单（常驻但隐藏）时不确认；切回时立即确认一次，地址变了就换。
  useEffect(() => {
    if (readyUrl === null || !pageActive) return undefined;
    const check = (): void => {
      void load(false).then((next) => {
        if (next.state === "ready" && next.url === readyUrl) return;
        setView(next);
        if (next.state === "starting") setAttempt((value) => value + 1);
      });
    };
    check();
    const timer = setInterval(check, 3_000);
    return () => clearInterval(timer);
  }, [readyUrl, load, pageActive]);

  useEffect(() => {
    if (!pageActive || activePage !== "t3" || tabs.active !== null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || t3SettingsOpen || t3RefPickerOpen || isTextEntry(event.target)) return;
      if (
        !isReferenceShortcut(
          { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey },
          mod,
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setT3RefPickerOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageActive, activePage, tabs.active, mod, t3SettingsOpen, t3RefPickerOpen]);

  const toggleTty7 = (open: boolean): void => {
    setTty7Open(open);
    try {
      prefs.setItem(TTY7_OPEN_KEY, open ? "1" : "0");
    } catch {
      // 存不了就不记。
    }
  };

  const switchPage = (next: string): void => {
    if (next !== "dsh" && next !== "t3" && next !== "muse") return;
    setActivePage(next);
    if (next === "t3") setT3Visited(true);
    if (next === "muse") setMuseVisited(true);
    try { prefs.setItem(DECK_VIEW_KEY, next); } catch { /* 本次切换仍可用。 */ }
  };

  let main;
  if (view.state === "ready") {
    main = (
      <iframe
        ref={frame}
        className="dsh-frame"
        src={view.url}
        title={t("dshDeckFrameTitle")}
        allow="clipboard-read; clipboard-write"
      />
    );
  } else if (view.state === "error") {
    main = (
      <div className="dsh-deck-state">
        <p className="dsh-deck-error">{t("dshDeckError", { message: view.error })}</p>
        <button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>
          {t("dshDeckRetry")}
        </button>
      </div>
    );
  } else {
    main = (
      <div className="dsh-deck-state">
        <Spinner />
        <p>{t("dshDeckStarting")}</p>
        <p className="dsh-deck-hint">{t("dshDeckStartingHint")}</p>
      </div>
    );
  }

  // 三个页面保留挂载，切换只隐藏；tty7 面板独立于页面和连接状态。
  return (
    <Page>
      <div className="dsh-deck">
        <div className="dsh-deck-main">
          <div className="dsh-deck-toolbar">
            <Segmented label={t("dshDeckPageSwitch")} value={activePage} options={DECK_VIEWS} onChange={switchPage} labelledBy="radiogroup" />
            <div className="dsh-deck-actions">
              {activePage === "t3" ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    title={t("deckRefButtonTitle", { shortcut: `${modLabel(mod)}⇧2` })}
                    onClick={() => setT3RefPickerOpen(true)}
                  >
                    {t("deckRefButton")}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Icon name="settings" />} onClick={() => setT3SettingsOpen(true)}>{t("dshDeckT3Settings")}</Button>
                  <IconButton label={t("dshDeckT3Refresh")} onClick={() => setT3ReloadVersion((value) => value + 1)}><Icon name="refresh" /></IconButton>
                </>
              ) : activePage === "muse" ? (
                <>
                  <Button size="sm" variant="ghost" icon={<Icon name="settings" />} onClick={() => setMuseSettingsOpen(true)}>{t("deckMuseSettings")}</Button>
                  <IconButton label={t("deckMuseReconnect")} onClick={() => setMuseReconnectVersion((value) => value + 1)}><Icon name="refresh" /></IconButton>
                </>
              ) : null}
              <IconButton
                className="deck-tty7-toggle"
                label={!tty7Open && waiting > 0 ? `${t("deckTty7Show")} · ${t("deckTty7WaitingBadge", { count: waiting })}` : t("deckTty7Show")}
                aria-pressed={tty7Open}
                onClick={() => toggleTty7(!tty7Open)}
              >
                <Icon name="terminal" />
                {!tty7Open && waiting > 0 ? (
                  <span className="deck-tty7-badge" aria-hidden="true">{waiting > 9 ? "9+" : waiting}</span>
                ) : null}
              </IconButton>
            </div>
          </div>
          <div className="dsh-deck-view" role="region" aria-label={t("dshDeckFrameTitle")} hidden={activePage !== "dsh"}>{main}</div>
          <div className="dsh-deck-view" role="region" aria-label={t("dshDeckT3FrameTitle")} hidden={activePage !== "t3"}>
            {t3Visited ? (
              <DeckT3Panel
                frameRef={t3Frame}
                reloadVersion={t3ReloadVersion}
                settingsOpen={t3SettingsOpen}
                onSettingsChange={setT3SettingsOpen}
                onReload={() => setT3ReloadVersion((value) => value + 1)}
              />
            ) : null}
          </div>
          <div className="dsh-deck-view" role="region" aria-label={t("deckMuseFrameTitle")} hidden={activePage !== "muse"}>
            {museVisited ? (
              <DeckMusePanel
                active={activePage === "muse"}
                reconnectVersion={museReconnectVersion}
                settingsOpen={museSettingsOpen}
                onSettingsChange={setMuseSettingsOpen}
              />
            ) : null}
          </div>
        </div>
        {tty7Open ? (
          <DeckTty7Panel sessions={sessions} onClose={() => toggleTty7(false)} onOpen={openPane} activePane={tabs.active} openRequest={terminalRequest} onOpenRequestHandled={terminalRequestHandled} />
        ) : null}
      </div>
      {tabs.open.length > 0 ? (
        <DeckTerminalScreen
          tabs={tabs}
          sessions={sessions}
          shown={tabs.active !== null}
          onTabsChange={setTabs}
          onClose={() => setTabs(hideScreen)}
        />
      ) : null}
      <DeckReferencePicker
        open={t3RefPickerOpen}
        mode="t3"
        onClose={() => setT3RefPickerOpen(false)}
        onCopied={() => {
          requestAnimationFrame(() => t3Frame.current?.focus());
        }}
        onOpenTerminal={openPane}
      />
    </Page>
  );
}
