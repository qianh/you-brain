import { useEffect } from "react";

import { BrandMark } from "./components/icons.js";
import { ToastProvider } from "./components/toast.js";
import { DaemonProvider, useDaemon } from "./daemon-context.js";
import { DesignPage } from "./pages/design.js";
import { PanelPage } from "./pages/panel.js";
import { TodayPage } from "./pages/today.js";
import { TopicsPage } from "./pages/topics.js";
import { SearchPage } from "./pages/search.js";
import { KnowledgePage } from "./pages/knowledge.js";
import { SettingsPage } from "./pages/settings.js";
import { settingsHref } from "./lib/route.js";
import { Router, useRoute } from "./router.js";
import { Shell } from "./shell.js";
import { ThemeProvider } from "./theme-context.js";

export function App() {
  return (
    <ThemeProvider>
      <DaemonProvider>
        <ToastProvider>
          <Router>
            <Frame />
          </Router>
        </ToastProvider>
      </DaemonProvider>
    </ThemeProvider>
  );
}

function Frame() {
  const { location, navigate } = useRoute();
  const { loading, today, t } = useDaemon();
  const panel = location.pathname === "/panel";
  useEffect(() => {
    if (location.pathname === "/") navigate("/today", "replace");
  }, [location.pathname, navigate]);
  // 顶部导航收敛后,旧入口指到设置里的对应分区。
  useEffect(() => {
    const redirects: Record<string, string> = {
      "/portrait": settingsHref("portrait"),
      "/devices": settingsHref("devices"),
      "/status": settingsHref("status"),
    };
    const target = redirects[location.pathname];
    if (target) navigate(target, "replace");
  }, [location.pathname, navigate]);
  useEffect(() => {
    const page =
      location.pathname === "/panel"
        ? t("brand")
        : location.pathname === "/topics" || location.pathname === "/topics/history"
          ? t("topicsBook")
            : location.pathname === "/knowledge"
              ? t("navKnowledge")
              : location.pathname === "/search"
                ? t("navSearch")
                : location.pathname === "/settings"
                  ? t("navSettings")
                  : t("navToday");
    document.title = `${page} · U-Brain`;
  }, [location.pathname, t]);

  if (loading && !today && !panel) {
    return (
      <div className="boot">
        <BrandMark />
        <p>{t("loading")}</p>
      </div>
    );
  }
  if (panel) return <PanelPage />;

  let page = <Missing />;
  if (location.pathname === "/" || location.pathname === "/today") page = <TodayPage />;
  else if (location.pathname === "/topics") page = <TopicsPage zone="active" />;
  else if (location.pathname === "/topics/history") page = <TopicsPage zone="history" />;
  else if (location.pathname === "/knowledge") page = <KnowledgePage />;
  else if (location.pathname === "/search") page = <SearchPage />;
  else if (location.pathname === "/settings") page = <SettingsPage />;
  else if (location.pathname === "/_design") page = <DesignPage />;
  return <Shell>{page}</Shell>;
}

function Missing() {
  const { t } = useDaemon();
  const { navigate } = useRoute();
  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("notFound")}</h1>
      </header>
      <button type="button" className="btn" onClick={() => navigate("/today")}>
        {t("backToday")}
      </button>
    </div>
  );
}
