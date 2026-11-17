import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { parseAppLocation, type AppLocation } from "./lib/route.js";

interface RouterValue {
  href: string;
  location: AppLocation;
  navigate: (to: string, mode?: "push" | "replace") => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function Router({ children }: { children: ReactNode }) {
  const [href, setHref] = useState(currentHref);
  useEffect(() => {
    const onPop = (): void => setHref(currentHref());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string, mode: "push" | "replace" = "push") => {
    if (mode === "replace") window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setHref(currentHref());
  }, []);
  const value: RouterValue = { href, location: parseAppLocation(href), navigate };
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

/**
 * 隐藏的常驻页面用：`frozen` 时保持隐藏那一刻的地址。路由里的 `id` 是通用参数（话题、知识库页都用），
 * 不冻结的话，隐藏的页面会拿别的页面的 id 去加载、清掉自己的选中状态。
 */
export function FrozenRoute({ frozen, children }: { frozen: boolean; children: ReactNode }) {
  const live = useContext(RouterContext);
  const held = useRef(live);
  if (!frozen) held.current = live;
  return <RouterContext.Provider value={held.current}>{children}</RouterContext.Provider>;
}

export function useRoute(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRoute must be used inside Router");
  return value;
}
