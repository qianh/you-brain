import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Banner } from "./components/banner.js";
import { Button } from "./components/button.js";
import { CommandPalette } from "./components/command-palette.js";
import { BrandMark, Icon, type IconName } from "./components/icons.js";
import { Kbd } from "./components/kbd.js";
import { Segmented } from "./components/segmented.js";
import { useShortcuts } from "./components/shortcuts.js";
import { StatusCapsule } from "./components/status-capsule.js";
import { useToast } from "./components/toast.js";
import { Tooltip } from "./components/tooltip.js";
import { useDaemon } from "./daemon-context.js";
import { devOverlayAllowed } from "./lib/dev-overlay.js";
import { capsuleKind, type CapsuleKind } from "./lib/health.js";
import { routeFadeAnimationEnded, useRouteEnter } from "./lib/route-fade.js";
import { isPrimaryNavActive, readQuery, settingsHref } from "./lib/route.js";
import { modLabel, shortcutMod } from "./lib/shortcuts.js";
import { isUnreachableError } from "./pages/status/logic.js";
import { useRoute } from "./router.js";
import type { MessageKey } from "./i18n/messages.js";

const TABS: ReadonlyArray<{ key: MessageKey; href: string; icon: IconName }> = [
  { key: "navToday", href: "/today", icon: "calendar" },
  { key: "topicsBook", href: "/topics", icon: "book" },
  { key: "navPortrait", href: "/portrait", icon: "user" },
  { key: "navSearch", href: "/search", icon: "search" },
  { key: "navDevices", href: "/devices", icon: "laptop" },
  { key: "navStatus", href: "/status", icon: "activity" },
];

function RouteFade({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { entering, clear } = useRouteEnter(pathname);
  return (
    <div
      key={pathname}
      className={entering ? "route-fade is-entering" : "route-fade"}
      onAnimationEnd={(event) => {
        if (routeFadeAnimationEnded(event.target, event.currentTarget)) clear();
      }}
    >
      {children}
    </div>
  );
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
  const { t, error, streamError, reload, loading, status } = useDaemon();
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
  const settings = location.pathname === "/settings";
  const mod = shortcutMod(typeof navigator === "undefined" ? "" : navigator.platform);
  const chord = (key: string): string => `${modLabel(mod)}${mod === "meta" ? "" : "+"}${key}`;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const ok = await reload("all");
    setRefreshing(false);
    if (!ok) push({ message: t("refreshFailed"), tone: "danger" });
  }, [push, reload, t]);

  useEffect(() => {
    const onScroll = (): void => setScrolled(forceScrolled || window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [forceScrolled]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  useEffect(() => {
    const onRefresh = (): void => {
      void refresh();
    };
    window.addEventListener("you-brain-refresh", onRefresh);
    return () => window.removeEventListener("you-brain-refresh", onRefresh);
  }, [refresh]);

  const shortcuts = useMemo(
    () => ({
      onPalette: () => setPalette(true),
      onNav: (index: number) => {
        const tab = TABS[index - 1];
        if (tab) navigate(tab.href);
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
    [navigate, refresh],
  );
  useShortcuts(shortcuts);

  const current = TABS.find((tab) => isPrimaryNavActive(location.pathname, tab.href))?.href ?? "";
  const kind = capsuleKind({
    connected: status !== null,
    syncing: loading && status === null,
    driveReachable: status?.drive.reachable ?? null,
    refineError: status?.refine.lastError ?? null,
    syncError: null,
    warningCount: status?.warnings.length ?? 0,
  });

  return (
    <div className="app">
      <a className="skip" href="#content">
        {t("skip")}
      </a>
      <header className={scrolled ? "topbar is-scrolled" : "topbar"}>
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
        <div className="top-nav">
          <div className="nav-fade">
            <Segmented
              className="nav-tabs"
              label={t("brand")}
              value={current}
              onChange={navigate}
              options={TABS.map((tab) => ({
                value: tab.href,
                label: t(tab.key),
                icon: <Icon name={tab.icon} size={14} />,
              }))}
            />
          </div>
        </div>
        <div className="top-actions">
          <Tooltip content={t("searchTrigger")} shortcut={chord("K")}>
            <button type="button" className="search-trigger" aria-label={t("openPalette")} onClick={() => setPalette(true)}>
              <Icon name="search" />
              <span>{t("searchTrigger")}</span>
              <Kbd>{chord("K")}</Kbd>
            </button>
          </Tooltip>
          <StatusCapsule kind={kind} label={capsuleText(kind, status?.warnings.length ?? 0, t)} onClick={() => navigate("/status")} />
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
      <main id="content" className="main">
        {error && !offlineHome ? (
          <Banner tone="danger" action={<Button size="sm" onClick={() => void refresh()}>{t("retry")}</Button>}>
            {error}
          </Banner>
        ) : null}
        {streamError && !offlineHome ? <Banner tone="warn">{t("streamDown")}</Banner> : null}
        <RouteFade pathname={location.pathname}>{children}</RouteFade>
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)} initialQuery={preset} />
    </div>
  );
}
