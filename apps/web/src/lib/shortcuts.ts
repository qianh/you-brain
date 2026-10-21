export type ShortcutMod = "meta" | "ctrl";

export type ShortcutAction =
  | { type: "palette" }
  | { type: "nav"; index: number }
  | { type: "settings" }
  | { type: "refresh" }
  | { type: "slash" }
  | { type: "escape" };

export interface ShortcutEvent {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** True when focus is in a text field. Single-key shortcuts stay quiet. */
  targetIsText: boolean;
}

export function shortcutMod(platform: string): ShortcutMod {
  return /mac|iphone|ipad/iu.test(platform) ? "meta" : "ctrl";
}

export function modLabel(mod: ShortcutMod): string {
  return mod === "meta" ? "⌘" : "Ctrl";
}

export function isTextEntry(target: EventTarget | { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (target === null || typeof target !== "object") return false;
  if (!("tagName" in target)) return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  if (element.isContentEditable) return true;
  const tag = element.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Chord shortcuts still fire inside fields. `/` and other single keys do not. */
export function matchShortcut(event: ShortcutEvent, mod: ShortcutMod): ShortcutAction | null {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const modified = mod === "meta" ? event.meta : event.ctrl;
  const other = mod === "meta" ? event.ctrl : event.meta;
  if (key === "Escape" && !event.meta && !event.ctrl && !event.alt) return { type: "escape" };
  if (modified && !other && !event.alt && !event.shift) {
    if (key === "k") return { type: "palette" };
    if (key === ",") return { type: "settings" };
    if (key === "r") return { type: "refresh" };
    if (key >= "1" && key <= "6") return { type: "nav", index: Number(key) };
  }
  if (!modified && !other && !event.alt && !event.shift && !event.meta && !event.ctrl) {
    if (key === "/" && !event.targetIsText) return { type: "slash" };
  }
  return null;
}
