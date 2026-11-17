import { useEffect, useState, type ReactNode } from "react";

import { BrandMark } from "./components/icons.js";
import { ToastProvider } from "./components/toast.js";
import { DaemonProvider, useDaemon } from "./daemon-context.js";
import { DshDeckPage } from "./pages/dsh-deck.js";
import { DesignPage } from "./pages/design.js";
import { PanelPage } from "./pages/panel.js";
import { ReminderPopupPage } from "./pages/reminder-popup.js";
import { TodayPage } from "./pages/today.js";
import { TopicsPage } from "./pages/topics.js";
import { SearchPage } from "./pages/search.js";
import { KnowledgePage } from "./pages/knowledge.js";
import { SettingsPage } from "./pages/settings.js";
import { TasksPage } from "./pages/tasks.js";
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
  const reminderPopup = location.pathname === "/reminder-popup";
  useEffect(() => {
    if (location.pathname === "/") navigate("/deck", "replace");
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
        : location.pathname === "/deck"
          ? t("navDeck")
          : location.pathname === "/todos"
            ? t("navTasks")
          : location.pathname === "/topics" || location.pathname === "/topics/history"
            ? t("navMemory")
              : location.pathname === "/knowledge"
                ? t("navKnowledge")
                : location.pathname === "/search"
                  ? t("navSearch")
                  : location.pathname === "/settings"
                    ? t("navSettings")
                    : t("navMemory");
    document.title = `${page} · U-Brain`;
  }, [location.pathname, t]);

  if (reminderPopup) return <ReminderPopupPage />;
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
  if (location.pathname === "/" || location.pathname === "/deck") page = <KeepAlive active="/deck" />;
  else if (location.pathname === "/today") page = <KeepAlive active="/today" />;
  else if (location.pathname === "/topics") page = <KeepAlive active="/topics" />;
  else if (location.pathname === "/topics/history") page = <KeepAlive active="/topics/history" />;
  else if (location.pathname === "/knowledge") page = <KeepAlive active="/knowledge" />;
  else if (location.pathname === "/todos") page = <KeepAlive active="/todos" />;
  else if (location.pathname === "/search") page = <SearchPage />;
  else if (location.pathname === "/settings") page = <SettingsPage />;
  else if (location.pathname === "/_design") page = <DesignPage />;
  return <Shell>{page}</Shell>;
}

/**
 * 主导航页面常驻挂载，切走只隐藏不卸载：回到原来的菜单时滚动位置、
 * 展开的条目和指挥台的会话状态都还在。数据本身来自 DaemonProvider，
 * 由 daemon 变更事件保持最新，常驻不会看过期内容。
 */
function KeepAlive({ active }: { active: string }) {
  const [mounted, setMounted] = useState([active]);
  useEffect(() => {
    setMounted((previous) => (previous.includes(active) ? previous : [...previous, active]));
  }, [active]);
  return (
    <>
      {mounted.map((pathname) => (
        <div key={pathname} className="keep-page" hidden={pathname !== active}>
          {renderKeepPage(pathname)}
        </div>
      ))}
    </>
  );
}

function renderKeepPage(pathname: string): ReactNode {
  switch (pathname) {
    case "/":
    case "/deck":
      return <DshDeckPage />;
    case "/today":
      return <TodayPage />;
    case "/topics":
      return <TopicsPage zone="active" />;
    case "/topics/history":
      return <TopicsPage zone="history" />;
    case "/knowledge":
      return <KnowledgePage />;
    case "/todos":
      return <TasksPage />;
    default:
      return null;
  }
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
