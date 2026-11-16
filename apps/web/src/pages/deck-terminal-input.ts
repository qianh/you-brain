/**
 * 在终端容器的 keydown 捕获阶段跳过单独的 Shift，让浏览器继续处理输入法。
 * WebKit 可能在字符 keydown 之前提交「？」；xterm 6 会因先前的 Shift 错把它去重丢掉。
 * 不 preventDefault，字符事件仍带 shiftKey；不用 xterm 的 custom handler（此时已设置去重标记）。
 * 上游修复：https://github.com/xtermjs/xterm.js/pull/6200
 */
export function preserveTerminalImeInput(event: Pick<KeyboardEvent, "key" | "stopPropagation">): void {
  if (event.key === "Shift") event.stopPropagation();
}
