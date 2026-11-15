export interface TerminalReference {
  pane: number;
  workspaceId: string;
  tabId: string;
}

type ReferenceMessage = { type: "ready" } | ({ type: "open" } & TerminalReference);

/** 只接受当前 DSH iframe 的消息，其他窗口和旧 DSH 端口都不能打开终端。 */
export function terminalReferenceMessage(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  frame: Window | null | undefined,
  dshUrl: string,
): ReferenceMessage | null {
  if (!frame || event.source !== frame || event.origin !== new URL(dshUrl).origin) return null;
  const data = event.data;
  if (data?.type === "u-brain:terminal-reference:ready") return { type: "ready" };
  if (data?.type !== "u-brain:terminal-reference:open" || !Number.isSafeInteger(data.pane) || data.pane < 0 ||
    typeof data.workspaceId !== "string" || !data.workspaceId || typeof data.tabId !== "string" || !data.tabId) return null;
  return { type: "open", pane: data.pane, workspaceId: data.workspaceId, tabId: data.tabId };
}
