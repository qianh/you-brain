import { Tooltip } from "./tooltip.js";
import type { Language } from "../lib/format.js";
import { resetIn, shortWindowLabel, type QuotaCardView } from "../pages/panel/quota.js";

/** Always renders its box so the top bar grid keeps four columns. One line of allowances for the top bar: "Claude Code 5h 31% 7d 54%"; resets in the tooltip. */
export function QuotaStrip({
  cards,
  nowMs,
  language,
}: {
  cards: readonly QuotaCardView[];
  nowMs: number;
  language: Language;
}) {
  return (
    <div className="quota-strip">
      {cards.map((card) => (
        <Tooltip
          key={card.agent}
          content={
            <span className="quota-strip-tip">
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
          <span className="quota-strip-item" tabIndex={0}>
            <span className="quota-strip-name">{card.label}</span>
            {card.windows.map((window) => (
              <span key={window.name} className="quota-strip-window" data-tone={window.tone}>
                {shortWindowLabel(window.name)} {Math.round(window.used)}%
              </span>
            ))}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}
