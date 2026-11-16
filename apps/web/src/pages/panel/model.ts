import type { ShortcutEvent, ShortcutMod } from "../../lib/shortcuts.js";

export type PanelShortcut = "close" | "open" | "refresh";

export function panelShortcut(event: ShortcutEvent, mod: ShortcutMod): PanelShortcut | null {
  if (event.key === "Escape" && !event.meta && !event.ctrl && !event.alt && !event.shift) return "close";
  const modified = mod === "meta" ? event.meta : event.ctrl;
  const other = mod === "meta" ? event.ctrl : event.meta;
  if (!modified || other || event.alt || event.shift) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === "o") return "open";
  if (key === "r") return "refresh";
  return null;
}
