import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../components/button.js";
import { BrandMark, Icon } from "../components/icons.js";
import { Spinner } from "../components/spinner.js";
import { createBrowserDaemon, type BrowserDaemon } from "../api/client.js";
import { browserWindowBridge } from "../lib/window.js";
import { translate, type MessageKey } from "../i18n/messages.js";
import type { Language } from "../lib/format.js";
import type { ReminderView } from "@you-brain/core/http/types.js";

const POLL_MS = 2_000;

/**
 * 记忆提醒弹框（桌面壳的独立小窗，路由 /reminder-popup）。
 * 壳发现新的聊到时提醒就把这个窗口弹到最前；页面自己拉提醒队列，
 * 显示最新的未处理项，回复或忽略后自动换下一条，没有就藏起窗口。
 */
export function ReminderPopupPage() {
  const clientRef = useRef<BrowserDaemon | null>(null);
  if (clientRef.current === null) clientRef.current = createBrowserDaemon();
  const client = clientRef.current;
  const [language, setLanguage] = useState<Language>("zh");
  const [queue, setQueue] = useState<ReminderView[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<"reply" | "ignore" | null>(null);
  const [settled, setSettled] = useState<"reply" | "ignore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language],
  );
  const settledRef = useRef<"reply" | "ignore" | null>(null);
  settledRef.current = settled;

  const refresh = useCallback(
    async (options: { withConfig?: boolean } = {}): Promise<ReminderView[]> => {
      try {
        const listed = await client.reminders();
        if (options.withConfig === true) {
          const config = await client.config();
          setLanguage(config.ui.language);
        }
        const open = listed.reminders
          .filter((item) => item.kind === "recall" && item.status === "open")
          .sort((left, right) =>
            left.issuedAt !== right.issuedAt
              ? left.issuedAt < right.issuedAt
                ? 1
                : -1
              : left.reminderId < right.reminderId
                ? 1
                : -1,
          );
        setQueue(open);
        setOffline(false);
        return open;
      } catch {
        setOffline(true);
        return [];
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh({ withConfig: true });
    const timer = setInterval(() => {
      // 确认语展示期间不换页，等 settle 自己推进。
      if (document.visibilityState === "hidden" || settledRef.current !== null) return;
      void refresh();
    }, POLL_MS);
    const onFocus = (): void => {
      if (settledRef.current !== null) return;
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const current = queue?.[0] ?? null;

  // 没有待处理项时把窗口交还给壳：Tauri 里由壳隐藏，浏览器里直接关窗口。
  useEffect(() => {
    if (queue === null || current !== null || offline) return;
    const bridge = browserWindowBridge();
    if (bridge.invoke) {
      void bridge.invoke("hide_reminder_popup").catch(() => undefined);
    } else {
      window.close();
    }
  }, [queue, current, offline]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const bridge = browserWindowBridge();
      if (bridge.invoke) void bridge.invoke("hide_reminder_popup").catch(() => undefined);
      else window.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const settle = useCallback(
    async (done: "reply" | "ignore"): Promise<void> => {
      setReply("");
      // 先给一句确认再换页：回复落到了哪里，不能让人猜。
      setSettled(done);
      await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
      setSettled(null);
      const rest = await refresh();
      if (rest.length === 0) {
        const bridge = browserWindowBridge();
        if (bridge.invoke) void bridge.invoke("hide_reminder_popup").catch(() => undefined);
        else window.close();
      }
    },
    [refresh],
  );

  const sendReply = useCallback(async (): Promise<void> => {
    if (current === null || busy !== null || reply.trim() === "") return;
    setBusy("reply");
    setError(null);
    try {
      await client.reminderReply(current.reminderId, reply.trim());
      await settle("reply");
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "" ? caught.message : t("actionFailed"));
    } finally {
      setBusy(null);
    }
  }, [busy, client, current, reply, settle, t]);

  const ignore = useCallback(async (): Promise<void> => {
    if (current === null || busy !== null) return;
    setBusy("ignore");
    setError(null);
    try {
      await client.reminderAction(current.reminderId, "ignore");
      await settle("ignore");
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "" ? caught.message : t("actionFailed"));
    } finally {
      setBusy(null);
    }
  }, [busy, client, current, settle, t]);

  return (
    <div className="popup-page">
      <header className="popup-head">
        <span className="popup-brand">
          <BrandMark size={16} />
          <span>{t("popupTitle")}</span>
        </span>
        {queue !== null && queue.length > 1 ? (
          <span className="popup-count">1 / {queue.length}</span>
        ) : null}
      </header>
      {offline && queue === null ? (
        <p className="popup-state">
          <Spinner /> {t("popupOffline")}
        </p>
      ) : current === null && queue !== null && !offline ? (
        <p className="popup-state">{t("popupEmpty")}</p>
      ) : current !== null ? (
        <div className="popup-body">
          {current.topicName ? <p className="popup-topic">{current.topicName}</p> : null}
          <p className="popup-text">{current.text}</p>
          {error ? (
            <p className="popup-error" role="alert">
              {error}
            </p>
          ) : null}
          {settled !== null ? (
            <p className="popup-settled" role="status">
              <Icon name="check-circle" size={14} />
              {settled === "reply" ? t("popupReplied") : t("popupIgnored")}
            </p>
          ) : (
            <textarea
              className="popup-input"
              value={reply}
              placeholder={t("popupReplyPlaceholder")}
              rows={2}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void sendReply();
                }
              }}
            />
          )}
          <div className="popup-actions">
            <Button
              size="sm"
              variant="secondary"
              loading={busy === "ignore"}
              disabled={busy !== null}
              onClick={() => void ignore()}
            >
              {t("popupIgnore")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy === "reply"}
              disabled={busy !== null || reply.trim() === ""}
              onClick={() => void sendReply()}
            >
              <Icon name="sparkles" size={14} />
              {t("popupReplySend")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="popup-state">
          <Spinner />
        </p>
      )}
    </div>
  );
}
