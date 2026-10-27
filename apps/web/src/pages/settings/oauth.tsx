import { useEffect, useState } from "react";

import { BrowserDaemonError } from "../../api/client.js";
import { Banner } from "../../components/banner.js";
import { Button } from "../../components/button.js";
import { Card, Section } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { FieldError, Input } from "../../components/input.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { SettingRow } from "./setting-row.js";
import {
  CLIENT_ID_SUFFIX,
  clientIdIssue,
  type ClientIdIssue,
  type OAuthClientView,
  type OAuthMode,
} from "./oauth-model.js";

const CLIENT_ID_MESSAGE: Record<ClientIdIssue, MessageKey> = {
  required: "oauthClientIdRequired",
  suffix: "oauthClientIdSuffix",
};

/**
 * 自带 OAuth 凭据（每人自己的 Google Cloud 项目）。
 *
 * 分发方式是每个人用自己的项目，所以这块是主路径而不是高级选项：
 * 表单要能填、能改 id 而不必重贴 secret、也能切回官方。
 */
export function OAuthClientSection() {
  const { client, t } = useDaemon();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<OAuthClientView | null>(null);
  const [mode, setMode] = useState<OAuthMode>("official");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void client
      .oauthClient()
      .then((body) => {
        if (!alive) return;
        applyView(body);
        setPhase("ready");
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setLoadError(caught instanceof BrowserDaemonError ? caught.message : t("loadFailed"));
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [client, t]);

  function applyView(body: OAuthClientView): void {
    setView(body);
    setMode(body.mode);
    setClientId(body.mode === "custom" ? body.clientId : "");
    setSecret("");
    setNote(null);
  }

  const issue = mode === "custom" ? clientIdIssue(clientId) : null;
  // 已经存过 secret 时允许只改 id；没存过就必须一起填。
  const needsSecret = mode === "custom" && !(view?.mode === "custom" && view.hasClientSecret);
  const canSave =
    !saving && (mode === "official" || (issue === null && (!needsSecret || secret.trim() !== "")));

  async function save(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    setNote(null);
    try {
      const body = await client.putOAuthClient({
        mode,
        ...(mode === "custom" ? { clientId: clientId.trim() } : {}),
        ...(mode === "custom" && secret.trim() !== "" ? { clientSecret: secret.trim() } : {}),
      });
      applyView(body);
      setNote({ ok: true, message: t("settingsSaved") });
    } catch (caught: unknown) {
      const message = caught instanceof BrowserDaemonError ? caught.message : t("loadFailed");
      setNote({ ok: false, message });
    } finally {
      setSaving(false);
    }
  }

  const officialUnavailable = view !== null && !view.officialAvailable;

  return (
    <Section title={t("oauthTitle")} hint={t("oauthHint")}>
      {phase === "loading" ? <p className="settings-quiet">{t("loading")}</p> : null}
      {phase === "error" ? <Banner tone="danger">{loadError || t("loadFailed")}</Banner> : null}
      {phase === "ready" && view ? (
        <>
          {officialUnavailable ? <Banner tone="warn">{t("oauthOfficialUnavailable")}</Banner> : null}
          <Card>
            <SettingRow title={t("oauthMode")} hint={t("oauthModeHint")}>
              <div className="oauth-mode" role="radiogroup" aria-label={t("oauthMode")}>
                <label className="oauth-mode-option">
                  <input
                    type="radio"
                    name="oauth-mode"
                    value="official"
                    checked={mode === "official"}
                    disabled={officialUnavailable || saving}
                    onChange={() => {
                      setMode("official");
                      setNote(null);
                    }}
                  />
                  <span>{t("oauthModeOfficial")}</span>
                </label>
                <label className="oauth-mode-option">
                  <input
                    type="radio"
                    name="oauth-mode"
                    value="custom"
                    checked={mode === "custom"}
                    disabled={saving}
                    onChange={() => {
                      setMode("custom");
                      setNote(null);
                    }}
                  />
                  <span>{t("oauthModeCustom")}</span>
                </label>
              </div>
            </SettingRow>
            {mode === "custom" ? (
              <>
                <SettingRow title={t("oauthClientId")} hint={t("oauthClientIdHint")}>
                  <Input
                    label={t("oauthClientId")}
                    className="settings-mono"
                    value={clientId}
                    spellCheck={false}
                    placeholder={`xxxx${CLIENT_ID_SUFFIX}`}
                    {...(issue ? { error: t(CLIENT_ID_MESSAGE[issue]) } : {})}
                    onChange={(event) => {
                      setClientId(event.target.value);
                      setNote(null);
                    }}
                  />
                </SettingRow>
                <SettingRow
                  title={t("oauthClientSecret")}
                  hint={needsSecret ? t("oauthClientSecretHint") : t("oauthClientSecretKept")}
                >
                  <Input
                    label={t("oauthClientSecret")}
                    secret
                    value={secret}
                    autoComplete="new-password"
                    spellCheck={false}
                    {...(needsSecret ? {} : { placeholder: t("oauthClientSecretKept") })}
                    onChange={(event) => {
                      setSecret(event.target.value);
                      setNote(null);
                    }}
                  />
                </SettingRow>
              </>
            ) : null}
            <div className="settings-actions">
              <Button loading={saving} disabled={!canSave} onClick={() => void save()}>
                {t("save")}
              </Button>
              {view.mode === "custom" ? (
                <Chip tone="success">{t("oauthInUse")}</Chip>
              ) : (
                <Chip tone="neutral">{t("oauthUsingOfficial")}</Chip>
              )}
              {note ? (
                note.ok ? (
                  <span className="settings-inline-ok">{note.message}</span>
                ) : (
                  <FieldError>{note.message}</FieldError>
                )
              ) : null}
            </div>
          </Card>
          {mode === "custom" ? (
            <Banner tone="info">
              <p>{t("oauthSetupSteps")}</p>
              <p>{t("oauthTestingWarning")}</p>
            </Banner>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}
