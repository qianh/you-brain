/** 终端会话提醒的总开关（偏好键）。daemon 读同一个键：值为 "0" 表示关，其余（含不存在）为开。 */
export const TERMINAL_NOTIFY_KEY = "you-brain.deck.terminal-notify";

export function terminalNotifyOn(stored: string | null): boolean {
  return stored !== "0";
}

/** 要写进偏好的值：关写 "0"；开返回 null，表示删除该键（回到默认的开）。 */
export function terminalNotifyValue(on: boolean): string | null {
  return on ? null : "0";
}
