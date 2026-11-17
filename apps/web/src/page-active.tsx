import { createContext, useContext } from "react";

/**
 * 主导航页面常驻挂载（app.tsx 的 KeepAlive），切走只隐藏。隐藏的页面应暂停轮询和上报，
 * 切回时立即拉一次。不在 KeepAlive 里的页面（搜索、设置、面板……）始终视为激活。
 */
export const PageActiveContext = createContext(true);

export function usePageActive(): boolean {
  return useContext(PageActiveContext);
}
