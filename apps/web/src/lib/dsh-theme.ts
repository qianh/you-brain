import type { ResolvedTheme } from "./theme.js";

/**
 * DSH iframe 跨源，读不到宿主的主题；由 u-brain-brand 插件的浏览器半边开口要，宿主回 `u-brain:theme`。
 * 只接受当前 DSH iframe 的请求，避免别的窗口借此探测。
 */
export function isDshThemeRequest(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  frame: Window | null | undefined,
  dshUrl: string,
): boolean {
  if (!frame || event.source !== frame || event.origin !== new URL(dshUrl).origin) return false;
  return event.data?.type === "u-brain:theme:request";
}

export function dshThemeMessage(theme: ResolvedTheme): { type: "u-brain:theme"; theme: ResolvedTheme } {
  return { type: "u-brain:theme", theme };
}
