import { useCallback, useEffect, useState } from "react";

import { Page } from "../components/page.js";
import { Spinner } from "../components/spinner.js";
import { useDaemon } from "../daemon-context.js";

type DshWebView =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "ready"; url: string }
  | { state: "error"; error: string };

const POLL_MS = 1_000;

/** 指挥台：整页嵌入 DeepSeek Harness 的 Web 界面，进程由 daemon 启动和托管。 */
export function DshDeckPage() {
  const { client, t } = useDaemon();
  const [view, setView] = useState<DshWebView>({ state: "starting" });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (retry: boolean): Promise<DshWebView> => {
    try {
      return (await client.deckDsh(retry)) as DshWebView;
    } catch (error) {
      return { state: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }, [client]);

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

  if (view.state === "ready") {
    return (
      <Page>
        <div className="dsh-deck">
          <iframe
            className="dsh-frame"
            src={view.url}
            title={t("dshDeckFrameTitle")}
            allow="clipboard-read; clipboard-write"
          />
        </div>
      </Page>
    );
  }
  if (view.state === "error") {
    return (
      <Page>
        <div className="dsh-deck dsh-deck-state">
          <p className="dsh-deck-error">{t("dshDeckError", { message: view.error })}</p>
          <button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>
            {t("dshDeckRetry")}
          </button>
        </div>
      </Page>
    );
  }
  return (
    <Page>
      <div className="dsh-deck dsh-deck-state">
        <Spinner />
        <p>{t("dshDeckStarting")}</p>
        <p className="dsh-deck-hint">{t("dshDeckStartingHint")}</p>
      </div>
    </Page>
  );
}
