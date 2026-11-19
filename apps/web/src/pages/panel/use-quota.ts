import { useCallback, useEffect, useMemo, useState } from "react";
import type { QuotaView } from "@you-brain/core/http/types.js";

import { useDaemon } from "../../daemon-context.js";
import { quotaCards, type QuotaCardView } from "./quota.js";
import { useQuotaSelection } from "./use-quota-selection.js";

/**
 * Polls `/api/quota` and turns it into the cards to show. The daemon's first read takes
 * about ten seconds, so it polls quickly until numbers land, then every 30 seconds.
 */
export function useQuota(): { quota: QuotaView | null; cards: QuotaCardView[]; nowMs: number; reload: () => Promise<void> } {
  const { client, status, language } = useDaemon();
  const [quota, setQuota] = useState<QuotaView | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { selected } = useQuotaSelection(status?.captures, nowMs);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setQuota(await client.quota());
    } catch {
      // Works without allowances; the next poll tries again.
    }
    setNowMs(Date.now());
  }, [client]);
  const loaded = quota?.readAt != null;
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), loaded ? 30_000 : 4_000);
    return () => clearInterval(timer);
  }, [reload, loaded]);
  const cards = useMemo(
    () => quotaCards(quota, selected, nowMs, language),
    [quota, selected, nowMs, language],
  );
  return { quota, cards, nowMs, reload };
}
