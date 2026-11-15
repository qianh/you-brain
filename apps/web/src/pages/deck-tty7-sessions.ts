import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckTty7SessionsResponse } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";

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
  reload(): Promise<void>;
} {
  const { client } = useDaemon();
  const [view, setView] = useState<DeckTty7SessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current;
    try {
      const next = await client.deckTty7Sessions();
      if (mine !== sequence.current) return;
      setView(next);
      setError(null);
    } catch (failure) {
      if (mine === sequence.current) setError(errorText(failure));
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
