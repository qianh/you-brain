export interface WindowBridge {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  open: (url: string, target: string, features: string) => Window | null;
  pageUrl: string;
}

export async function openFullWindow(
  bridge: WindowBridge,
): Promise<"tauri" | "browser" | "blocked"> {
  if (bridge.invoke) {
    await bridge.invoke("open_main_window");
    return "tauri";
  }
  const url = new URL("/", bridge.pageUrl).toString();
  const opened = bridge.open(url, "you-brain-main", "width=1100,height=760");
  return opened ? "browser" : "blocked";
}

export function browserWindowBridge(): WindowBridge {
  const invoke = window.__TAURI__?.core?.invoke;
  return {
    ...(invoke ? { invoke } : {}),
    open: (url, target, features) => window.open(url, target, features),
    pageUrl: window.location.href,
  };
}
