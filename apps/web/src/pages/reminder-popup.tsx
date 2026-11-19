import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckSessionNotice, ReminderView } from "@you-brain/core/http/types.js";

import { createBrowserDaemon, type BrowserDaemon } from "../api/client.js";
import { Button, IconButton } from "../components/button.js";
import { BrandMark, Icon } from "../components/icons.js";
import { Spinner } from "../components/spinner.js";
import { translate, type MessageKey } from "../i18n/messages.js";
import type { Language } from "../lib/format.js";
import { deckPaneHref, topicHref } from "../lib/route.js";
import { browserWindowBridge } from "../lib/window.js";
import { buildPopupQueue, type PopupItem } from "./popup-queue.js";
import { reminderToTaskInput } from "./reminders/model.js";

const POLL_MS = 2_000;

type BusyAction = "reply" | "done" | "todo" | "ignore" | "open" | null;
type SettledAction = "reply" | "done" | "todo" | "ignore" | "terminal_sent" | null;

function formatIssuedTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * 置顶提醒弹框（桌面壳的独立小窗，路由 /reminder-popup）：
 * 统一承载「聊到时记忆提醒」与「tty7 终端会话提醒（等你回复 / 已完成）」。
 * 页面轮询待处理队列；终端提醒只给一句话，详情去原终端看，也可直接输入回车发往原终端，
 * 或将记忆提醒加入 TODO / 回复 / 确认 / 忽略；队列清空后自动收起。
 */
