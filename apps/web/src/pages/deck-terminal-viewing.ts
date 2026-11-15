/** 整屏终端每隔这么久向 daemon 报一次「正在看的会话」；daemon 侧 15 秒不更新就当没人在看。 */
export const VIEWING_REPORT_MS = 5_000;

/**
 * 此刻算不算「正在看」某个会话：必须有会话显示在整屏里、窗口有焦点、页面可见。
 * 返回要上报的会话编号；都不满足返回 null。
 */
export function viewingTarget(active: number | null, windowFocused: boolean, pageVisible: boolean): number | null {
  return active !== null && windowFocused && pageVisible ? active : null;
}
