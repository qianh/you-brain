import type { ReactNode } from "react";

import { useDaemon } from "./daemon-context.js";
import { BrandMark, Icon } from "./components/icons.js";
import { Tabs } from "./components/tabs.js";
import { isPrimaryNavActive } from "./lib/route.js";
import { useRoute } from "./router.js";

const TABS = [
  ["navToday", "/today"],
  ["topicsBook", "/topics"],
  ["navPortrait", "/portrait"],
  ["navSearch", "/search"],
  ["navDevices", "/devices"],
  ["navStatus", "/status"],
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const { t, error, streamError, reload } = useDaemon();
  const { location, navigate } = useRoute();
  const settings = location.pathname === "/settings";
  return (
    <div className="app">
      <a className="skip" href="#content">
        {t("skip")}
      </a>
      <header className="topbar">
        <a
          className="brand"
          href="/today"
          onClick={(event) => {
            event.preventDefault();
            navigate("/today");
          }}
        >
          <BrandMark />
          <span>{t("brand")}</span>
        </a>
        <nav aria-label={t("brand")}>
          <Tabs
            label={t("brand")}
            items={TABS.map(([key, href]) => ({
              id: href,
              href,
              label: t(key),
              current: isPrimaryNavActive(location.pathname, href),
            }))}
            onNavigate={navigate}
          />
        </nav>
        <div className="top-actions">
          <button type="button" className="icon-btn" aria-label={t("reload")} onClick={() => void reload("all")}>
            <Icon name="refresh" />
          </button>
          <a
            className="icon-btn"
            href="/settings"
            aria-label={t("navSettings")}
            {...(settings ? { "aria-current": "page" as const } : {})}
            onClick={(event) => {
              event.preventDefault();
              navigate("/settings");
            }}
          >
            <Icon name="settings" />
          </a>
        </div>
      </header>
      <main id="content" className="main">
        {error ? (
          <div className="banner banner-bad">
            <span>{error}</span>
            <button type="button" className="btn small" onClick={() => void reload("all")}>
              {t("retry")}
            </button>
          </div>
        ) : null}
        {streamError ? <div className="banner banner-warn">{t("streamDown")}</div> : null}
        {children}
      </main>
    </div>
  );
}
