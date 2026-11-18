import { useCallback, useEffect, useRef, useState } from "react";
import type { ReminderView } from "@you-brain/core/http/types.js";

import { createBrowserDaemon, type BrowserDaemon } from "../api/client.js";
import { Button, IconButton } from "../components/button.js";
import { BrandMark, Icon } from "../components/icons.js";
import { Spinner } from "../components/spinner.js";
import { translate, type MessageKey } from "../i18n/messages.js";
import type { Language } from "../lib/format.js";
import { topicHref } from "../lib/route.js";
import { browserWindowBridge } from "../lib/window.js";
import { reminderToTaskInput } from "./reminders/model.js";

const POLL_MS = 2_000;

type BusyAction = "reply" | "done" | "todo" | "ignore" | null;
type SettledAction = "reply" | "done" | "todo" | "ignore" | null;

function formatIssuedTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * 记忆提醒弹框（桌面壳的独立小窗，路由 /reminder-popup）。
 * 壳发现新的聊到时提醒就把这个窗口弹到最前；页面自己拉提醒队列，
 * 支持一键加入 TODO、确认知道了、补充回复、跳转查看出处或忽略，没有剩余自动收起。
 */
export function ReminderPopupPage() {
  const clientRef = useRef<BrowserDaemon | null>(null);
  if (clientRef.current === null) clientRef.current = createBrowserDaemon();
  const client = clientRef.current;

  const [language, setLanguage] = useState<Language>("zh");
  const [queue, setQueue] = useState<ReminderView[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [settled, setSettled] = useState<SettledAction>(null);
  const [error, setError] = useState<string | null>(null);

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language],
  );
  const settledRef = useRef<SettledAction>(null);
  settledRef.current = settled;

  const hideWindow = useCallback((): void => {
    const bridge = browserWindowBridge();
    if (bridge.invoke) {
      void bridge.invoke("hide_reminder_popup").catch(() => undefined);
    } else {
      window.close();
    }
  }, []);

  const openMainAt = useCallback((path: string): void => {
    const bridge = browserWindowBridge();
    if (bridge.invoke) {
      void bridge.invoke("open_main_window", { path }).catch(() => undefined);
      return;
    }
    const url = new URL(path, bridge.pageUrl).toString();
    bridge.open(url, "you-brain-main", "width=1100,height=760");
  }, []);

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

  useEffect(() => {
    if (queue === null || current !== null || offline) return;
    hideWindow();
  }, [queue, current, offline, hideWindow]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      hideWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hideWindow]);

  const settle = useCallback(
    async (done: Exclude<SettledAction, null>): Promise<void> => {
      setReply("");
      setSettled(done);
      await new Promise<void>((resolve) => setTimeout(resolve, done === "todo" ? 1_350 : 950));
      setSettled(null);
      const rest = await refresh();
      if (rest.length === 0) {
        hideWindow();
      }
    },
    [hideWindow, refresh],
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

  const acknowledge = useCallback(async (): Promise<void> => {
    if (current === null || busy !== null) return;
    setBusy("done");
    setError(null);
    try {
      await client.reminderAction(current.reminderId, "done");
      await settle("done");
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "" ? caught.message : t("actionFailed"));
    } finally {
      setBusy(null);
    }
  }, [busy, client, current, settle, t]);

  const addToTodo = useCallback(async (): Promise<void> => {
    if (current === null || busy !== null) return;
    setBusy("todo");
    setError(null);
    try {
      const note = reply.trim();
      await client.createTask(reminderToTaskInput(current, note));
      // 同时记录已转入 TODO 并关掉提醒，避免后续同话题再次对同一件事弹窗。
      await client.reminderReply(current.reminderId, note !== "" ? note : t("popupTodoReplyNote"));
      await settle("todo");
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

  const settledMessage =
    settled === "todo"
      ? t("popupTodoAdded")
      : settled === "reply"
        ? t("popupReplied")
        : settled === "done"
          ? t("popupMarkedDone")
          : t("popupIgnored");

  const hasReplyText = reply.trim() !== "";
  const issuedClock = current ? formatIssuedTime(current.issuedAt) : "";

  return (
    <div className="popup-page">
      <header className="popup-head" data-tauri-drag-region="">
        <span className="popup-brand" data-tauri-drag-region="">
          <span className="popup-brand-mark">
            <BrandMark size={15} />
          </span>
          <span className="popup-brand-title" data-tauri-drag-region="">
            {t("popupTitle")}
          </span>
          {queue !== null && queue.length > 1 ? (
            <span className="popup-count">1 / {queue.length}</span>
          ) : null}
        </span>
        <IconButton className="popup-close" label={t("popupHide")} shortcut="Esc" onClick={hideWindow}>
          <Icon name="x" size={14} />
        </IconButton>
      </header>

      {offline && queue === null ? (
        <p className="popup-state">
          <Spinner /> {t("popupOffline")}
        </p>
      ) : current === null && queue !== null && !offline ? (
        <p className="popup-state">{t("popupEmpty")}</p>
      ) : current !== null ? (
        <div className="popup-body">
          <section className="popup-card" aria-label={t("popupTitle")}>
            {(current.topicName || current.topicId || issuedClock) ? (
              <div className="popup-meta">
                {current.topicId ? (
                  <button
                    type="button"
                    className="popup-topic-link"
                    onClick={() => openMainAt(topicHref("active", current.topicId ?? "", current.sessionKey ?? null))}
                    title={t(current.sessionKey ? "reminderViewSource" : "todayViewTopic")}
                  >
                    <Icon name="book" size={11} />
                    <span className="popup-topic-name">{current.topicName || t("todayViewTopic")}</span>
                    <span className="popup-topic-jump">
                      {t(current.sessionKey ? "reminderViewSource" : "todayViewTopic")}
                      <Icon name="external-link" size={10} />
                    </span>
                  </button>
                ) : current.topicName ? (
                  <span className="popup-topic-chip">
                    <Icon name="book" size={11} />
                    <span className="popup-topic-name">{current.topicName}</span>
                  </span>
                ) : (
                  <span />
                )}
                {issuedClock ? <time className="popup-time">{issuedClock}</time> : null}
              </div>
            ) : null}
            <p className="popup-text">{current.text}</p>
          </section>

          {error ? (
            <p className="popup-error" role="alert">
              <Icon name="alert-circle" size={13} />
              <span>{error}</span>
            </p>
          ) : null}

          {settled !== null ? (
            <div className="popup-settled-box" role="status">
              <span className="popup-settled">
                <Icon name="check-circle" size={15} />
                <span>{settledMessage}</span>
              </span>
              {settled === "todo" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  iconRight={<Icon name="external-link" size={12} />}
                  onClick={() => openMainAt("/todos")}
                >
                  {t("popupOpenTodo")}
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              <textarea
                className="popup-input"
                value={reply}
                placeholder={t("popupReplyPlaceholder")}
                rows={2}
                disabled={busy !== null}
                onChange={(event) => setReply(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (reply.trim() !== "") {
                      void sendReply();
                    }
                  }
                }}
              />
              <footer className="popup-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === "ignore"}
                  disabled={busy !== null}
                  onClick={() => void ignore()}
                >
                  {t("popupIgnore")}
                </Button>
                <div className="popup-actions-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="popup-todo-btn"
                    icon={<Icon name="plus" size={13} />}
                    loading={busy === "todo"}
                    disabled={busy !== null}
                    onClick={() => void addToTodo()}
                  >
                    {t("popupAddTodo")}
                  </Button>
                  {hasReplyText ? (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Icon name="sparkles" size={13} />}
                      loading={busy === "reply"}
                      disabled={busy !== null}
                      onClick={() => void sendReply()}
                    >
                      {t("popupReplySend")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Icon name="check" size={13} />}
                      loading={busy === "done"}
                      disabled={busy !== null}
                      onClick={() => void acknowledge()}
                    >
                      {t("popupDone")}
                    </Button>
                  )}
                </div>
              </footer>
            </>
          )}
        </div>
      ) : (
        <p className="popup-state">
          <Spinner />
        </p>
      )}
    </div>
  );
}
