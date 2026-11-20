/**
 * 在终端容器的 keydown 捕获阶段跳过单独的 Shift，让浏览器继续处理输入法。
 * WebKit 可能在字符 keydown 之前提交「？」；xterm 6 会因先前的 Shift 错把它去重丢掉。
 * 不 preventDefault，字符事件仍带 shiftKey；不用 xterm 的 custom handler（此时已设置去重标记）。
 * 上游修复：https://github.com/xtermjs/xterm.js/pull/6200
 */
/**
 * U-Brain 引用的操作符。不用 `@`：`@` 留给 CLI / T3 自己的文件菜单。
 * `%` 在 Claude、Codex、Grok、Gemini、T3 里都不是快捷符号。
 */
export const REFERENCE_TRIGGER = "%";

/** 单独一个 `%` 或中文输入法的全角 `％`。 */
export function isReferenceTriggerChar(text: string): boolean {
  return text === REFERENCE_TRIGGER || text === "％";
}

/**
 * AI CLI 会话里单独敲下的 `%` 改由 U-Brain 引用选择器接管；
 * 紧跟在数字后面（如 `50%`）、粘贴进来的整段文本、`passthrough`（用户取消选择器后把 % 还给 CLI）不拦截。
 */
export function isReferenceTrigger(text: string, enabled: boolean, passthrough: boolean, previous = ""): boolean {
  return enabled && !passthrough && isReferenceTriggerChar(text) && !/[0-9]$/.test(previous);
}

export function preserveTerminalImeInput(event: Pick<KeyboardEvent, "key" | "stopPropagation">): void {
  if (event.key === "Shift") event.stopPropagation();
}

export function terminalDroppedPaths(paths: unknown): string | null {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const words: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || !path.startsWith("/") || /\p{Cc}/u.test(path)) return null;
    words.push(/^[\p{L}\p{N}/._-]+$/u.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`);
  }
  return `${words.join(" ")} `;
}
