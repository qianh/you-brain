import { useSyncExternalStore } from "react";

import type { FocusRequest } from "./block-editor.js";

/** 请求的块若始终没出现(例如已被删除),超时后清掉,别让它在以后意外抢走光标。 */
const FOCUS_TTL_MS = 1500;

/**
 * 焦点请求的小 store:只通知目标块所在的行。
 * 以前焦点放在页面 state 里逐层下传,每次回车、移动光标都会让所有行重渲染。
 */
export interface FocusStore {
  /** 请求把光标放到某一块;每次请求都是新对象,同一块连续请求也会再次触发。 */
  request(request: FocusRequest): void;
  /** 目标行处理完焦点后调用。 */
  clear(): void;
  /** 这一块当前的焦点请求;不是它的返回 null(引用在请求不变时保持稳定)。 */
  forBlock(blockId: string): FocusRequest | null;
  subscribe(blockId: string, listener: () => void): () => void;
}

export function createFocusStore(): FocusStore {
  let current: FocusRequest | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Map<string, Set<() => void>>();

  const notify = (blockId: string | undefined): void => {
    if (blockId === undefined) return;
    for (const listener of listeners.get(blockId) ?? []) listener();
  };

  const set = (next: FocusRequest | null): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    const previous = current;
    current = next;
    if (next) timer = setTimeout(() => store.clear(), FOCUS_TTL_MS);
    notify(previous?.blockId);
    if (next && next.blockId !== previous?.blockId) notify(next.blockId);
  };

  const store: FocusStore = {
    request: (request) => set({ ...request }),
    clear: () => {
      if (current !== null) set(null);
    },
    forBlock: (blockId) => (current?.blockId === blockId ? current : null),
    subscribe: (blockId, listener) => {
      let group = listeners.get(blockId);
      if (!group) {
        group = new Set();
        listeners.set(blockId, group);
      }
      const mine = group;
      mine.add(listener);
      return () => {
        mine.delete(listener);
        if (mine.size === 0) listeners.delete(blockId);
      };
    },
  };
  return store;
}

/** 这一块被请求聚焦时返回请求,否则 null;只有目标块会因此重渲染。 */
export function useBlockFocus(store: FocusStore, blockId: string): FocusRequest | null {
  return useSyncExternalStore(
    (listener) => store.subscribe(blockId, listener),
    () => store.forBlock(blockId),
    () => null,
  );
}
