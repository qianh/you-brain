import { useCallback, useEffect, useMemo, useState } from "react";

import { Page } from "../components/page.js";
import { Spinner } from "../components/spinner.js";
import { useDaemon } from "../daemon-context.js";
import { createDshCookiePreparer } from "../lib/dsh-cookies.js";
import { DeckTty7Panel } from "./deck-tty7.js";

type DshWebView =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "ready"; url: string }
  | { state: "error"; error: string };

const POLL_MS = 1_000;
const TTY7_OPEN_KEY = "you-brain.deck.tty7-open";

/**
 * 指挥台：左边嵌入 DeepSeek Harness 的 Web 界面（进程由 daemon 启动和托管），
 * 右边是可收起的 tty7 会话面板（ADR-0004）。
 */
export function DshDeckPage() {
  const { client, t } = useDaemon();
  const [view, setView] = useState<DshWebView>({ state: "starting" });
  const [attempt, setAttempt] = useState(0);
  const prepareCookies = useMemo(() => createDshCookiePreparer(
    typeof window === "undefined" ? undefined : window.__TAURI__?.core?.invoke,
  ), []);
  const [tty7Open, setTty7Open] = useState(() => {
    try {
      return localStorage.getItem(TTY7_OPEN_KEY) !== "0";
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
    if (readyUrl === null) return undefined;
    const timer = setInterval(() => {
      void load(false).then((next) => {
        if (next.state === "ready" && next.url === readyUrl) return;
        setView(next);
        if (next.state === "starting") setAttempt((value) => value + 1);
      });
    }, 3_000);
    return () => clearInterval(timer);
  }, [readyUrl, load]);

  const toggleTty7 = (open: boolean): void => {
    setTty7Open(open);
    try {
      localStorage.setItem(TTY7_OPEN_KEY, open ? "1" : "0");
    } catch {
      // 存不了就不记。
    }
  };

  let main;
  if (view.state === "ready") {
    main = (
      <iframe
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

  // tty7 会话面板与 DSH 无关：DSH 在启动或出错时也照常可用。
  return (
    <Page>
      <div className="dsh-deck">
        <div className="dsh-deck-main">{main}</div>
        {tty7Open ? (
          <DeckTty7Panel onClose={() => toggleTty7(false)} />
        ) : (
          <button type="button" className="deck-tty7-rail" onClick={() => toggleTty7(true)}>
            {t("deckTty7Show")}
          </button>
        )}
      </div>
    </Page>
  );
}
