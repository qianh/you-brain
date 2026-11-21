import type { ReactNode } from "react";
import type { QuotaTokenUsage } from "@you-brain/core/http/types.js";

import { formatDateTime, type Language } from "../../lib/format.js";
import type { MessageKey } from "../../i18n/messages.js";
import { minutesAgo, resetIn, tokenCount, type QuotaCardView } from "./quota.js";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * 每个模型一组：名称、套餐、各窗口的用量条与重置时间，以及 Token 消耗。
 * 面板的额度卡和顶栏额度条的悬浮详情共用这一份。
 */
export function QuotaGroups({
  cards,
  nowMs,
  language,
  timeZone,
  t,
  hideCardStale = false,
}: {
  cards: readonly QuotaCardView[];
  nowMs: number;
  language: Language;
  timeZone: string;
  t: Translate;
  /** 外层已经整体标了"几分钟前"时，单个模型不再重复标。 */
  hideCardStale?: boolean;
}) {
  return (
    <>
      {cards.map((card) => (
        <div key={card.agent} className="quota-group">
          <div className="quota-head">
            <span className="quota-name">{card.label}</span>
            {card.plan ? <span className="quota-plan">{card.plan}</span> : null}
            {card.stale && !hideCardStale && card.readAt !== null ? (
              <span className="quota-plan quota-card-stale">{t("panelQuotaStale", { minutes: minutesAgo(card.readAt, nowMs) })}</span>
            ) : null}
          </div>
          {card.windows.map((window) => {
            const reset = resetIn(window.resetsAt, nowMs, language);
            return (
              <div
                key={window.name}
                className="quota-row"
                title={window.resetsAt ? formatDateTime(window.resetsAt, language, timeZone) : undefined}
              >
                <span className="quota-window">{window.label}</span>
                <span
                  className="quota-bar"
                  role="progressbar"
                  aria-label={`${card.label} ${window.label}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(window.used)}
                >
                  <i data-tone={window.tone} style={{ width: `${window.used}%` }} />
                </span>
                <span className="quota-pct">{Math.round(window.used)}%</span>
                <span className="quota-reset">{reset ?? ""}</span>
              </div>
            );
          })}
          {card.tokens !== undefined ? tokenRows(card.tokens, t) : null}
          {card.windows.length === 0 && card.tokens === undefined ? (
            <div className="quota-row">
              <span className="quota-window">{t("panelQuotaNone")}</span>
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

/** 卡片上 Token 消耗的三行，按今天 → 近 3 天 → 近 7 天排列。 */
const TOKEN_SPANS: ReadonlyArray<{ span: keyof QuotaTokenUsage; labelKey: MessageKey }> = [
  { span: "today", labelKey: "panelQuotaTokensToday" },
  { span: "threeDays", labelKey: "panelQuotaTokens3d" },
  { span: "sevenDays", labelKey: "panelQuotaTokens7d" },
];

function tokenRows(usage: QuotaTokenUsage, t: Translate): ReactNode {
  return TOKEN_SPANS.map(({ span, labelKey }) => {
    const tokens = usage[span];
    return (
      <div key={span} className="quota-row">
        <span className="quota-window">{t(labelKey)}</span>
        <span className="quota-balance" title={`${tokens.input} → ${tokens.output} · cache ${tokens.cacheRead}`}>
          {tokenCount(tokens.total)}
        </span>
      </div>
    );
  });
}
