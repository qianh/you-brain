import type { ReactNode } from "react";

import { useDaemon } from "./daemon-context.js";
import { isNavActive } from "./lib/route.js";
import { useRoute } from "./router.js";

const LINKS = [
  ["navToday", "/today"],
  ["navTopicsActive", "/topics"],
  ["navTopicsHistory", "/topics/history"],
  ["navPortrait", "/portrait"],
  ["navSearch", "/search"],
  ["navDevices", "/devices"],
  ["navSettings", "/settings"],
  ["navStatus", "/status"],
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const { t, error, streamError, reload } = useDaemon();
  const { location, navigate } = useRoute();
  return (
    <div className="app">
      <a className="skip" href="#content">
        {t("skip")}
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            yb
          </span>
          <div>
            <strong>{t("brand")}</strong>
            <small>{t("tagline")}</small>
          </div>
        </div>
        <nav>
          {LINKS.map(([key, href]) => (
            <a
              key={href}
              href={href}
              aria-current={isNavActive(location.pathname, href) ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate(href);
              }}
            >
              {t(key)}
            </a>
          ))}
        </nav>
      </aside>
      <main id="content" className="main">
        {error ? (
          <div className="banner banner-bad">
            <span>{error}</span>
            <button type="button" onClick={() => void reload("all")}>
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
