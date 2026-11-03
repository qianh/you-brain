import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * CJK 输入法安全：组词期间的 Enter 是确认候选词，不是发送/分块。
 * WKWebView(Safari) 还会在 compositionend 之后才补发那条确认用的
 * Enter keydown（isComposing 已变 false），所以再认 50ms 内的「刚结束」。
 */
export function useImeGuard() {
  const state = useRef({ active: false, endedAt: -Infinity });
  const onCompositionStart = useCallback(() => {
    state.current.active = true;
  }, []);
  const onCompositionEnd = useCallback((event: { timeStamp: number }) => {
    state.current.active = false;
    state.current.endedAt = event.timeStamp;
  }, []);
  const isComposing = useCallback((event: ReactKeyboardEvent): boolean => {
    return (
      event.nativeEvent.isComposing ||
      state.current.active ||
      event.timeStamp - state.current.endedAt < 50
    );
  }, []);
  /** 不依赖具体按键事件:此刻是否还在组词。 */
  const isComposingNow = useCallback((): boolean => state.current.active, []);
  return { onCompositionStart, onCompositionEnd, isComposing, isComposingNow };
}
