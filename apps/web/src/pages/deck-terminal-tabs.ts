import { isReferenceShortcut } from "./deck-reference-logic.js";

/**
 * 整屏终端的标签状态：open 是本次运行里打开过的会话（跨项目），active 是当前显示的那个。
 * active 为 null 表示整屏终端被「返回」收起，但标签还在。
 * 全部是纯函数；没有变化时返回原对象，避免无谓重渲染。
 */
export interface TerminalTabs {
  open: number[];
  active: number | null;
}

export const EMPTY_TABS: TerminalTabs = { open: [], active: null };

/** 已在标签里则只切换，不在则追加到末尾并切换。 */
export function openTab(state: TerminalTabs, pane: number): TerminalTabs {
  if (state.open.includes(pane)) return state.active === pane ? state : { open: state.open, active: pane };
  return { open: [...state.open, pane], active: pane };
}

/** 关标签：关的是当前标签时先切右邻，没有右邻切左邻，都没有则 active 为 null。 */
export function closeTab(state: TerminalTabs, pane: number): TerminalTabs {
  const index = state.open.indexOf(pane);
  if (index < 0) return state;
  const open = state.open.filter((item) => item !== pane);
  if (state.active !== pane) return { open, active: state.active };
  return { open, active: open[index] ?? open[index - 1] ?? null };
}

/** 「返回」：收起整屏终端，标签保留。 */
export function hideScreen(state: TerminalTabs): TerminalTabs {
  return state.active === null ? state : { open: state.open, active: null };
}

/** 去掉已经不存在的会话；当前标签被去掉时按 closeTab 的规则选下一个。 */
export function pruneTabs(state: TerminalTabs, live: ReadonlySet<number>): TerminalTabs {
  let next = state;
  for (const pane of state.open) {
    if (!live.has(pane)) next = closeTab(next, pane);
  }
  return next;
}

/** Ctrl+Tab 切换：在标签间循环，首尾相接。没有当前标签或只有一个标签时不变。 */
export function cycleTab(state: TerminalTabs, step: 1 | -1): TerminalTabs {
  if (state.active === null || state.open.length < 2) return state;
  const index = state.open.indexOf(state.active);
  if (index < 0) return state;
  const target = state.open[(index + step + state.open.length) % state.open.length];
  return target === undefined ? state : { open: state.open, active: target };
}

export type TerminalShortcut = "back" | "next" | "previous" | "fontUp" | "fontDown" | "fontReset" | "reference";

/**
 * 整屏终端只拦这几个按键：⌘⇧D（非 macOS 为 Ctrl+Shift+D）返回，⌘⇧2 / ⌘⇧@ 打开 @ 引用，
 * Ctrl+Tab / Ctrl+Shift+Tab 切标签，⌘= 或 ⌘+ 放大、⌘- 缩小、⌘0 恢复默认字号（非 macOS 用 Ctrl）。
 * 其余按键（包括 Esc 与裸 @）一律返回 null，原样交给 xterm。
 */
export function terminalShortcut(
  event: { key: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean },
  mod: "meta" | "ctrl",
): TerminalShortcut | null {
  if (event.alt) return null;
  if (event.key === "Tab" && event.ctrl && !event.meta) return event.shift ? "previous" : "next";
  if (isReferenceShortcut(event, mod)) return "reference";
  const modDown = mod === "meta" ? event.meta && !event.ctrl : event.ctrl && !event.meta;
  if (!modDown) return null;
  if (event.shift && event.key.toLowerCase() === "d") return "back";
  // 「+」在有的键盘布局上不用 Shift，所以放大不看 Shift；缩小和恢复则不能带 Shift（那是 _ 和 )）。
  if (event.key === "=" || event.key === "+") return "fontUp";
  if (event.shift) return null;
  if (event.key === "-") return "fontDown";
  if (event.key === "0") return "fontReset";
  return null;
}
