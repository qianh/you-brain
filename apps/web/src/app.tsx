import { lazy, memo, Suspense, useEffect, useState, type ReactNode } from "react";

import { BrandMark } from "./components/icons.js";
import { ToastProvider } from "./components/toast.js";
import { DaemonProvider, FrozenDaemon, useDaemon } from "./daemon-context.js";
import { PageActiveContext } from "./page-active.js";
import { useDelayed } from "./components/use-delayed.js";
import { loadChunk } from "./lib/load-chunk.js";
import { settingsHref } from "./lib/route.js";
import { FrozenRoute, Router, useRoute } from "./router.js";
import { Shell } from "./shell.js";
import { ThemeProvider } from "./theme-context.js";

/*
 * 页面一律按需加载：托盘面板、提醒弹窗是独立窗口，只拿自己那一页，不再带上 xterm、KaTeX 等；
 * 主窗口首屏只加载当前页，其余页面在空闲时预取（见 prefetchPages）；块加载失败的处理见 lib/load-chunk。
 */
const loadDeck = () => import("./pages/dsh-deck.js");
const loadToday = () => import("./pages/today.js");
const loadTopics = () => import("./pages/topics.js");
const loadKnowledge = () => import("./pages/knowledge.js");
const loadTasks = () => import("./pages/tasks.js");
const loadSearch = () => import("./pages/search.js");
const loadSettings = () => import("./pages/settings.js");
const DshDeckPage = lazy(() => loadChunk(loadDeck).then((m) => ({ default: m.DshDeckPage })));
const TodayPage = lazy(() => loadChunk(loadToday).then((m) => ({ default: m.TodayPage })));
const TopicsPage = lazy(() => loadChunk(loadTopics).then((m) => ({ default: m.TopicsPage })));
const KnowledgePage = lazy(() => loadChunk(loadKnowledge).then((m) => ({ default: m.KnowledgePage })));
const TasksPage = lazy(() => loadChunk(loadTasks).then((m) => ({ default: m.TasksPage })));
const SearchPage = lazy(() => loadChunk(loadSearch).then((m) => ({ default: m.SearchPage })));
const SettingsPage = lazy(() => loadChunk(loadSettings).then((m) => ({ default: m.SettingsPage })));
const DesignPage = lazy(() => loadChunk(() => import("./pages/design.js")).then((m) => ({ default: m.DesignPage })));
const PanelPage = lazy(() => loadChunk(() => import("./pages/panel.js")).then((m) => ({ default: m.PanelPage })));
const ReminderPopupPage = lazy(() =>
  loadChunk(() => import("./pages/reminder-popup.js")).then((m) => ({ default: m.ReminderPopupPage })),
);

/**
 * 首屏出来后预取主窗口的其余页面：第一次切菜单不用等下载，升级替换 web 目录后也少踩旧块缺失。
 * 预取失败只忽略，不触发刷新。WKWebView 没有 requestIdleCallback，用定时器。
 */
function prefetchPages(): () => void {
  const timer = window.setTimeout(() => {
    const terminal = () => import("./pages/deck-tty7-terminal.js");
    for (const load of [loadDeck, loadToday, loadTopics, loadKnowledge, loadTasks, loadSearch, loadSettings, terminal]) {
      void load().catch(() => undefined);
    }
  }, 1_500);
  return () => window.clearTimeout(timer);
}

/** 按需加载期间的占位：本地加载通常几十毫秒，短于 150 ms 就什么都不显示，避免闪一下。 */
function PageLoading() {
  const { t } = useDaemon();
  const shown = useDelayed(true);
  return (
    <div className="page page-loading" aria-busy="true">
      {shown ? <p className="page-loading-text">{t("loading")}</p> : null}
    </div>
  );
}

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

  useEffect(() => {
    if (panel || reminderPopup) return undefined;
    return prefetchPages();
  }, [panel, reminderPopup]);

  if (reminderPopup) return <Suspense fallback={null}><ReminderPopupPage /></Suspense>;
  if (loading && !today && !panel) {
    return (
      <div className="boot">
        <BrandMark />
        <p>{t("loading")}</p>
      </div>
    );
  }
  if (panel) return <Suspense fallback={null}><PanelPage /></Suspense>;

  let page = <Missing />;
  if (location.pathname === "/" || location.pathname === "/deck") page = <KeepAlive active="/deck" />;
  else if (location.pathname === "/today") page = <KeepAlive active="/today" />;
  else if (location.pathname === "/topics") page = <KeepAlive active="/topics" />;
  else if (location.pathname === "/topics/history") page = <KeepAlive active="/topics/history" />;
  else if (location.pathname === "/knowledge") page = <KeepAlive active="/knowledge" />;
  else if (location.pathname === "/todos") page = <KeepAlive active="/todos" />;
  else if (location.pathname === "/search") page = <Suspense fallback={<PageLoading />}><SearchPage /></Suspense>;
  else if (location.pathname === "/settings") page = <Suspense fallback={<PageLoading />}><SettingsPage /></Suspense>;
  else if (location.pathname === "/_design") page = <Suspense fallback={<PageLoading />}><DesignPage /></Suspense>;
  return <Shell>{page}</Shell>;
}

/**
 * 主导航页面常驻挂载，切走只隐藏不卸载：回到原来的菜单时滚动位置、
 * 展开的条目和指挥台的会话状态都还在。数据本身来自 DaemonProvider，
 * 由 daemon 变更事件保持最新，常驻不会看过期内容。
 *
 * 隐藏的页面不做后台工作：KeepPage 用 memo 挡住外层重渲染，FrozenDaemon / FrozenRoute 让它不随 daemon 推送
 * 和地址变化重渲染，usePageActive() 让轮询和上报暂停；切回时接上最新数据，各页面自行补拉一次。
 */
function KeepAlive({ active }: { active: string }) {
  const [mounted, setMounted] = useState([active]);
  useEffect(() => {
    setMounted((previous) => (previous.includes(active) ? previous : [...previous, active]));
  }, [active]);
  return (
    <>
      {mounted.map((pathname) => (
        <KeepPage key={pathname} pathname={pathname} active={pathname === active} />
      ))}
    </>
  );
}

const KeepPage = memo(function KeepPage({ pathname, active }: { pathname: string; active: boolean }) {
  return (
    <div className="keep-page" hidden={!active}>
      <PageActiveContext.Provider value={active}>
        <FrozenRoute frozen={!active}>
          <FrozenDaemon frozen={!active}>
            <Suspense fallback={<PageLoading />}>{renderKeepPage(pathname)}</Suspense>
          </FrozenDaemon>
        </FrozenRoute>
      </PageActiveContext.Provider>
    </div>
  );
});

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
