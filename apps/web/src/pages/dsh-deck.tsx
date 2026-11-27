import { prefs } from "../lib/prefs.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, IconButton } from "../components/button.js";
import { Icon } from "../components/icons.js";
import { Page } from "../components/page.js";
import { Segmented } from "../components/segmented.js";
import { Spinner } from "../components/spinner.js";
import { useToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import { parseDeckPane, readQuery } from "../lib/route.js";
import { DECK_VIEW_KEY, DECK_VIEWS, isDeckView } from "../lib/deck-view.js";
import { isTextEntry, modLabel, shortcutMod } from "../lib/shortcuts.js";
import { usePageActive } from "../page-active.js";
import { useRoute } from "../router.js";
import { createDshCookiePreparer } from "../lib/dsh-cookies.js";
import { terminalReferenceMessage, type TerminalReference } from "../lib/terminal-reference.js";
import { dshThemeMessage, isDshThemeRequest } from "../lib/dsh-theme.js";
import { t3FrameMessage } from "../lib/t3-frame.js";
import { useTheme } from "../theme-context.js";
import { isReferenceShortcut } from "./deck-reference-logic.js";
import { DeckReferencePicker } from "./deck-reference-picker.js";
import { DeckTerminalScreen, preloadTerminalChunk } from "./deck-terminal-screen.js";
import { EMPTY_TABS, hideScreen, openTab, pruneTabs, type TerminalTabs } from "./deck-terminal-tabs.js";
import { DeckTty7Panel } from "./deck-tty7.js";
import { initialDeckView, useTty7Sessions, waitingCount, type DeckViewId } from "./deck-tty7-sessions.js";
import { DeckT3Panel, type ActiveT3Device } from "./deck-t3.js";
import { DeckMusePanel } from "./deck-muse.js";

type DshWebView =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "ready"; url: string }
  | { state: "error"; error: string };

