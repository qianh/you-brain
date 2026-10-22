import { useCallback, useEffect, useRef } from "react";

import { shouldConfirmLeave } from "./logic.js";

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Blocks in-app history changes while a draft is dirty.
 * `allowNext` lets one navigation through after the user confirms the discard.
 */
export function useLeaveGuard(active: boolean, onBlock: (href: string) => void): { allowNext: () => void } {
  const onBlockRef = useRef(onBlock);
  onBlockRef.current = onBlock;
  const allow = useRef(false);
  const allowNext = useCallback(() => {
    allow.current = true;
  }, []);

  useEffect(() => {
    if (!active) return;
    const pinned = { href: currentHref() };
    const originalPush = history.pushState.bind(history);
    const originalReplace = history.replaceState.bind(history);
    let bypass = false;

    const blocked = (url: string | URL | null | undefined): string | null => {
      if (bypass || allow.current || url === undefined || url === null) return null;
      const next = String(url);
      return shouldConfirmLeave(true, pinned.href, next) ? next : null;
    };

    const remember = (): void => {
      pinned.href = currentHref();
    };

    history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
      if (allow.current) {
        allow.current = false;
        originalPush(data, unused, url);
        remember();
        return;
      }
      const next = blocked(url);
      if (next) {
        onBlockRef.current(next);
        return;
      }
      originalPush(data, unused, url);
      remember();
    }) as typeof history.pushState;

    history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
      if (allow.current) {
        allow.current = false;
        originalReplace(data, unused, url);
        remember();
        return;
      }
      const next = blocked(url);
      if (next) {
        onBlockRef.current(next);
        return;
      }
      originalReplace(data, unused, url);
      remember();
    }) as typeof history.replaceState;

    const onPop = (): void => {
      if (bypass || allow.current) {
        remember();
        return;
      }
      const next = currentHref();
      if (!shouldConfirmLeave(true, pinned.href, next)) {
        pinned.href = next;
        return;
      }
      bypass = true;
      originalPush(null, "", pinned.href);
      bypass = false;
      queueMicrotask(() => {
        bypass = true;
        window.dispatchEvent(new PopStateEvent("popstate"));
        bypass = false;
      });
      onBlockRef.current(next);
    };

    const onUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      history.pushState = originalPush;
      history.replaceState = originalReplace;
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [active]);

  return { allowNext };
}
