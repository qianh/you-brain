import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Banner } from "./components/banner.js";
import { Button } from "./components/button.js";
import { CommandPalette } from "./components/command-palette.js";
import { warmSearch } from "./lib/search-warm.js";
import { BrandMark, Icon, type IconName } from "./components/icons.js";
import { Kbd } from "./components/kbd.js";
import { Segmented } from "./components/segmented.js";
import { useShortcuts } from "./components/shortcuts.js";
import { StatusCapsule } from "./components/status-capsule.js";
import { useToast } from "./components/toast.js";
import { QuotaStrip } from "./components/quota-strip.js";
import { DeckRail } from "./components/deck-rail.js";
import { Tooltip } from "./components/tooltip.js";
import { useQuota } from "./pages/panel/use-quota.js";
import { useDaemon } from "./daemon-context.js";
import { devOverlayAllowed } from "./lib/dev-overlay.js";
import { capsuleFromStatus, capsuleWarningCount, type CapsuleKind, type CapsuleStatus } from "./lib/health.js";
import { prefs } from "./lib/prefs.js";
import { routeFadeAnimationEnded, useRouteEnter } from "./lib/route-fade.js";
import { MEMORY_NAV, MEMORY_TAB_KEY, isPrimaryNavActive, primaryNavTarget, readQuery, settingsHref } from "./lib/route.js";
import { modLabel, shortcutMod } from "./lib/shortcuts.js";
import { isUnreachableError } from "./pages/status/logic.js";
import { useRoute } from "./router.js";
import type { MessageKey } from "./i18n/messages.js";

const TABS: ReadonlyArray<{ key: MessageKey; href: string; icon: IconName }> = [
  { key: "navDeck", href: "/deck", icon: "command" },
  { key: "navTasks", href: "/todos", icon: "check-circle" },
  { key: "navMemory", href: MEMORY_NAV, icon: "book" },
  { key: "navKnowledge", href: "/knowledge", icon: "book-open" },
];


