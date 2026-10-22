import { Banner } from "../../components/banner.js";
import { Button } from "../../components/button.js";
import { Section } from "../../components/card.js";
import type { MessageKey } from "../../i18n/messages.js";
import type { AttentionItem } from "./logic.js";

export function AttentionList({
  items,
  syncing,
  loginBusy,
  t,
  onSync,
  onModel,
  onLogin,
}: {
  items: readonly AttentionItem[];
  syncing: boolean;
  loginBusy: boolean;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  onSync: () => void;
  onModel: () => void;
  onLogin: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <Section title={t("statusNeedsTitle")}>
      <div className="status-banners">
        {items.map((item) => (
          <Banner
            key={item.key}
            tone="warn"
            {...(item.action === "none"
              ? {}
              : {
                  action: (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={(item.action === "sync" && syncing) || (item.action === "login" && loginBusy)}
                      onClick={item.action === "sync" ? onSync : item.action === "model" ? onModel : onLogin}
                    >
                      {item.action === "sync"
                        ? t("cmdSync")
                        : item.action === "model"
                          ? t("statusModelSettings")
                          : t("statusGoLogin")}
                    </Button>
                  ),
                })}
          >
            <span title={item.code}>{item.message}</span>
          </Banner>
        ))}
      </div>
    </Section>
  );
}
