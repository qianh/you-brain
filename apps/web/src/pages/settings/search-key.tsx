import { useCallback, useEffect, useState } from "react";

import type { SearchSettings } from "@you-brain/core/http/types.js";

import { Button } from "../../components/button.js";
import { Card, Section } from "../../components/card.js";
import { Toggle } from "../../components/toggle.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";

type Provider = keyof SearchSettings["providers"];

const PROVIDERS: ReadonlyArray<{ id: Provider; name: string }> = [
  { id: "exa", name: "Exa" },
  { id: "tavily", name: "Tavily" },
];

/**
 * 指挥台的搜索后端：每家一个 Key，只能启用一个；都不启用就走内置的 DeepSeek 搜索。
 * Key 只写不读，界面只知道有没有。
 */
export function SearchKeySection() {
  const { client, t } = useDaemon();
  const { push } = useToast();
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<Provider, string>>({ exa: "", tavily: "" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSettings(await client.searchSettings());
    } catch {
      setSettings(null);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
        await refresh();
      } catch (error) {
        push({ message: error instanceof Error ? error.message : String(error), tone: "danger" });
      } finally {
        setBusy(false);
      }
    },
    [push, refresh],
  );

  const saveKey = (provider: Provider, name: string) =>
    run(async () => {
      const apiKey = drafts[provider].trim();
      if (apiKey === "") return;
      await client.putSearchKey({ provider, apiKey });
      setDrafts((current) => ({ ...current, [provider]: "" }));
      push({ message: t("searchKeySaved", { name }), tone: "success" });
    });

  const setActive = (active: Provider | null) =>
    run(async () => {
      await client.putSearchActive({ active });
    });

  const activeName = PROVIDERS.find((item) => item.id === settings?.active)?.name;

  return (
    <Section title={t("searchTitle")}>
      <Card>
        <div className="notion-form">
          <div className="notion-status">
            <span>{t("searchHint")}</span>
          </div>
          {PROVIDERS.map(({ id, name }) => {
            const hasKey = settings?.providers[id].hasKey === true;
            const draft = drafts[id];
            return (
              <div key={id} className="notion-form">
                <label className="notion-label" htmlFor={`search-key-${id}`}>
                  {name} · {hasKey ? t("searchKeyHas") : t("searchKeyNone")}
                </label>
                <div className="notion-token-row">
                  <input
                    id={`search-key-${id}`}
                    className="notion-input"
                    type="password"
                    autoComplete="off"
                    placeholder={t("searchKeyPlaceholder")}
                    value={draft}
                    onChange={(event) => setDrafts((current) => ({ ...current, [id]: event.target.value }))}
                  />
                  <Button size="sm" onClick={() => void saveKey(id, name)} disabled={busy || draft.trim() === ""}>
                    {t("searchKeySave")}
                  </Button>
                  <Toggle
                    checked={settings?.active === id}
                    label={t("searchEnabled", { name })}
                    disabled={busy || (!hasKey && settings?.active !== id)}
                    onChange={(checked) => void setActive(checked ? id : null)}
                  />
                </div>
                {!hasKey ? (
                  <div className="notion-status">
                    <span>{t("searchNeedKey")}</span>
                  </div>
                ) : null}
              </div>
            );
          })}
          <div className="notion-status">
            <span>{activeName === undefined ? t("searchFallback") : t("searchActive", { name: activeName })}</span>
          </div>
        </div>
      </Card>
    </Section>
  );
}
