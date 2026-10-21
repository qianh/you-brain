import { describe, expect, test } from "bun:test";

import { isTextEntry, matchShortcut, modLabel, shortcutMod, type ShortcutEvent } from "../../src/lib/shortcuts.js";

function event(patch: Partial<ShortcutEvent>): ShortcutEvent {
  return {
    key: "k",
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    targetIsText: false,
    ...patch,
  };
}

describe("shortcutMod", () => {
  test("uses meta on Apple platforms and ctrl elsewhere", () => {
    expect(shortcutMod("MacIntel")).toBe("meta");
    expect(shortcutMod("iPhone")).toBe("meta");
    expect(shortcutMod("iPad")).toBe("meta");
    expect(shortcutMod("Win32")).toBe("ctrl");
    expect(shortcutMod("Linux x86_64")).toBe("ctrl");
    expect(modLabel("meta")).toBe("⌘");
    expect(modLabel("ctrl")).toBe("Ctrl");
  });
});

describe("matchShortcut", () => {
  test("matches chords inside fields and ignores single keys there", () => {
    expect(matchShortcut(event({ meta: true, targetIsText: true }), "meta")).toEqual({ type: "palette" });
    expect(matchShortcut(event({ key: "/", targetIsText: true }), "meta")).toBe(null);
    expect(matchShortcut(event({ key: "/" }), "meta")).toEqual({ type: "slash" });
    expect(matchShortcut(event({ key: "/", meta: true }), "meta")).toBe(null);
  });

  test("maps navigation, settings, refresh, and escape", () => {
    expect(matchShortcut(event({ key: "1", meta: true }), "meta")).toEqual({ type: "nav", index: 1 });
    expect(matchShortcut(event({ key: "6", ctrl: true }), "ctrl")).toEqual({ type: "nav", index: 6 });
    expect(matchShortcut(event({ key: ",", meta: true }), "meta")).toEqual({ type: "settings" });
    expect(matchShortcut(event({ key: "r", meta: true }), "meta")).toEqual({ type: "refresh" });
    expect(matchShortcut(event({ key: "Escape", targetIsText: true }), "meta")).toEqual({ type: "escape" });
  });

  test("rejects the wrong modifier, shift, and alt", () => {
    expect(matchShortcut(event({ ctrl: true }), "meta")).toBe(null);
    expect(matchShortcut(event({ meta: true, shift: true }), "meta")).toBe(null);
    expect(matchShortcut(event({ meta: true, alt: true }), "meta")).toBe(null);
    expect(matchShortcut(event({ key: "k" }), "meta")).toBe(null);
  });
});

describe("isTextEntry", () => {
  test("recognizes fields and ignores ordinary nodes", () => {
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntry({ tagName: "textarea" })).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false);
  });
});
