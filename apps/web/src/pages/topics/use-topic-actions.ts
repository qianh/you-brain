import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { TodoStatus, TopicStatus } from "@you-brain/protocol";
import type { TopicDetail, TopicListItem } from "@you-brain/core/http/types.js";

import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";
import { topicHref } from "../../lib/route.js";
import { useRoute } from "../../router.js";
import {
  applyListPatch,
  openTodoCountAfter,
  statusLabelKey,
  toastQuote,
  withTodoStatus,
  type ListPatch,
} from "./logic.js";

export type SplitTarget =
  | { action: "create"; name: string }
  | { action: "assign"; topicId: string };

export interface TopicActions {
  busy: boolean;
  historyNote: boolean;
  patch: ListPatch | null;
  rename: (name: string) => Promise<boolean>;
  setStatus: (status: TopicStatus) => Promise<boolean>;
  changeAliases: (aliases: string[], change: { type: "add" | "remove"; name: string }) => Promise<boolean>;
  setTodo: (todoId: string, text: string, from: TodoStatus, to: TodoStatus) => Promise<boolean>;
  addConclusion: (text: string, sessionKey: string) => Promise<boolean>;
  mergeInto: (intoTopicId: string) => Promise<boolean>;
  splitSession: (sessionKey: string, sessionTitle: string, target: SplitTarget) => Promise<boolean>;
  copyLink: () => Promise<void>;
  displayTopic: <T extends TopicListItem>(topic: T) => T;
}

