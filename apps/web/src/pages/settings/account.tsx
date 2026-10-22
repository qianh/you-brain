import { useState } from "react";
import type { SharedConfig } from "@you-brain/protocol";

import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { FieldError, Input } from "../../components/input.js";
import { Row } from "../../components/row.js";
import { Select } from "../../components/select.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { SettingRow } from "./setting-row.js";

function issueText(issues: readonly MessageKey[], key: MessageKey, text: string): string | undefined {
  return issues.includes(key) ? text : undefined;
}

export function AccountSection({
  draft,
  issues,
  oauthMode,
  clientId,
  clientSecret,
  onDraft,
  onMode,
  onClientId,
  onSecret,
}: {
  draft: SharedConfig;
  issues: readonly MessageKey[];
  oauthMode: "official" | "custom";
  clientId: string;
  clientSecret: string;
  onDraft: (next: SharedConfig) => void;
  onMode: (mode: "official" | "custom") => void;
  onClientId: (value: string) => void;
  onSecret: (value: string) => void;
}) {
  const { t, status, client } = useDaemon();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const email = status?.drive.accountEmail?.trim() ?? "";
  const reachable = status?.drive.reachable;
  const driveTone = reachable === true ? "success" : reachable === false ? "danger" : "neutral";
  const driveLabel = reachable === true ? t("driveOk") : reachable === false ? t("driveDown") : t("driveUnknown");
  const rootError = issueText(issues, "invalidRoot", t("invalidRoot"));

  return (
    <Card>
      <Row
        icon={<span className="settings-google" aria-hidden="true">G</span>}
        title={t("signedInAs")}
        titleText={t("signedInAs")}
        trailing={
          <span className="settings-account-meta">
            <Chip tone={driveTone} dot>
              {driveLabel}
            </Chip>
            <span className="settings-email" title={email || t("notSignedIn")}>
              {email || t("notSignedIn")}
            </span>
          </span>
        }
      />
      <SettingRow title={t("oauthMode")} control="select">
        <Select
          label={t("oauthMode")}
          value={oauthMode}
          onChange={(value) => onMode(value === "custom" ? "custom" : "official")}
          options={[
            { value: "official", label: t("oauthOfficial") },
            { value: "custom", label: t("oauthCustom") },
          ]}
        />
      </SettingRow>
      <SettingRow title={t("clientId")}>
        <Input
          label={t("clientId")}
          value={clientId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onClientId(event.target.value)}
        />
      </SettingRow>
      <SettingRow title={t("clientSecret")} hint={t("settingsSecretLocal")}>
        <Input
          label={t("clientSecret")}
          secret
          value={clientSecret}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(event) => onSecret(event.target.value)}
        />
      </SettingRow>
      <SettingRow title={t("driveRoot")} hint={t("driveHint")}>
        <Input
          label={t("driveRoot")}
          value={draft.drive.root}
          spellCheck={false}
          {...(rootError ? { error: rootError } : {})}
          onChange={(event) => onDraft({ ...draft, drive: { root: event.target.value } })}
        />
      </SettingRow>
      <div className="settings-actions">
        <Button
          loading={busy}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            setError(null);
            void client
              .googleLogin()
              .then((result) => setMessage(result.message || t("loginStarted")))
              .catch((caught: unknown) => {
                setError(caught instanceof BrowserDaemonError ? caught.message : t("actionFailed"));
              })
              .finally(() => setBusy(false));
          }}
        >
          {t("signIn")}
        </Button>
        {message ? <span className="settings-inline-ok">{message}</span> : null}
        {error ? <FieldError>{error}</FieldError> : null}
      </div>
    </Card>
  );
}
