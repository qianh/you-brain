import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { DECK_VIEW_KEY, DECK_VIEWS, deckViewHref, isDeckView, type DeckView } from "../lib/deck-view.js";
import { prefs } from "../lib/prefs.js";

/** 快捷栏中心点在窗口高度上的比例；窗口缩放后仍在相对位置。 */
const RAIL_TOP_KEY = "you-brain.deck.rail-top";
const DEFAULT_TOP = 0.5;

function lastDeckView(): DeckView {
  try {
    const stored = prefs.getItem(DECK_VIEW_KEY);
    return isDeckView(stored) ? stored : "t3";
  } catch {
    return "t3";
  }
}

function storedTop(): number {
  try {
    const value = Number(prefs.getItem(RAIL_TOP_KEY));
    return Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_TOP;
  } catch {
    return DEFAULT_TOP;
  }
}

/** 中心点比例换成像素，并夹在窗口内，保证整条快捷栏可见。 */
function clampTop(ratio: number, height: number): number {
  const half = height / 2 + 8;
  return Math.min(Math.max(ratio * window.innerHeight, half), Math.max(half, window.innerHeight - half));
}

/**
 * 离开指挥台后，T3 / DSH / Muse 悬浮在窗口左侧，平时只露出 10px，悬停展开（样式见 shell.css）；点一下回到指挥台的对应页面；
 * 按住顶部把手可上下拖动，位置会记住。
 */
export function DeckRail({ label, moveLabel, onOpen }: { label: string; moveLabel: string; onOpen: (href: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const [ratio, setRatio] = useState(storedTop);
  const [dragging, setDragging] = useState(false);
  const [, setViewport] = useState(0);
  const current = lastDeckView();

  useEffect(() => {
    const onResize = (): void => setViewport(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const offset = event.clientY - clampTop(ratio, ref.current?.offsetHeight ?? 0);
    let next = ratio;
    const move = (moveEvent: PointerEvent): void => {
      next = Math.min(Math.max((moveEvent.clientY - offset) / window.innerHeight, 0.01), 0.99);
      setRatio(next);
    };
    const end = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setDragging(false);
      try { prefs.setItem(RAIL_TOP_KEY, next.toFixed(4)); } catch { /* 记不住位置不影响使用 */ }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <nav
      ref={ref}
      className={dragging ? "deck-rail is-dragging" : "deck-rail"}
      aria-label={label}
      style={{ top: clampTop(ratio, ref.current?.offsetHeight ?? 0) }}
    >
      <button type="button" className="deck-rail-grip" aria-label={moveLabel} title={moveLabel} tabIndex={-1} onPointerDown={startDrag}>
        <span /><span /><span />
      </button>
      {DECK_VIEWS.map((item) => (
        <a
          key={item.value}
          href={deckViewHref(item.value)}
          className={item.value === current ? "deck-rail-item is-current" : "deck-rail-item"}
          onClick={(event) => {
            event.preventDefault();
            onOpen(deckViewHref(item.value));
          }}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