export function useTopicActions(
  detail: TopicDetail | null,
  setDetail: (detail: TopicDetail | null) => void,
  zone: "active" | "history",
  epoch: MutableRefObject<number>,
  busyRef: MutableRefObject<boolean>,
): TopicActions {
  const { client, topics, reload, t } = useDaemon();
  const { navigate } = useRoute();
  const { push, dismiss } = useToast();
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const zoneRef = useRef(zone);
  zoneRef.current = zone;
  const [busy, setBusy] = useState(false);
  const [noteTopicId, setNoteTopicId] = useState<string | null>(null);
  const [patch, setPatch] = useState<ListPatch | null>(null);
  const historyNote = detail !== null && noteTopicId === detail.topicId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (patch !== null && (detail === null || patch.topicId !== detail.topicId)) setPatch(null);

  const fail = (previous: TopicDetail | null): void => {
    if (mounted.current && previous && detailRef.current?.topicId === previous.topicId) setDetail(previous);
    setPatch(null);
    push({ message: t("saveFailedRestored"), tone: "danger", duration: 7000 });
  };

  const lock = (locked: boolean): void => {
    busyRef.current = locked;
    if (mounted.current) setBusy(locked);
  };

  async function refresh(topicId: string): Promise<TopicDetail | null> {
    await reload("topics");
    return client.topic(topicId);
  }

  const rename = async (name: string, aliases: string[], announce: string, undo: { name: string; aliases: string[]; message: string } | null): Promise<boolean> => {
    const current = detailRef.current;
    const nextName = name.trim();
    if (!current || nextName === "") return false;
    const previous = current;
    const token = ++epoch.current;
    lock(true);
    setDetail({ ...current, name: nextName, aliases, userLocked: true });
    setPatch({ topicId: current.topicId, name: nextName, aliases });
    try {
      await client.updateTopic(current.topicId, { op: "rename", name: nextName, aliases });
      const fresh = await refresh(current.topicId);
      if (epoch.current === token && mounted.current) {
        if (fresh) setDetail(fresh);
        setPatch(null);
      }
      let toastId = 0;
      toastId = push({
        message: announce,
        tone: "success",
        duration: 6000,
        ...(undo
          ? {
              action: {
                label: t("undo"),
                onClick: () => {
                  dismiss(toastId);
                  void rename(undo.name, undo.aliases, undo.message, null);
                },
              },
            }
          : {}),
      });
      return true;
    } catch {
      if (epoch.current === token) fail(previous);
      return false;
    } finally {
      lock(false);
    }
  };

  return {
    busy,
    historyNote,
    patch,
    displayTopic: (topic) => applyListPatch(topic, patch),
    rename: (name) => {
      const current = detailRef.current;
      if (!current) return Promise.resolve(false);
      const nextName = name.trim();
      if (nextName === "" || nextName === current.name) return Promise.resolve(false);
      return rename(
        nextName,
        current.aliases,
        t("renamedAs", { name: toastQuote(nextName) }),
        { name: current.name, aliases: [...current.aliases], message: t("renameRestored", { name: toastQuote(current.name) }) },
      );
    },
    changeAliases: (aliases, change) => {
      const current = detailRef.current;
      if (!current) return Promise.resolve(false);
      const quoted = toastQuote(change.name);
      const announce = change.type === "add" ? t("aliasAdded", { name: quoted }) : t("aliasRemoved", { name: quoted });
      return rename(current.name, aliases, announce, {
        name: current.name,
        aliases: [...current.aliases],
        message: t("aliasesRestored"),
      });
    },
    setStatus: async (status) => {
      const current = detailRef.current;
      if (!current || current.status === status) return false;
      const previous = current;
      const token = ++epoch.current;
      lock(true);
      setNoteTopicId(null);
      setDetail({ ...current, status, statusBy: "user", userLocked: true });
      setPatch({ topicId: current.topicId, status });
      try {
        await client.updateTopic(current.topicId, { op: "status", status });
        const fresh = await refresh(current.topicId);
        if (fresh && fresh.zone !== zoneRef.current) navigate(topicHref(fresh.zone, fresh.topicId));
        else if (epoch.current === token && fresh && mounted.current) {
          setDetail(fresh);
          setPatch(null);
          setNoteTopicId(status === "active" && fresh.zone === "history" ? fresh.topicId : null);
        }
        const statusName = t(statusLabelKey(status));
        const previousName = t(statusLabelKey(previous.status));
        let toastId = 0;
        toastId = push({
          message: t("statusUpdated", { status: statusName }),
          tone: "success",
          duration: 6000,
          action: {
            label: t("undo"),
            onClick: () => {
              dismiss(toastId);
              void restoreStatus(previous.status, previousName);
            },
          },
        });
        return true;
      } catch {
        if (epoch.current === token) fail(previous);
        return false;
      } finally {
        lock(false);
      }

      async function restoreStatus(restore: TopicStatus, restoredLabel: string): Promise<void> {
        const tokenRestore = ++epoch.current;
        lock(true);
        try {
          await client.updateTopic(previous.topicId, { op: "status", status: restore });
          const fresh = await refresh(previous.topicId);
          if (fresh && fresh.zone !== zoneRef.current) navigate(topicHref(fresh.zone, fresh.topicId));
          else if (epoch.current === tokenRestore && fresh && mounted.current) {
            setDetail(fresh);
            setPatch(null);
          }
          if (mounted.current) setNoteTopicId(null);
          push({ message: t("statusRestored", { status: restoredLabel }), tone: "success" });
        } catch {
          if (epoch.current === tokenRestore) fail(detailRef.current);
        } finally {
          lock(false);
        }
      }
    },
    setTodo: async (todoId, text, from, to) => {
      const current = detailRef.current;
      if (!current || from === to) return false;
      const topic = current;
      const previous = topic;
      const token = ++epoch.current;
      const quoted = toastQuote(text);
      lock(true);
      const listed = topics.find((item) => item.topicId === topic.topicId);
      const baseCount = patch?.topicId === topic.topicId && patch.openTodoCount !== undefined
        ? patch.openTodoCount
        : listed?.openTodoCount ?? topic.todos.filter((todo) => todo.status === "open").length;
      setDetail({ ...topic, todos: withTodoStatus(topic.todos, todoId, to) });
      setPatch({ topicId: topic.topicId, openTodoCount: openTodoCountAfter(baseCount, from, to) });
      try {
        await client.todo({ todoId, status: to });
        const fresh = await refresh(topic.topicId);
        if (epoch.current === token && mounted.current) {
          if (fresh) setDetail(fresh);
          setPatch(null);
        }
        const announce = to === "dropped" ? t("todoDroppedToast", { text: quoted }) : to === "done" ? t("todoCompleted", { text: quoted }) : t("todoRestored", { text: quoted });
        const undoTo = from;
        let toastId = 0;
        toastId = push({
          message: announce,
          tone: "success",
          duration: 6000,
          ...(to === "open"
            ? {}
            : {
                action: {
                  label: t("undo"),
                  onClick: () => {
                    dismiss(toastId);
                    void restoreTodo();
                  },
                },
              }),
        });
        async function restoreTodo(): Promise<void> {
          const live = detailRef.current;
          const tokenRestore = ++epoch.current;
          lock(true);
          try {
            if (live && live.topicId === topic.topicId) {
              setDetail({ ...live, todos: withTodoStatus(live.todos, todoId, undoTo) });
            }
            await client.todo({ todoId, status: undoTo });
            const next = await refresh(topic.topicId);
            if (epoch.current === tokenRestore && mounted.current) {
              if (next) setDetail(next);
              setPatch(null);
            }
            push({ message: t("todoRestored", { text: quoted }), tone: "success" });
          } catch {
            if (epoch.current === tokenRestore) fail(live);
          } finally {
            lock(false);
          }
        }
        return true;
      } catch {
        if (epoch.current === token) fail(previous);
        return false;
      } finally {
        lock(false);
      }
    },
    addConclusion: async (text, sessionKey) => {
      const current = detailRef.current;
      const body = text.trim();
      if (!current || body === "" || sessionKey === "") return false;
      const previous = current;
      const token = ++epoch.current;
      const pending: TopicDetail["conclusions"][number] = {
        conclusionId: `pending-${token}`,
        topicId: current.topicId,
        sessionKey,
        text: body,
        ts: new Date().toISOString(),
      };
      lock(true);
      setDetail({ ...current, conclusions: [...current.conclusions, pending] });
      try {
        await client.conclusion({ topicId: current.topicId, text: body, sessionKey });
        const fresh = await refresh(current.topicId);
        if (fresh && epoch.current === token && mounted.current) setDetail(fresh);
        push({ message: t("conclusionAdded"), tone: "success" });
        return true;
      } catch {
        if (epoch.current === token) fail(previous);
        return false;
      } finally {
        lock(false);
      }
    },
    mergeInto: async (intoTopicId) => {
      const current = detailRef.current;
      if (!current || intoTopicId === "") return false;
      const target = topics.find((topic) => topic.topicId === intoTopicId);
      const token = ++epoch.current;
      lock(true);
      try {
        await client.updateTopic(current.topicId, { op: "merge", intoTopicId });
        await reload("topics");
        const fresh = await client.topic(intoTopicId).catch(() => null);
        const targetZone = fresh?.zone ?? target?.zone ?? "active";
        navigate(topicHref(targetZone, intoTopicId));
        push({
          message: t("mergedToast", { source: toastQuote(current.name), target: toastQuote(target?.name ?? intoTopicId) }),
          tone: "success",
        });
        return true;
      } catch {
        if (epoch.current === token) push({ message: t("actionFailed"), tone: "danger", duration: 7000 });
        return false;
      } finally {
        lock(false);
      }
    },
    splitSession: async (sessionKey, sessionTitle, target) => {
      const current = detailRef.current;
      if (!current) return false;
      const previous = current;
      const token = ++epoch.current;
      const targetName = target.action === "create"
        ? target.name.trim()
        : topics.find((topic) => topic.topicId === target.topicId)?.name ?? target.topicId;
      lock(true);
      setDetail({ ...current, sessions: current.sessions.filter((session) => session.sessionKey !== sessionKey) });
      try {
        if (target.action === "create") {
          await client.updateTopic(current.topicId, {
            op: "split",
            sessionKey,
            target: { action: "create", name: target.name.trim() },
          });
        } else {
          await client.updateTopic(current.topicId, {
            op: "split",
            sessionKey,
            target: { action: "assign", topicId: target.topicId },
          });
        }
        const fresh = await refresh(current.topicId);
        if (fresh && epoch.current === token && mounted.current) setDetail(fresh);
        const quotedSession = toastQuote(sessionTitle);
        const quotedTarget = toastQuote(targetName);
        push({
          message: target.action === "create"
            ? t("splitToast", { session: quotedSession, target: quotedTarget })
            : t("moveToast", { session: quotedSession, target: quotedTarget }),
          tone: "success",
        });
        return true;
      } catch {
        if (epoch.current === token) fail(previous);
        return false;
      } finally {
        lock(false);
      }
    },
    copyLink: async () => {
      const current = detailRef.current;
      if (!current || typeof window === "undefined") return;
      const url = `${window.location.origin}${topicHref(current.zone, current.topicId)}`;
      try {
        await navigator.clipboard.writeText(url);
        push({ message: t("linkCopied"), tone: "success" });
      } catch {
        push({ message: t("linkCopyFailed"), tone: "danger", duration: 7000 });
      }
    },
  };
}
