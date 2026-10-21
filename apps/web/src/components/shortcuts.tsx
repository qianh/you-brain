import { useEffect } from "react";

import { isTextEntry, matchShortcut, shortcutMod, type ShortcutAction } from "../lib/shortcuts.js";

export interface ShortcutHandlers {
  onPalette: () => void;
  /** 1–6, matching the primary tabs from the left. */
  onNav: (index: number) => void;
  onSettings: () => void;
  onRefresh: () => void;
  onSlash: () => void;
  onEscape: () => void;
}

function run(action: ShortcutAction, handlers: ShortcutHandlers): void {
  if (action.type === "palette") handlers.onPalette();
  else if (action.type === "nav") handlers.onNav(action.index);
  else if (action.type === "settings") handlers.onSettings();
  else if (action.type === "refresh") handlers.onRefresh();
  else if (action.type === "slash") handlers.onSlash();
  else handlers.onEscape();
}

export function useShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const action = matchShortcut(
        {
          key: event.key,
          meta: event.metaKey,
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          targetIsText: isTextEntry(event.target),
        },
        shortcutMod(navigator.platform),
      );
      if (!action) return;
      if (action.type !== "escape") event.preventDefault();
      run(action, handlers);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}
