import { t3ThreadFrameUrl } from "./route.js";

/**
 * T3 iframe 的地址：daemon 给了转发地址（frameUrl）就走转发，转发里才有多巴胺底色和输入框 @ 引用；
 * 会话链接仍按 T3 自己的地址校验，再把源换成转发地址。
 */
export function t3FrameSrc(view: { url: string; frameUrl?: string }, threadUrl: string | null): string {
  const direct = t3ThreadFrameUrl(view.url, threadUrl);
  if (!view.frameUrl) return direct;
  const target = new URL(direct);
  return new URL(`${target.pathname}${target.search}`, view.frameUrl).href;
}

export type T3FrameMessage = "ready" | "open" | "shortcut" | "theme-request";

/** 只接受当前 T3 iframe（同一窗口、同一源）发来的 U-Brain 消息。 */
export function t3FrameMessage(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  frame: HTMLIFrameElement | null | undefined,
): T3FrameMessage | null {
  if (!frame?.contentWindow || event.source !== frame.contentWindow) return null;
  try {
    if (event.origin !== new URL(frame.src).origin) return null;
  } catch {
    return null;
  }
  const type = event.data?.type;
  if (type === "u-brain:t3-ref:ready") return "ready";
  if (type === "u-brain:t3-ref:open") return "open";
  if (type === "u-brain:t3-ref:shortcut") return "shortcut";
  if (type === "u-brain:theme:request") return "theme-request";
  return null;
}