const POLL_MS = 1_000;
const TTY7_OPEN_KEY = "you-brain.deck.tty7-open";

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
  const [activeT3Device, setActiveT3Device] = useState<ActiveT3Device | null>(null);
  const [knownDevices, setKnownDevices] = useState<ActiveT3Device[]>([]);
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>({});
  const handleDevicesChange = useCallback((devices: ActiveT3Device[]) => {
    setKnownDevices((current) =>
      current.length === devices.length &&
      current.every((item, index) => item.id === devices[index]?.id && item.name === devices[index]?.name)
        ? current
        : devices,
    );
    if (devices.length === 0) return;
    setDeviceNames((current) => {
      let changed = false;
      const next = { ...current };
      for (const device of devices) {
        if (next[device.id] !== device.name) {
          next[device.id] = device.name;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);
  const handleActiveDeviceChange = useCallback((device: ActiveT3Device | null) => {
    setActiveT3Device((current) =>
      current?.id === device?.id && current?.name === device?.name ? current : device,
    );
    if (device !== null) {
      setDeviceNames((current) => (current[device.id] === device.name ? current : { ...current, [device.id]: device.name }));
    }
  }, []);
  const knownDeviceIds = useMemo(() => knownDevices.map((device) => device.id), [knownDevices]);
  const [t3ForceLocalVersion, setT3ForceLocalVersion] = useState(0);
  // 只有停留在 T3 且选了同账号远端设备时，右侧终端会话才切到该设备；切回 DSH/Muse 或本机/手动地址端点时回到本机。
  const activeTty7Device = activePage === "t3" ? activeT3Device : null;
  const activeDeviceKey = activeTty7Device?.id ?? "local";
  const sessions = useTty7Sessions(activeTty7Device?.id ?? null, knownDeviceIds);
  const waiting = waitingCount(sessions.view?.sessions ?? []);
  // 空闲时提前加载 xterm 代码块，第一次点开终端时无需再等异步拉包。
  useEffect(() => {
    if (!pageActive) return;
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.requestIdleCallback === "function") {
      const id = win.requestIdleCallback(() => preloadTerminalChunk(), { timeout: 1_500 });
      return () => win.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(() => preloadTerminalChunk(), 500);
    return () => window.clearTimeout(timer);
  }, [pageActive]);
  // 整屏终端的标签按设备隔离且保持挂载，切换设备时不断开已打开的终端 WebSocket 与租约。
  const [tabsByDevice, setTabsByDevice] = useState<Record<string, TerminalTabs>>({});
  const tabs = tabsByDevice[activeDeviceKey] ?? EMPTY_TABS;
  const setTabsForDevice = useCallback((deviceKey: string, next: TerminalTabs | ((current: TerminalTabs) => TerminalTabs)) => {
    setTabsByDevice((all) => {
      const current = all[deviceKey] ?? EMPTY_TABS;
      const resolved = typeof next === "function" ? next(current) : next;
      return resolved === current ? all : { ...all, [deviceKey]: resolved };
    });
  }, []);
  const setTabs = useCallback(
    (next: TerminalTabs | ((current: TerminalTabs) => TerminalTabs)) => setTabsForDevice(activeDeviceKey, next),
    [activeDeviceKey, setTabsForDevice],
  );
  const openPane = useCallback((pane: number) => setTabs((current) => openTab(current, pane)), [setTabs]);
  const openLocalPane = useCallback((pane: number) => {
    if (activeTty7Device !== null) {
      setActiveT3Device(null);
      setT3ForceLocalVersion((value) => value + 1);
    }
    setTabsByDevice((all) => ({ ...all, local: openTab(all.local ?? EMPTY_TABS, pane) }));
  }, [activeTty7Device]);
  const requestedPane = parseDeckPane(href);
  const reloadSessions = sessions.reload;
  useEffect(() => {
    if (requestedPane === null || !pageActive) return;
    navigate("/deck", "replace");
    const switchingToLocal = activeTty7Device !== null;
    if (switchingToLocal) {
      setActiveT3Device(null);
      setT3ForceLocalVersion((value) => value + 1);
    }
    const fetchLocal = switchingToLocal
      ? client.deckTty7Sessions(null).catch(() => null)
      : reloadSessions();
    void fetchLocal.then((fresh) => {
      if (fresh === null) return;
      if (!fresh.available || !fresh.sessions.some((item) => item.pane === requestedPane)) {
        push({ message: t("deckTty7ReferenceMissing"), tone: "danger" });
        return;
      }
      setTabsByDevice((all) => ({ ...all, local: openTab(all.local ?? EMPTY_TABS, requestedPane) }));
    });
  }, [requestedPane, pageActive, activeTty7Device, client, navigate, reloadSessions, push, t]);
  const [t3Visited, setT3Visited] = useState(activePage === "t3");
  const [t3Thread, setT3Thread] = useState<{ deviceId: string | null; url: string; seq: number } | null>(null);
  const requestedT3Thread = readQuery(href, "t3Thread");
  const requestedT3Device = readQuery(href, "device");
  useEffect(() => {
    if (!requestedT3Thread || !pageActive) return;
    setT3Thread((prev) => ({
      deviceId: requestedT3Device && requestedT3Device !== "local" ? requestedT3Device : null,
      url: requestedT3Thread,
      seq: (prev?.seq ?? 0) + 1,
    }));
    setT3Visited(true);
    setActivePage("t3");
    navigate("/deck", "replace");
  }, [requestedT3Thread, requestedT3Device, pageActive, navigate]);
  // 其他页面左侧快捷栏点进来时带着 ?view=，切到对应页面后把地址换回 /deck。
  const requestedView = readQuery(href, "view");
  useEffect(() => {
    if (requestedView === null || !pageActive) return;
    if (isDeckView(requestedView)) {
      setActivePage(requestedView);
      if (requestedView === "t3") setT3Visited(true);
      if (requestedView === "muse") setMuseVisited(true);
      try { prefs.setItem(DECK_VIEW_KEY, requestedView); } catch { /* 本次切换仍可用。 */ }
    }
    navigate("/deck", "replace");
  }, [requestedView, pageActive, navigate]);
  const [t3SettingsOpen, setT3SettingsOpen] = useState(false);
  const [t3ReloadVersion, setT3ReloadVersion] = useState(0);
  const [t3RefPickerOpen, setT3RefPickerOpen] = useState(false);
  const t3Frame = useRef<HTMLIFrameElement>(null);
  /** T3 经 daemon 转发加载、注入脚本已就绪：选中的引用直接填进 T3 输入框，否则只能复制到剪贴板。 */
  const [t3Injected, setT3Injected] = useState(false);
  /** 选择器是不是在 T3 输入框里敲 % 打开的；是的话没选就关掉时把 % 还给 T3。 */
  const t3RefFromAt = useRef(false);
  const t3RefInserted = useRef(false);
  const postToT3 = useCallback((message: unknown): void => {
    const target = t3Frame.current;
    if (!target?.contentWindow) return;
    try {
      target.contentWindow.postMessage(message, new URL(target.src).origin);
    } catch {
      // iframe 还没有地址。
    }
  }, []);
  const openT3Picker = useCallback((fromAt: boolean): void => {
    t3RefFromAt.current = fromAt;
    t3RefInserted.current = false;
    setT3RefPickerOpen(true);
  }, []);
  const closeT3Picker = (): void => {
    setT3RefPickerOpen(false);
    const giveBackAt = t3RefFromAt.current && !t3RefInserted.current;
    t3RefFromAt.current = false;
    requestAnimationFrame(() => {
      t3Frame.current?.focus();
      // 敲 % 打开却没选（Esc、取消、再敲一个 %）：把 % 原样还给 T3。
      if (giveBackAt) postToT3({ type: "u-brain:t3-ref:passthrough" });
    });
  };
  const mod = shortcutMod(typeof navigator === "undefined" ? "" : navigator.platform);
  const [museVisited, setMuseVisited] = useState(activePage === "muse");
  const [museSettingsOpen, setMuseSettingsOpen] = useState(false);
  const [museReconnectVersion, setMuseReconnectVersion] = useState(0);
  const [view, setView] = useState<DshWebView>({ state: "starting" });
  const [attempt, setAttempt] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  // DSH 跨源读不到宿主主题，由 u-brain-brand 插件来要，宿主切主题时也主动推一次。
  const { resolved: theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  // 每次拿到新的会话列表，就去掉 tty7 里已经不存在的会话标签。
  // 列表不可用（tty7 没起、读取失败）时不动标签，免得一次故障把标签全清掉。
  const sessionView = sessions.view;
  const sessionDeviceKey = sessions.deviceKey;
  useEffect(() => {
    if (sessionView === null || !sessionView.available) return;
    const live = new Set(sessionView.sessions.map((session) => session.pane));
    setTabsByDevice((all) => {
      const current = all[sessionDeviceKey];
      if (current === undefined) return all;
      const next = pruneTabs(current, live);
      return next === current ? all : { ...all, [sessionDeviceKey]: next };
    });
  }, [sessionView, sessionDeviceKey]);
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
      if (isDshThemeRequest(event, frame.current?.contentWindow, readyUrl)) {
        frame.current?.contentWindow?.postMessage(dshThemeMessage(themeRef.current), new URL(readyUrl).origin);
        return;
      }
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

  useEffect(() => {
    if (readyUrl === null) return;
    frame.current?.contentWindow?.postMessage(dshThemeMessage(theme), new URL(readyUrl).origin);
  }, [readyUrl, theme]);

  // T3 注入脚本（经 daemon 转发加载时才有）：要主题、报告就绪、在输入框里敲 % 时请求打开引用选择器。
  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      const message = t3FrameMessage(event, t3Frame.current);
      if (message === "theme-request") postToT3(dshThemeMessage(themeRef.current));
      else if (message === "ready") setT3Injected(true);
      else if (message === "open") openT3Picker(true);
      else if (message === "shortcut") openT3Picker(false);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [postToT3, openT3Picker]);

  useEffect(() => {
    postToT3(dshThemeMessage(theme));
  }, [theme, postToT3]);

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
      openT3Picker(false);
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
            <Segmented label={t("dshDeckPageSwitch")} value={activePage} options={[...DECK_VIEWS]} onChange={switchPage} labelledBy="radiogroup" />
            <div className="dsh-deck-actions">
              {activePage === "t3" ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    title={t("deckRefButtonTitle", { shortcut: `${modLabel(mod)}⇧2` })}
                    onClick={() => openT3Picker(false)}
                  >
                    {t("deckRefButton")}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Icon name="settings" />} onClick={() => setT3SettingsOpen(true)}>{t("dshDeckT3Settings")}</Button>
                  <IconButton
                    label={t("dshDeckT3Refresh")}
                    onClick={() => {
                      setT3ReloadVersion((value) => value + 1);
                      void reloadSessions();
                    }}
                  ><Icon name="refresh" /></IconButton>
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
                threadUrl={t3Thread?.deviceId === null ? t3Thread.url : null}
                threadTarget={t3Thread}
                reloadVersion={t3ReloadVersion}
                forceLocalVersion={t3ForceLocalVersion}
                settingsOpen={t3SettingsOpen}
                onSettingsChange={setT3SettingsOpen}
                onReload={() => setT3ReloadVersion((value) => value + 1)}
                onLocalReload={() => setT3Injected(false)}
                onActiveDeviceChange={handleActiveDeviceChange}
                onDevicesChange={handleDevicesChange}
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
          <DeckTty7Panel
            sessions={sessions}
            device={activeTty7Device}
            onClose={() => toggleTty7(false)}
            onOpen={openPane}
            activePane={tabs.active}
            openRequest={terminalRequest}
            onOpenRequestHandled={terminalRequestHandled}
          />
        ) : null}
      </div>
      {Object.entries(tabsByDevice).map(([deviceKey, deviceTabs]) => {
        if (deviceTabs.open.length === 0) return null;
        const isCurrentDevice = deviceKey === activeDeviceKey;
        const screenDevice =
          deviceKey === "local"
            ? null
            : { id: deviceKey, name: deviceNames[deviceKey] ?? activeT3Device?.name ?? deviceKey };
        const deviceSessions = isCurrentDevice
          ? sessions
          : {
              ...sessions,
              deviceKey,
              view: sessions.viewFor?.(deviceKey) ?? null,
              error: null,
            };
        return (
          <DeckTerminalScreen
            key={deviceKey}
            device={screenDevice}
            tabs={deviceTabs}
            sessions={deviceSessions}
            shown={isCurrentDevice && deviceTabs.active !== null}
            onTabsChange={(next) => setTabsForDevice(deviceKey, next)}
            onClose={() => setTabsForDevice(deviceKey, hideScreen)}
          />
        );
      })}
      <DeckReferencePicker
        open={t3RefPickerOpen}
        mode={t3Injected ? "t3-insert" : "t3"}
        onClose={closeT3Picker}
        onInsert={(mentionText) => {
          t3RefInserted.current = true;
          requestAnimationFrame(() => {
            t3Frame.current?.focus();
            postToT3({ type: "u-brain:t3-ref:insert", text: mentionText });
          });
        }}
        onCopied={() => {
          requestAnimationFrame(() => t3Frame.current?.focus());
        }}
        {...(t3RefFromAt.current ? { onPassthrough: closeT3Picker } : {})}
        onOpenTerminal={openLocalPane}
      />
    </Page>
  );
}
