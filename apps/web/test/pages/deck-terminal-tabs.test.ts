import { describe, expect, test } from "bun:test";

import {
  closeTab,
  cycleTab,
  EMPTY_TABS,
  hideScreen,
  openTab,
  pruneTabs,
  terminalShortcut,
  type TerminalTabs,
} from "../../src/pages/deck-terminal-tabs.js";

const tabs = (open: number[], active: number | null): TerminalTabs => ({ open, active });

describe("deck terminal tabs", () => {
  test("openTab 追加并切换；重复打开只切换", () => {
    const one = openTab(EMPTY_TABS, 1);
    expect(one).toEqual({ open: [1], active: 1 });
    const two = openTab(one, 2);
    expect(two).toEqual({ open: [1, 2], active: 2 });
    expect(openTab(two, 1)).toEqual({ open: [1, 2], active: 1 });
  });

  test("openTab 对已显示的当前标签返回同一个对象", () => {
    const state = tabs([1, 2], 2);
    expect(openTab(state, 2)).toBe(state);
  });

  test("closeTab 关当前标签时先右后左", () => {
    expect(closeTab(tabs([1, 2, 3], 2), 2)).toEqual({ open: [1, 3], active: 3 });
    expect(closeTab(tabs([1, 2], 2), 2)).toEqual({ open: [1], active: 1 });
  });

  test("closeTab 关最后一个标签后 active 为 null", () => {
    expect(closeTab(tabs([5], 5), 5)).toEqual({ open: [], active: null });
  });

  test("closeTab 关非当前标签不改变 active", () => {
    expect(closeTab(tabs([1, 2, 3], 2), 3)).toEqual({ open: [1, 2], active: 2 });
  });

  test("closeTab 关返回后隐藏的标签时 active 仍为 null", () => {
    expect(closeTab(tabs([1, 2], null), 1)).toEqual({ open: [2], active: null });
  });

  test("closeTab 关不存在的标签返回同一个对象", () => {
    const state = tabs([1, 2], 1);
    expect(closeTab(state, 9)).toBe(state);
  });

  test("hideScreen 保留标签", () => {
    expect(hideScreen(tabs([1, 2], 2))).toEqual({ open: [1, 2], active: null });
  });

  test("pruneTabs 移除已不存在的会话并重选当前标签", () => {
    expect(pruneTabs(tabs([1, 2, 3], 2), new Set([1, 3]))).toEqual({ open: [1, 3], active: 3 });
  });

  test("pruneTabs 当前标签仍在时保持不变", () => {
    expect(pruneTabs(tabs([1, 2, 3], 3), new Set([2, 3]))).toEqual({ open: [2, 3], active: 3 });
  });

  test("pruneTabs 全部消失后 active 为 null", () => {
    expect(pruneTabs(tabs([1, 2], 1), new Set<number>())).toEqual({ open: [], active: null });
  });

  test("pruneTabs 无变化时返回同一个对象", () => {
    const state = tabs([1, 2], 2);
    expect(pruneTabs(state, new Set([1, 2, 3]))).toBe(state);
  });

  test("cycleTab 在标签间循环，首尾相接", () => {
    const state = tabs([1, 2, 3], 3);
    expect(cycleTab(state, 1)).toEqual({ open: [1, 2, 3], active: 1 });
    expect(cycleTab(tabs([1, 2, 3], 1), -1)).toEqual({ open: [1, 2, 3], active: 3 });
    expect(cycleTab(tabs([1, 2, 3], 2), 1).active).toBe(3);
  });

  test("cycleTab 只有一个标签或没有当前标签时不变", () => {
    const single = tabs([1], 1);
    expect(cycleTab(single, 1)).toBe(single);
    const hidden = tabs([1, 2], null);
    expect(cycleTab(hidden, 1)).toBe(hidden);
  });
});

describe("terminalShortcut", () => {
  const key = (key: string, extra: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) =>
    ({ key, meta: false, ctrl: false, alt: false, shift: false, ...extra });

  test("⌘⇧D 返回（macOS）", () => {
    expect(terminalShortcut(key("D", { meta: true, shift: true }), "meta")).toBe("back");
    expect(terminalShortcut(key("d", { meta: true, shift: true }), "meta")).toBe("back");
  });

  test("非 macOS 用 Ctrl+Shift+D，且 ⌘ 不触发", () => {
    expect(terminalShortcut(key("D", { ctrl: true, shift: true }), "ctrl")).toBe("back");
    expect(terminalShortcut(key("D", { meta: true, shift: true }), "ctrl")).toBeNull();
  });

  test("Ctrl+Tab 向右、Ctrl+Shift+Tab 向左", () => {
    expect(terminalShortcut(key("Tab", { ctrl: true }), "meta")).toBe("next");
    expect(terminalShortcut(key("Tab", { ctrl: true, shift: true }), "meta")).toBe("previous");
  });

  test("Esc、Tab、⌘D、Ctrl+D 等其余按键不拦", () => {
    expect(terminalShortcut(key("Escape"), "meta")).toBeNull();
    expect(terminalShortcut(key("Tab"), "meta")).toBeNull();
    expect(terminalShortcut(key("d", { meta: true }), "meta")).toBeNull();
    expect(terminalShortcut(key("d", { ctrl: true }), "meta")).toBeNull();
    expect(terminalShortcut(key("c", { ctrl: true }), "meta")).toBeNull();
    expect(terminalShortcut(key("d", { meta: true, shift: true, alt: true }), "meta")).toBeNull();
  });

  test("⌘= 和 ⌘+（带 Shift）放大，⌘- 缩小，⌘0 恢复默认", () => {
    expect(terminalShortcut(key("=", { meta: true }), "meta")).toBe("fontUp");
    expect(terminalShortcut(key("+", { meta: true, shift: true }), "meta")).toBe("fontUp");
    expect(terminalShortcut(key("-", { meta: true }), "meta")).toBe("fontDown");
    expect(terminalShortcut(key("0", { meta: true }), "meta")).toBe("fontReset");
    // 有的键盘布局上 + 不用 Shift。
    expect(terminalShortcut(key("+", { meta: true }), "meta")).toBe("fontUp");
  });

  test("非 macOS 用 Ctrl，⌘ 不触发", () => {
    expect(terminalShortcut(key("=", { ctrl: true }), "ctrl")).toBe("fontUp");
    expect(terminalShortcut(key("-", { ctrl: true }), "ctrl")).toBe("fontDown");
    expect(terminalShortcut(key("0", { ctrl: true }), "ctrl")).toBe("fontReset");
    expect(terminalShortcut(key("=", { meta: true }), "ctrl")).toBeNull();
  });

  test("字号快捷键不吞别的组合：裸 =、-、0，macOS 上的 Ctrl+-，带 Alt、同时按两个修饰键", () => {
    expect(terminalShortcut(key("="), "meta")).toBeNull();
    expect(terminalShortcut(key("-"), "meta")).toBeNull();
    expect(terminalShortcut(key("0"), "meta")).toBeNull();
    expect(terminalShortcut(key("-", { ctrl: true }), "meta")).toBeNull();
    expect(terminalShortcut(key("=", { ctrl: true }), "meta")).toBeNull();
    expect(terminalShortcut(key("=", { meta: true, alt: true }), "meta")).toBeNull();
    expect(terminalShortcut(key("=", { meta: true, ctrl: true }), "meta")).toBeNull();
    expect(terminalShortcut(key("_", { meta: true, shift: true }), "meta")).toBeNull();
    expect(terminalShortcut(key(")", { meta: true, shift: true }), "meta")).toBeNull();
  });
});
