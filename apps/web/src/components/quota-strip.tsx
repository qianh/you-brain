import { useEffect, useState } from "react";

import { Tooltip } from "./tooltip.js";
import type { Language } from "../lib/format.js";
import { minutesAgo, resetIn, shortWindowLabel, tokenCount, type QuotaCardView } from "../pages/panel/quota.js";

/** How long each model stays in the top bar before the next one. */
export const QUOTA_ROTATE_MS = 5_000;

/** Which card shows after `index`, wrapping round; 0 when there are none. */
export function nextQuotaIndex(index: number, count: number): number {
  return count <= 0 ? 0 : (index + 1) % count;
}

/**
 * The top bar's allowances, one model at a time: "Claude Code 5h 31% 7d 54%", rotating every
 * five seconds and holding still under the pointer or keyboard focus. Resets are in the tooltip.
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
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const count = cards.length;
  useEffect(() => {
    if (count < 2 || held) return;
    const timer = setInterval(() => setIndex((value) => nextQuotaIndex(value, count)), QUOTA_ROTATE_MS);
    return () => clearInterval(timer);
  }, [count, held]);
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
        <Tooltip
          content={
            <span className="quota-strip-tip">
              {card.stale ? (
                <span>{language === "zh" ? `${minutesAgo(card.readAt, nowMs)} 分钟前的数据` : `From ${minutesAgo(card.readAt, nowMs)} min ago`}</span>
              ) : null}
              {card.windows.map((window) => {
                const reset = resetIn(window.resetsAt, nowMs, language);
                return (
                  <span key={window.name}>
                    {window.label} {Math.round(window.used)}%{reset ? ` · ${reset}` : ""}
                  </span>
                );
              })}
            </span>
          }
        >
          <span key={card.agent} className={card.stale ? "quota-strip-item is-stale" : "quota-strip-item"} tabIndex={0}>
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
        </Tooltip>
      ) : null}
    </div>
  );
}
