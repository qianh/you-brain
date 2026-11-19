import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckTty7SessionsResponse } from "@you-brain/core/http/types.js";

import { useToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import { usePageActive } from "../page-active.js";
import { prefs } from "../lib/prefs.js";
import type { TerminalReference } from "../lib/terminal-reference.js";

export type Session = DeckTty7SessionsResponse["sessions"][number];

const SESSIONS_POLL_MS = 5_000;
const ORDER_KEY = "you-brain.deck.tty7-order";

export interface Tty7Order {
  groups: readonly string[];
  sessions: readonly string[];
}

export type Tty7OrderTarget = { group: string; session?: string };
export type Tty7DropPlacement = "before" | "after";
export type MoveTty7Item = (source: Tty7OrderTarget, target: Tty7OrderTarget, placement: Tty7DropPlacement) => void;

export function readTty7Order(raw: string | null): Tty7Order {
  const ids = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string"))]
    : [];
  try {
    const parsed = JSON.parse(raw ?? "null") as Partial<Tty7Order> | null;
    return { groups: ids(parsed?.groups), sessions: ids(parsed?.sessions) };
  } catch {
    return { groups: [], sessions: [] };
  }
}

/** 路径的最后一段；路径全空时原样返回。 */
export function baseName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

export function tty7GroupKey(session: Session): string {
  return baseName(session.cwd);
}

export function tty7SessionKey(session: Session): string {
  return JSON.stringify([session.tabId, session.pane]);
}

export function reconcileTty7Order(order: Tty7Order, sessions: readonly Session[]): Tty7Order {
  const groups = new Set(order.groups);
  const incoming = new Set<string>();
  for (const session of sessions) {
    groups.add(tty7GroupKey(session));
    incoming.add(tty7SessionKey(session));
  }
  const kept = order.sessions.filter((id) => incoming.delete(id));
  if (groups.size === order.groups.length && kept.length === order.sessions.length && incoming.size === 0) return order;
  return { groups: [...groups], sessions: [...kept, ...incoming] };
}

export function visibleTty7Groups(sessions: readonly Session[], order: Tty7Order, filter: string, activeOnly: boolean): [string, Session[]][] {
  const needle = filter.trim().toLowerCase();
  const byId = new Map(sessions.map((session) => [tty7SessionKey(session), session]));
  const members = new Map<string, Session[]>();
  for (const id of order.sessions) {
    const session = byId.get(id);
    if (session === undefined || (activeOnly && session.status === null && session.hibernated)) continue;
    if (needle !== "" && ![session.tabLabel ?? "", session.task ?? "", session.agent ?? "", session.status ?? "", session.cwd, `%${session.pane}`]
      .some((field) => field.toLowerCase().includes(needle))) continue;
    const group = tty7GroupKey(session);
    const items = members.get(group);
    if (items === undefined) members.set(group, [session]);
    else items.push(session);
  }
  return order.groups.flatMap((group) => {
    const items = members.get(group);
    return items === undefined ? [] : [[group, items]];
  });
}

export function canMoveTty7Item(source: Tty7OrderTarget, target: Tty7OrderTarget): boolean {
  return source.session === undefined
    ? target.session === undefined && source.group !== target.group
    : target.session !== undefined && source.group === target.group && source.session !== target.session;
}

export function moveTty7Item(order: Tty7Order, sessions: readonly Session[], source: Tty7OrderTarget, target: Tty7OrderTarget, placement: Tty7DropPlacement): Tty7Order {
  if (!canMoveTty7Item(source, target)) return order;
  const matches = (item: Tty7OrderTarget) => sessions.some((session) => tty7GroupKey(session) === item.group &&
    (item.session === undefined || tty7SessionKey(session) === item.session));
  if (!matches(source) || !matches(target)) return order;

  const key = source.session === undefined ? "groups" : "sessions";
  const from = source.session ?? source.group;
  const to = target.session ?? target.group;
  const next = order[key].filter((id) => id !== from);
  next.splice(next.indexOf(to) + (placement === "after" ? 1 : 0), 0, from);
  return next.every((id, index) => id === order[key][index]) ? order : { ...order, [key]: next };
}

/** 等你回复的会话个数，用于工具栏角标。 */
export function waitingCount(sessions: readonly Session[]): number {
  return sessions.filter((session) => session.status === "waiting").length;
}

/** 原始标题：tty7 标签名（CLI 自己设的终端标题或手动起的名），否则目录名，否则 %pane。 */
export function sessionLabel(session: Session): string {
  return session.tabLabel ?? (session.cwd === "" ? `%${session.pane}` : baseName(session.cwd));
}

/** 会话显示名：最近一轮的任务名优先（手动起过名的除外），否则原始标题。 */
export function sessionTitle(session: Session): string {
  if (session.task && !session.tabNamed) return session.task;
  return sessionLabel(session);
}

export type DeckViewId = "dsh" | "t3" | "muse";

/** 指挥台首次使用默认 T3；明确记着 dsh 或 muse 时回到上次停留页。 */
export function initialDeckView(stored: string | null): DeckViewId {
  if (stored === "dsh" || stored === "muse") return stored;
  return "t3";
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
  order: Tty7Order;
  move: MoveTty7Item;
  /** 返回这次重新加载得到的列表；失败返回 null。 */
  reload(): Promise<DeckTty7SessionsResponse | null>;
} {
  const { client } = useDaemon();
  const pageActive = usePageActive();
  const [{ view, order }, setList] = useState<{ view: DeckTty7SessionsResponse | null; order: Tty7Order }>(() => ({
    view: null,
    order: readTty7Order(prefs.getItem(ORDER_KEY)),
  }));
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    if (order.groups.length === 0) return;
    const stored = JSON.stringify(order);
    if (stored !== prefs.getItem(ORDER_KEY)) prefs.setItem(ORDER_KEY, stored);
  }, [order]);

  const move = useCallback<MoveTty7Item>((source, target, placement) => {
    setList((current) => {
      if (!current.view?.available) return current;
      const next = moveTty7Item(current.order, current.view.sessions, source, target, placement);
      return next === current.order ? current : { ...current, order: next };
    });
  }, []);

  const reload = useCallback(async (): Promise<DeckTty7SessionsResponse | null> => {
    const mine = ++sequence.current;
    try {
      const next = await client.deckTty7Sessions();
      // 即使被更新的请求取代，这份数据仍是请求之后加载的，可以返回给调用方。
      if (mine === sequence.current) {
        setList((current) => ({
          view: next,
          order: next.available ? reconcileTty7Order(current.order, next.sessions) : current.order,
        }));
        setError(null);
      }
      return next;
    } catch (failure) {
      if (mine === sequence.current) setError(errorText(failure));
      return null;
    }
  }, [client]);

  // 指挥台切走（常驻但隐藏）时不轮询；切回时立即拉一次。
  useEffect(() => {
    if (!pageActive) return;
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, SESSIONS_POLL_MS);
    return () => clearInterval(timer);
  }, [reload, pageActive]);

  return { view, error, order, move, reload };
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
