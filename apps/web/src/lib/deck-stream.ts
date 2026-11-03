/**
 * 指挥台主控回答的流式增量（SSE deck 事件的 deckDelta）走这个进程内单例，
 * 不进 React context——增量每 250ms 一条，进 context 会把整棵树拖着重渲染。
 * 指挥台页面自己订阅。
 */
type DeckDeltaListener = (conversationId: string, text: string) => void;

const listeners = new Set<DeckDeltaListener>();

export function emitDeckDelta(conversationId: string, text: string): void {
  for (const listener of listeners) listener(conversationId, text);
}

export function subscribeDeckDelta(listener: DeckDeltaListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
