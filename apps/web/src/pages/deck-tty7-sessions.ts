import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckTty7SessionsResponse } from "@you-brain/core/http/types.js";

import { useToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import type { TerminalReference } from "../lib/terminal-reference.js";

export type Session = DeckTty7SessionsResponse["sessions"][number];

const SESSIONS_POLL_MS = 5_000;

/** 路径的最后一段；路径全空时原样返回。 */
export function baseName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

/** 等你回复的会话个数，用于工具栏角标。 */
export function waitingCount(sessions: readonly Session[]): number {
  return sessions.filter((session) => session.status === "waiting").length;
}

/** 会话显示名：标签名，否则目录名，否则 %pane。 */
export function sessionTitle(session: Session): string {
  return session.tabLabel ?? (session.cwd === "" ? `%${session.pane}` : baseName(session.cwd));
}

/** 指挥台首次使用默认 T3；只有明确记着 dsh 才回到 DSH。 */
export function initialDeckView(stored: string | null): "dsh" | "t3" {
  return stored === "dsh" ? "dsh" : "t3";
}

/**
 * 处理「打开某个会话」的请求：必须等请求到达之后重新加载的列表，不能用内存里可能过期的旧列表。
 * 加载失败（reload 返回 null）不算缺失：错误由列表的错误提示显示，请求照样视为已处理。
 */
export async function resolveOpenRequest(
  request: TerminalReference,
  reload: () => Promise<DeckTty7SessionsResponse | null>,
): Promise<{ pane: number | null; missing: boolean }> {
  const fresh = await reload();
  if (fresh === null) return { pane: null, missing: false };
  const target = fresh.sessions.find((session) => session.pane === request.pane &&
    session.workspaceId === request.workspaceId && session.tabId === request.tabId);
  return target ? { pane: target.pane, missing: false } : { pane: null, missing: true };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 会话列表的共享数据源：每 5 秒轮询一次，页面不可见时暂停。
 * 整个指挥台只调用一次，面板、工具栏角标和全屏终端都读同一份结果。
 * 后发出的请求总是覆盖先发出的，旧响应不会把新数据冲掉。
 */
export function useTty7Sessions(): {
  view: DeckTty7SessionsResponse | null;
  error: string | null;
  /** 返回这次重新加载得到的列表；失败返回 null。 */
  reload(): Promise<DeckTty7SessionsResponse | null>;
} {
  const { client } = useDaemon();
  const [view, setView] = useState<DeckTty7SessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  const reload = useCallback(async (): Promise<DeckTty7SessionsResponse | null> => {
    const mine = ++sequence.current;
    try {
      const next = await client.deckTty7Sessions();
      // 即使被更新的请求取代，这份数据仍是请求之后加载的，可以返回给调用方。
      if (mine === sequence.current) {
        setView(next);
        setError(null);
      }
      return next;
    } catch (failure) {
      if (mine === sequence.current) setError(errorText(failure));
      return null;
    }
  }, [client]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, SESSIONS_POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return { view, error, reload };
}

/**
 * 改名：面板、下拉和标签共用同一份。
 * tty7 改的是整个 tab 的名字，同 tab 的其他会话也会变，所以成功后整体重新加载。
 * 失败时 rename 抛错，由 InlineRename 恢复原值，再用 reportError 弹提示。
 */
export function useSessionRename(reload: () => Promise<DeckTty7SessionsResponse | null>): {
  rename: (pane: number, name: string) => Promise<void>;
  reportError: (error: unknown) => void;
} {
  const { client, t } = useDaemon();
  const { push } = useToast();
  const rename = useCallback(async (pane: number, name: string): Promise<void> => {
    await client.deckTty7Rename(pane, name);
    await reload();
  }, [client, reload]);
  const reportError = useCallback((error: unknown): void => {
    push({ message: t("deckTty7RenameFailed", { detail: errorText(error) }), tone: "danger" });
  }, [push, t]);
  return { rename, reportError };
}
