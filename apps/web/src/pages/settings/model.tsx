import { useEffect, useState } from "react";
import type { SharedConfig } from "@you-brain/protocol";

import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { Chip, type ChipTone } from "../../components/chip.js";
import { Input } from "../../components/input.js";
import { Select } from "../../components/select.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { providerLabel, providerNeedsKey, LLM_PROVIDER_IDS } from "../../lib/format.js";
import { ProviderTile } from "../../components/tile.js";
import {
  cliCommand,
  cliProbe,
  isCliProvider,
  providerOptions,
  showStoredKey,
  TEST_RESULT_MS,
  type CliProbe,
} from "./logic.js";
import { SettingRow } from "./setting-row.js";

const PROBE_TONE: Record<CliProbe, ChipTone> = {
  installed: "success",
  missing: "danger",
  login: "warn",
  unresponsive: "warn",
  later: "neutral",
};

const PROBE_KEY: Record<CliProbe, MessageKey> = {
  installed: "settingsProbeInstalled",
  missing: "settingsProbeMissing",
  login: "settingsProbeLogin",
  unresponsive: "settingsProbeQuiet",
  later: "settingsProbeLater",
};

export function ModelSection({
  draft,
  savedProvider,
  issues,
  apiKey,
  replacingKey,
  stored,
  onDraft,
  onApiKey,
  onReplace,
  onStored,
}: {
  draft: SharedConfig;
  savedProvider: string;
  issues: readonly MessageKey[];
  apiKey: string;
  replacingKey: boolean;
  stored: boolean;
  onDraft: (next: SharedConfig) => void;
  onApiKey: (value: string) => void;
  onReplace: () => void;
  onStored: (provider: string) => void;
}) {
  const { t, language, client, status } = useDaemon();
  const provider = draft.llm.provider;
  const cli = isCliProvider(provider);
  const probe = cliProbe(provider, savedProvider, status?.warnings ?? []);
  const baseError = issues.includes("invalidBase") ? t("invalidBase") : undefined;
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; at: number } | null>(null);

  useEffect(() => {
    if (!result) return;
    const left = TEST_RESULT_MS - (Date.now() - result.at);
    const timer = window.setTimeout(() => setResult(null), Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [result]);

  const groups = { local: t("settingsGroupLocal"), api: t("providerGroupApi") };
  const options = providerOptions(LLM_PROVIDER_IDS).map((option) => {
    const label = providerLabel(option.value, language);
    return {
      value: option.value,
      label,
      group: groups[option.group],
      icon: <ProviderTile provider={option.value} label={label} size="sm" />,
    };
  });
  const savedChip = showStoredKey(stored, replacingKey, apiKey);
  const keyHint = `${providerNeedsKey(provider) ? t("apiKeyHint") : t("leaveBlank")} ${t("settingsSecretLocal")}`;

  return (
    <Card>
      <SettingRow title={t("provider")} control="select">
        <span className="settings-provider">
          <Select
            label={t("provider")}
            value={provider}
            options={options}
            onChange={(value) => {
              setResult(null);
              onDraft({
                ...draft,
                llm: { ...draft.llm, provider: value as SharedConfig["llm"]["provider"] },
              });
            }}
          />
        </span>
      </SettingRow>
      <div className="settings-note">
        <p>{cli ? t("settingsCliNote", { command: cliCommand(provider) }) : t("settingsApiNote")}</p>
        {probe ? (
          <Chip tone={PROBE_TONE[probe]} dot>
            {t(PROBE_KEY[probe])}
          </Chip>
        ) : null}
      </div>
      <SettingRow title={t("model")} {...(cli ? { hint: t("modelBlankHint") } : {})}>
        <Input
          label={t("model")}
          value={draft.llm.model}
          spellCheck={false}
          onChange={(event) => onDraft({ ...draft, llm: { ...draft.llm, model: event.target.value } })}
        />
      </SettingRow>
      {cli ? null : (
        <>
          <SettingRow title={t("baseUrl")} hint={t("baseUrlHint")}>
            <Input
              label={t("baseUrl")}
              className="settings-mono"
              value={draft.llm.baseUrl}
              spellCheck={false}
              placeholder="https://"
              {...(baseError ? { error: baseError } : {})}
              onChange={(event) => onDraft({ ...draft, llm: { ...draft.llm, baseUrl: event.target.value } })}
            />
          </SettingRow>
          <SettingRow title={t("apiKey")} hint={keyHint}>
            {savedChip ? (
              <span className="settings-saved">
                <Chip tone="success">{t("saved")}</Chip>
                <button type="button" className="settings-textlink" onClick={onReplace}>
                  {t("settingsReplace")}
                </button>
              </span>
            ) : (
              <Input
                label={t("apiKey")}
                secret
                value={apiKey}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(event) => onApiKey(event.target.value)}
              />
            )}
          </SettingRow>
        </>
      )}
      <div className="settings-actions">
        <Button
          loading={testing}
          onClick={() => {
            setTesting(true);
            setResult(null);
            void client
              .testLlm({ provider, model: draft.llm.model, baseUrl: draft.llm.baseUrl })
              .then((response) => {
                const ok = response.ok;
                setResult({ ok, message: response.message || (ok ? t("testOk") : t("testFailed")), at: Date.now() });
                if (ok && !cli && apiKey.trim() === "") onStored(provider);
              })
              .catch((caught: unknown) => {
                const message = caught instanceof BrowserDaemonError ? caught.message : t("testFailed");
                setResult({ ok: false, message, at: Date.now() });
              })
              .finally(() => setTesting(false));
          }}
        >
          {t("testConnection")}
        </Button>
        {result ? (
          <>
            <Chip tone={result.ok ? "success" : "danger"} dot>
              {result.ok ? t("testOk") : t("testFailed")}
            </Chip>
            <span className={result.ok ? "settings-inline-ok" : "settings-inline-bad"}>{result.message}</span>
          </>
        ) : (
          <span className="settings-quiet">{t("testHint")}</span>
        )}
      </div>
    </Card>
  );
}
