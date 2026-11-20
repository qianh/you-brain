import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useDaemon } from "../daemon-context.js";
import type { Language } from "../lib/format.js";
import { QuotaGroups } from "../pages/panel/quota-groups.js";
import { shortWindowLabel, tokenCount, type QuotaCardView } from "../pages/panel/quota.js";

/** How long each model stays in the top bar before the next one. */
export const QUOTA_ROTATE_MS = 5_000;

/** Which card shows after `index`, wrapping round; 0 when there are none. */
export function nextQuotaIndex(index: number, count: number): number {
  return count <= 0 ? 0 : (index + 1) % count;
}

/**
 * The top bar's allowances, one model at a time: "Claude Code 5h 31% 7d 54%", rotating every
 * five seconds and holding still under the pointer or keyboard focus. Hovering (or clicking,
 * since macOS may swallow hover over the title bar) opens every selected model in full:
 * plan, each window with its reset time, and token usage — the same rows as the panel's card.
 * Always renders its box so the top bar layout does not jump when there is nothing to show.
 */
export function QuotaStrip({
  cards,
  nowMs,
  language,
}: {
  cards: readonly QuotaCardView[];
  nowMs: number;
  language: Language;
}) {
  const { t, timeZone } = useDaemon();
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const count = cards.length;
  useEffect(() => {
    if (count < 2 || held || open) return;
    const id = setInterval(() => setIndex((value) => nextQuotaIndex(value, count)), QUOTA_ROTATE_MS);
    return () => clearInterval(id);
  }, [count, held, open]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  const schedule = (next: boolean, delay: number): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), delay);
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos({ visibility: "hidden" });
      return;
    }
    const place = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const pop = popRef.current?.getBoundingClientRect();
      if (!anchor || !pop) return;
      const margin = 8;
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - pop.width));
      setPos({ top: anchor.bottom + 6, left, visibility: "visible" });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, cards]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (anchorRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  const card = cards[index % Math.max(1, count)];
  return (
    <div
      className="quota-strip"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {card ? (
        <span
          key={card.agent}
          ref={anchorRef}
          className={card.stale ? "quota-strip-item is-stale" : "quota-strip-item"}
          tabIndex={0}
          role="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("panelQuotaTitle")}
          onMouseEnter={() => schedule(true, 200)}
          onMouseLeave={() => schedule(false, 200)}
          onClick={() => {
            if (timer.current !== null) window.clearTimeout(timer.current);
            setOpen((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setOpen((value) => !value);
            }
          }}
        >
          <span className="quota-strip-name">{card.label}</span>
          {card.windows.map((window) => (
            <span key={window.name} className="quota-strip-window" data-tone={window.tone}>
              {shortWindowLabel(window.name)} {Math.round(window.used)}%
            </span>
          ))}
          {card.tokens !== undefined ? (
            <span className="quota-strip-window">7d {tokenCount(card.tokens.sevenDays.total)}</span>
          ) : null}
        </span>
      ) : null}
      {open && count > 0
        ? createPortal(
            <div
              ref={popRef}
              className="popover quota-strip-pop"
              role="dialog"
              aria-label={t("panelQuotaTitle")}
              style={pos}
              onMouseEnter={() => schedule(true, 0)}
              onMouseLeave={() => schedule(false, 200)}
            >
              <QuotaGroups cards={cards} nowMs={nowMs} language={language} timeZone={timeZone} t={t} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