function RouteFade({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { entering, clear } = useRouteEnter(pathname);
  return (
    // 没有 key：主导航页面常驻挂载（App 的 KeepAlive），重挂载会把状态丢掉。
    <div
      className={entering ? "route-fade is-entering" : "route-fade"}
      onAnimationEnd={(event) => {
        if (routeFadeAnimationEnded(event.target, event.currentTarget)) clear();
      }}
    >
      {children}
    </div>
  );
}

export function shellCapsuleKind(input: { loading: boolean; status: CapsuleStatus | null }): CapsuleKind {
  return capsuleFromStatus(input.status, {
    connected: input.status !== null,
    syncing: input.loading && input.status === null,
  });
}

function capsuleText(kind: CapsuleKind, count: number, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  if (kind === "offline") return t("capsuleOffline");
  if (kind === "loading") return t("capsuleLoading");
  if (kind === "refine-error") return t("capsuleRefineError");
  if (kind === "sync-error") return t("capsuleSyncError");
  if (kind === "warn") return t("capsuleWarn", { count });
  return t("healthy");
}

export function Shell({ children }: { children: ReactNode }) {
  const { t, error, streamError, reload, loading, status, language, client } = useDaemon();
  const { cards: quotaCards, nowMs: quotaNow, reload: reloadQuota } = useQuota();
  const { push } = useToast();
  const { href, location, navigate } = useRoute();
  const [refreshing, setRefreshing] = useState(false);
  const overlay = devOverlayAllowed(location.pathname, import.meta.env.DEV);
  const offlineHome =
    (location.pathname === "/" || location.pathname === "/today") && status === null && isUnreachableError(error);
  const forceScrolled = overlay && readQuery(href, "scrolled") === "1";
  const [scrolled, setScrolled] = useState(forceScrolled);
  const requested = overlay ? readQuery(href, "open") : null;
  const [palette, setPalette] = useState(requested === "palette");
  const preset = requested === "palette" ? (readQuery(href, "pq") ?? "") : "";
  useEffect(() => {
    if (palette) warmSearch(client);
  }, [palette, client]);
  const settings = location.pathname === "/settings";
  const knowledge = location.pathname === "/knowledge";
  const deck = location.pathname === "/deck";
  const overlayTitlebar = typeof window !== "undefined" && window.__TAURI__ !== undefined && /Mac/.test(navigator.platform);
  const mod = shortcutMod(typeof navigator === "undefined" ? "" : navigator.platform);
  const chord = (key: string): string => `${modLabel(mod)}${mod === "meta" ? "" : "+"}${key}`;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const ok = await reload("all");
    void reloadQuota();
    setRefreshing(false);
    if (!ok) push({ message: t("refreshFailed"), tone: "danger" });
  }, [push, reload, reloadQuota, t]);

  useEffect(() => {
    // 偏好写回 daemon 失败时只提示一次；本次的值在内存里仍然有效。
    const onPrefsError = (): void => { push({ message: t("prefsSaveFailed"), tone: "danger" }); };
    window.addEventListener("you-brain:prefs-error", onPrefsError);
    return () => window.removeEventListener("you-brain:prefs-error", onPrefsError);
  }, [push, t]);

  useEffect(() => {
    const onScroll = (): void => setScrolled(forceScrolled || window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [forceScrolled]);

  useEffect(() => {
    document.documentElement.classList.toggle("shell-overlay", overlayTitlebar);
    return () => document.documentElement.classList.remove("shell-overlay");
  }, [overlayTitlebar]);

  // 常驻页面各自记住滚动位置：切回时回到原来的位置，第一次到某页才回顶部。
  const scrollMemory = useRef(new Map<string, number>());
  const previousPathname = useRef(location.pathname);
  useEffect(() => {
    if (previousPathname.current === location.pathname) return;
    scrollMemory.current.set(previousPathname.current, window.scrollY);
    window.scrollTo(0, scrollMemory.current.get(location.pathname) ?? 0);
    previousPathname.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    const onRefresh = (): void => {
      void refresh();
    };
    window.addEventListener("you-brain-refresh", onRefresh);
    return () => window.removeEventListener("you-brain-refresh", onRefresh);
  }, [refresh]);

  // 每个顶部菜单最后停留的完整地址，切回时回到那里（见 primaryNavTarget）。
  const lastByTab = useRef(new Map<string, string>());
  const activeTab = TABS.find((tab) => isPrimaryNavActive(location.pathname, tab.href))?.href;
  if (activeTab !== undefined) lastByTab.current.set(activeTab, href);
  const tabTarget = useCallback((tabHref: string): string => {
    let stored: string | null = null;
    try { stored = prefs.getItem(MEMORY_TAB_KEY); } catch { /* 读不到就按没记过。 */ }
    return primaryNavTarget(tabHref, lastByTab.current, stored);
  }, []);

  const shortcuts = useMemo(
    () => ({
      onPalette: () => setPalette(true),
      onNav: (index: number) => {
        const tab = TABS[index - 1];
        if (tab) navigate(tabTarget(tab.href));
      },
      onSettings: () => navigate(settingsHref("account")),
      onRefresh: () => {
        void refresh();
      },
      onSlash: () => {
        document.querySelector<HTMLElement>("[data-page-search]")?.focus();
      },
      onEscape: () => setPalette(false),
    }),
    [navigate, refresh, tabTarget],
  );
  useShortcuts(shortcuts);

  const current = TABS.find((tab) => isPrimaryNavActive(location.pathname, tab.href))?.href ?? "";
  // The search page has no tab of its own; the top-bar trigger is where it lives now.
  const onSearch = location.pathname === "/search";
  const kind = shellCapsuleKind({ loading, status });

  return (
    <div className={deck ? "app app-deck" : "app"}>
      <a className="skip" href="#content">
        {t("skip")}
      </a>
      <header className={scrolled ? "topbar is-scrolled" : "topbar"} {...(overlayTitlebar ? { "data-tauri-drag-region": "" } : {})}>
        <div className="top-left" {...(overlayTitlebar ? { "data-tauri-drag-region": "" } : {})}>
        <a
          className="brand"
          href="/today"
          onClick={(event) => {
            event.preventDefault();
            navigate("/today");
          }}
        >
          <BrandMark size={20} />
          <span>{t("brand")}</span>
        </a>
        <QuotaStrip cards={quotaCards} nowMs={quotaNow} language={language} />
        </div>
        <div className="top-nav" {...(overlayTitlebar ? { "data-tauri-drag-region": "" } : {})}>
          <div className="nav-fade">
            <Segmented
              className="nav-tabs"
              label={t("brand")}
              value={current}
              onChange={(value) => navigate(tabTarget(value))}
              options={TABS.map((tab) => ({
                value: tab.href,
                label: t(tab.key),
                icon: <Icon name={tab.icon} size={14} />,
              }))}
            />
          </div>
        </div>
        <div className="top-actions" {...(overlayTitlebar ? { "data-tauri-drag-region": "" } : {})}>
          <Tooltip content={t("searchTrigger")} shortcut={chord("K")}>
            <button
              type="button"
              className={onSearch ? "search-trigger is-current" : "search-trigger"}
              aria-label={t("openPalette")}
              {...(onSearch ? { "aria-current": "page" as const } : {})}
              onClick={() => setPalette(true)}
            >
              <Icon name="search" />
              <span>{t("searchTrigger")}</span>
              <Kbd>{chord("K")}</Kbd>
            </button>
          </Tooltip>
          <StatusCapsule kind={kind} label={capsuleText(kind, capsuleWarningCount(status), t)} onClick={() => navigate("/status")} />
          <Tooltip content={t("reload")} shortcut={chord("R")}>
            <button
              type="button"
              className={refreshing ? "icon-btn is-spinning" : "icon-btn"}
              aria-label={t("reload")}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" />
            </button>
          </Tooltip>
          <Tooltip content={t("navSettings")} shortcut={chord(",")}>
            <a
              className="icon-btn"
              href="/settings"
              aria-label={t("navSettings")}
              {...(settings ? { "aria-current": "page" as const } : {})}
              onClick={(event) => {
                event.preventDefault();
                navigate(settingsHref("account"));
              }}
            >
              <Icon name="settings" />
            </a>
          </Tooltip>
        </div>
      </header>
      <main
        id="content"
        className={
          deck
            ? "main main-wide main-deck"
            : knowledge
              ? "main main-wide main-bleed"
              : "main main-wide"
        }
      >
        {error && !offlineHome ? (
          <Banner tone="danger" action={<Button size="sm" onClick={() => void refresh()}>{t("retry")}</Button>}>
            {error}
          </Banner>
        ) : null}
        {streamError && !offlineHome ? <Banner tone="warn">{t("streamDown")}</Banner> : null}
        <RouteFade pathname={location.pathname}>{children}</RouteFade>
      </main>
      {deck ? null : <DeckRail label={t("navDeck")} moveLabel={t("navDeckRailMove")} onOpen={(target) => navigate(target)} />}
      <CommandPalette open={palette} onClose={() => setPalette(false)} initialQuery={preset} />
    </div>
  );
}