export function ReminderPopupPage() {
  const clientRef = useRef<BrowserDaemon | null>(null);
  if (clientRef.current === null) clientRef.current = createBrowserDaemon();
  const client = clientRef.current;

  const [language, setLanguage] = useState<Language>("zh");
  const [queue, setQueue] = useState<PopupItem[] | null>(null);
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
    async (options: { withConfig?: boolean } = {}): Promise<PopupItem[]> => {
      try {
        const [listed, deckNotices] = await Promise.all([
          client.reminders().catch(() => null),
          client.deckNotices().catch((): { notices: DeckSessionNotice[] } => ({ notices: [] })),
        ]);
        if (options.withConfig === true) {
          const config = await client.config();
          setLanguage(config.ui.language);
        }
        const silentNotifications = (await browserWindowBridge().invoke?.("get_silent_notifications")
          .catch(() => false)) === true;
        if (listed === null && !silentNotifications) {
          setOffline(true);
          return [];
        }
        const merged = buildPopupQueue(listed?.reminders ?? [], deckNotices.notices, silentNotifications);
        setQueue(merged);
        setOffline(false);
        return merged;
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
    const onNotificationModeChange = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("you-brain-silent-notifications-changed", onNotificationModeChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("you-brain-silent-notifications-changed", onNotificationModeChange);
    };
  }, [refresh]);

  const current = queue?.[0] ?? null;
  const activeKey = current?.key ?? null;
  const lastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastKeyRef.current !== activeKey) {
      lastKeyRef.current = activeKey;
      setReply("");
      setError(null);
    }
  }, [activeKey]);

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
      await new Promise<void>((resolve) => setTimeout(resolve, done === "todo" ? 1_350 : 850));
      setSettled(null);
      const rest = await refresh();
      if (rest.length === 0) {
        hideWindow();
      }
    },
    [hideWindow, refresh],
  );

  const sendReminderReply = useCallback(
    async (reminder: ReminderView): Promise<void> => {
      if (busy !== null || reply.trim() === "") return;
      setBusy("reply");
      setError(null);
      try {
        await client.reminderReply(reminder.reminderId, reply.trim());
        await settle("reply");
      } catch (caught) {
        setError(caught instanceof Error && caught.message !== "" ? caught.message : t("actionFailed"));
      } finally {
        setBusy(null);
      }
    },
    [busy, client, reply, settle, t],
  );

  const acknowledgeReminder = useCallback(
    async (reminder: ReminderView): Promise<void> => {
      if (busy !== null) return;
      setBusy("done");
      setError(null);
      try {
        await client.reminderAction(reminder.reminderId, "done");
        await settle("done");
      } catch (caught) {
        setError(caught instanceof Error && caught.message !== "" ? caught.message : t("actionFailed"));
      } finally {
        setBusy(null);
      }
    },
    [busy, client, settle, t],
  );

  const addToTodo = useCallback(
    async (reminder: ReminderView): Promise<void> => {
      if (busy !== null) return;
      setBusy("todo");
      setError(null);
      try {
        const note = reply.trim();
        await client.createTask(reminderToTaskInput(reminder, note));
        // 同时记录已转入 TODO 并关掉提醒，避免后续同话题再次对同一件事弹窗。
        await client.reminderReply(reminder.reminderId, note !== "" ? note : t("popupTodoReplyNote"));
        await settle("todo");
      } catch (caught) {
        setError(caught instanceof Error && caught.message !== "" ? caught.message : t("actionFailed"));
      } finally {
        setBusy(null);
      }
    },
    [busy, client, reply, settle, t],
  );

  const ignoreReminder = useCallback(
    async (reminder: ReminderView): Promise<void> => {
      if (busy !== null) return;
      setBusy("ignore");
      setError(null);
      try {
        await client.reminderAction(reminder.reminderId, "ignore");
        await settle("ignore");
      } catch (caught) {
        setError(caught instanceof Error && caught.message !== "" ? caught.message : t("actionFailed"));
      } finally {
        setBusy(null);
      }
    },
    [busy, client, settle, t],
  );

  const sendTerminalReply = useCallback(
    async (notice: DeckSessionNotice): Promise<void> => {
      if (busy !== null || reply.trim() === "") return;
      setBusy("reply");
      setError(null);
      try {
        await client.deckTty7Send({ pane: notice.pane, text: reply.trim(), enter: true });
        await client.deckNoticeDismiss({ seq: notice.seq });
        await settle("terminal_sent");
      } catch (caught) {
        setError(caught instanceof Error && caught.message !== "" ? caught.message : t("actionFailed"));
      } finally {
        setBusy(null);
      }
    },
    [busy, client, reply, settle, t],
  );

  const dismissTerminal = useCallback(
    async (notice: DeckSessionNotice, action: "done" | "ignore"): Promise<void> => {
      if (busy !== null) return;
      setBusy(action);
      setError(null);
      try {
        // 忽略 = 这个会话之后不再提醒（直到会话关闭）；知道了 = 只关这一条。
        await client.deckNoticeDismiss(action === "ignore" ? { seq: notice.seq, mute: true } : { seq: notice.seq });
        await settle(action);
      } catch (caught) {
        setError(caught instanceof Error && caught.message !== "" ? caught.message : t("actionFailed"));
      } finally {
        setBusy(null);
      }
    },
    [busy, client, settle, t],
  );

  const openTerminalSession = useCallback(
    async (notice: DeckSessionNotice): Promise<void> => {
      if (busy !== null) return;
      setBusy("open");
      setError(null);
      try {
        openMainAt(deckPaneHref(notice.pane));
        await client.deckNoticeDismiss({ seq: notice.seq }).catch(() => undefined);
        const rest = await refresh();
        if (rest.length === 0) {
          hideWindow();
        }
      } finally {
        setBusy(null);
      }
    },
    [busy, client, hideWindow, openMainAt, refresh],
  );

  const settledMessage =
    settled === "todo"
      ? t("popupTodoAdded")
      : settled === "terminal_sent"
        ? t("popupTerminalSent")
        : settled === "reply"
          ? t("popupReplied")
          : settled === "done"
            ? t("popupMarkedDone")
            : t("popupIgnored");

  const hasReplyText = reply.trim() !== "";
  const issuedClock = current ? formatIssuedTime(current.at) : "";
  const tone =
    current?.type === "terminal"
      ? current.notice.kind === "waiting"
        ? "waiting"
        : "done"
      : "recall";

  return (
    <div className="popup-page" data-tone={tone}>
      <header className="popup-head" data-tauri-drag-region="">
        <span className="popup-brand" data-tauri-drag-region="">
          <span className="popup-brand-mark">
            {current?.type === "terminal" ? <Icon name="terminal" size={14} /> : <BrandMark size={15} />}
          </span>
          <span className="popup-brand-title" data-tauri-drag-region="">
            {current?.type === "terminal" ? t("popupTerminalTitle") : t("popupTitle")}
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
      ) : current !== null && current.type === "terminal" ? (
        <div className="popup-body">
          <section className="popup-card popup-terminal-card" aria-label={t("popupTerminalTitle")}>
            <div className="popup-meta">
              <button
                type="button"
                className="popup-topic-link popup-session-link"
                onClick={() => void openTerminalSession(current.notice)}
                title={[current.notice.task ? current.notice.sessionName : null, current.notice.cwd].filter(Boolean).join(" · ") || current.notice.sessionName}
              >
                <Icon name="terminal" size={11} />
                <span className="popup-topic-name">
                  {current.notice.task ?? current.notice.sessionName}
                  <span className="popup-pane-tag">%{current.notice.pane}</span>
                  {current.notice.agent ? <span className="popup-agent-tag">· {current.notice.agent}</span> : null}
                </span>
                <span className="popup-topic-jump">
                  {t("popupOpenTerminal")}
                  <Icon name="external-link" size={10} />
                </span>
              </button>
              <span className="popup-meta-right">
                <span className="popup-status-pill" data-kind={current.notice.kind}>
                  {current.notice.kind === "waiting" ? t("popupTerminalWaiting") : t("popupTerminalDone")}
                </span>
                {issuedClock ? <time className="popup-time">{issuedClock}</time> : null}
              </span>
            </div>
            <p
              className="popup-text popup-term-line"
              title={current.notice.body !== "" ? current.notice.body : current.notice.title}
            >
              {current.notice.body !== "" ? current.notice.body : current.notice.title}
            </p>
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
            </div>
          ) : (
            <>
              <textarea
                className="popup-input"
                value={reply}
                placeholder={
                  current.notice.kind === "waiting"
                    ? t("popupTerminalWaitingPlaceholder")
                    : t("popupTerminalDonePlaceholder")
                }
                rows={1}
                disabled={busy !== null}
                onChange={(event) => setReply(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (reply.trim() !== "") {
                      void sendTerminalReply(current.notice);
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
                  onClick={() => void dismissTerminal(current.notice, "ignore")}
                >
                  {t("popupIgnore")}
                </Button>
                <div className="popup-actions-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="popup-todo-btn"
                    icon={<Icon name="external-link" size={13} />}
                    loading={busy === "open"}
                    disabled={busy !== null}
                    onClick={() => void openTerminalSession(current.notice)}
                  >
                    {t("popupOpenTerminal")}
                  </Button>
                  {hasReplyText ? (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Icon name="corner-down-left" size={13} />}
                      loading={busy === "reply"}
                      disabled={busy !== null}
                      onClick={() => void sendTerminalReply(current.notice)}
                    >
                      {t("popupTerminalSend")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Icon name="check" size={13} />}
                      loading={busy === "done"}
                      disabled={busy !== null}
                      onClick={() => void dismissTerminal(current.notice, "done")}
                    >
                      {t("popupDone")}
                    </Button>
                  )}
                </div>
              </footer>
            </>
          )}
        </div>
      ) : current !== null ? (
        <div className="popup-body">
          <section className="popup-card" aria-label={t("popupTitle")}>
            {(current.reminder.topicName || current.reminder.topicId || issuedClock) ? (
              <div className="popup-meta">
                {current.reminder.topicId ? (
                  <button
                    type="button"
                    className="popup-topic-link"
                    onClick={() =>
                      openMainAt(
                        topicHref("active", current.reminder.topicId ?? "", current.reminder.sessionKey ?? null),
                      )
                    }
                    title={t(current.reminder.sessionKey ? "reminderViewSource" : "todayViewTopic")}
                  >
                    <Icon name="book" size={11} />
                    <span className="popup-topic-name">
                      {current.reminder.topicName || t("todayViewTopic")}
                    </span>
                    <span className="popup-topic-jump">
                      {t(current.reminder.sessionKey ? "reminderViewSource" : "todayViewTopic")}
                      <Icon name="external-link" size={10} />
                    </span>
                  </button>
                ) : current.reminder.topicName ? (
                  <span className="popup-topic-chip">
                    <Icon name="book" size={11} />
                    <span className="popup-topic-name">{current.reminder.topicName}</span>
                  </span>
                ) : (
                  <span />
                )}
                {issuedClock ? <time className="popup-time">{issuedClock}</time> : null}
              </div>
            ) : null}
            <p className="popup-text">{current.reminder.text}</p>
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
                      void sendReminderReply(current.reminder);
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
                  onClick={() => void ignoreReminder(current.reminder)}
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
                    onClick={() => void addToTodo(current.reminder)}
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
                      onClick={() => void sendReminderReply(current.reminder)}
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
                      onClick={() => void acknowledgeReminder(current.reminder)}
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
