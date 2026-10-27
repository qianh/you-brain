import { useState } from "react";
import type { SharedConfig } from "@you-brain/protocol";

import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { ConfirmDialog } from "../../components/dialog.js";
import { FieldError, Input } from "../../components/input.js";
import { Row } from "../../components/row.js";
import { useDaemon } from "../../daemon-context.js";
import { driveEmail, driveState } from "../../lib/drive-state.js";
import type { MessageKey } from "../../i18n/messages.js";
import { accountDriveView } from "./account-model.js";
import { SettingRow } from "./setting-row.js";

function issueText(issues: readonly MessageKey[], key: MessageKey, text: string): string | undefined {
  return issues.includes(key) ? text : undefined;
}

export function AccountSection({
  draft,
  issues,
  onDraft,
}: {
  draft: SharedConfig;
  issues: readonly MessageKey[];
  onDraft: (next: SharedConfig) => void;
}) {
  const { t, status, client, reload } = useDaemon();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"signOut" | "switch" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = accountDriveView(driveState(status?.drive), driveEmail(status?.drive));
  const emailText = view.emailKey ? t(view.emailKey) : view.email;
  const rootError = issueText(issues, "invalidRoot", t("invalidRoot"));

  return (
    <Card>
      <Row
        icon={<span className="settings-google" aria-hidden="true">G</span>}
        title={t("signedInAs")}
        titleText={t("signedInAs")}
        trailing={
          <span className="settings-account-meta">
            <Chip tone={view.chipTone} dot>
              {t(view.chipKey)}
            </Chip>
            <span className="settings-email" title={emailText}>
              {emailText}
            </span>
          </span>
        }
      />
      <SettingRow title={t("driveRoot")} hint={t("driveHint")}>
        <Input
          label={t("driveRoot")}
          value={draft.drive.root}
          spellCheck={false}
          {...(rootError ? { error: rootError } : {})}
          onChange={(event) => onDraft({ ...draft, drive: { root: event.target.value } })}
        />
      </SettingRow>
      {view.loginKey || view.manage || message || error ? (
        <div className="settings-actions">
          {view.loginKey ? (
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
              {t(view.loginKey)}
            </Button>
          ) : null}
          {view.manage ? (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirm("switch")}>
                {t("switchGoogle")}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirm("signOut")}>
                {t("signOutGoogle")}
              </Button>
            </>
          ) : null}
          {message ? <span className="settings-inline-ok">{message}</span> : null}
          {error ? <FieldError>{error}</FieldError> : null}
        </div>
      ) : null}
      {status?.login ? (
        <div className="settings-login-hint">
          <p>{t("loginNeedsTunnel")}</p>
          {status.login.tunnel ? (
            <code className="settings-mono-line">{status.login.tunnel}</code>
          ) : null}
          <a
            className="settings-textlink"
            href={status.login.authorizationUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("loginOpenUrl")}
          </a>
          <p className="settings-quiet">{t("loginTunnelHint")}</p>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        tone="danger"
        title={t(confirm === "switch" ? "switchTitle" : "signOutTitle")}
        description={t(confirm === "switch" ? "switchBody" : "signOutBody")}
        confirmLabel={t(confirm === "switch" ? "switchGoogle" : "signOutGoogle")}
        cancelLabel={t("cancel")}
        loading={busy}
        onClose={() => {
          if (!busy) setConfirm(null);
        }}
        onConfirm={() => {
          const action = confirm;
          if (!action) return;
          setBusy(true);
          setMessage(null);
          setError(null);
          const call = action === "switch" ? client.googleSwitch() : client.googleLogout();
          void call
            .then((result) => {
              setMessage(action === "switch" ? t("switchRestarting") : result.message);
              if (action === "signOut") void reload("status");
            })
            .catch((caught: unknown) => {
              setError(caught instanceof BrowserDaemonError ? caught.message : t("actionFailed"));
            })
            .finally(() => {
              setBusy(false);
              setConfirm(null);
            });
        }}
      />
    </Card>
  );
}
