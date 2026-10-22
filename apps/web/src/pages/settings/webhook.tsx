import { useEffect, useState } from "react";
import type { WebhookPublic, WebhookTestResult } from "@you-brain/core/http/types.js";

import { BrowserDaemonError } from "../../api/client.js";
import { Banner } from "../../components/banner.js";
import { Button } from "../../components/button.js";
import { Card, Section } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { Input } from "../../components/input.js";
import { Toggle } from "../../components/toggle.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { SettingRow } from "./setting-row.js";
import {
  WEBHOOK_EVENT_NAMES,
  webhookSaveBody,
  webhookUrlIssue,
  type WebhookEventName,
  type WebhookSecretMode,
  type WebhookUrlIssue,
} from "./webhook-logic.js";

const EVENT_LABEL: Record<WebhookEventName, MessageKey> = {
  "reminder.issued": "webhookEventReminder",
  "topic.created": "webhookEventCreated",
  "topic.status_changed": "webhookEventStatus",
  "topic.merged": "webhookEventMerged",
};

const URL_ISSUE: Record<WebhookUrlIssue, MessageKey> = {
  required: "webhookUrlRequired",
  long: "webhookUrlLong",
  invalid: "webhookUrlInvalid",
  userinfo: "webhookUrlUserinfo",
};

export function WebhookSection() {
  const { client, status, roles, t, language, timeZone } = useDaemon();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEventName[]>([...WEBHOOK_EVENT_NAMES]);
  const [hasSecret, setHasSecret] = useState(false);
  const [secretMode, setSecretMode] = useState<WebhookSecretMode>("replace");
  const [secret, setSecret] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const [last, setLast] = useState<WebhookPublic["last"]>(null);
  const [pending, setPending] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebhookTestResult | null>(null);
  const relative = useRelativeTime(last?.at ?? null, language, timeZone);

  useEffect(() => {
    let alive = true;
    void client
      .webhook()
      .then((body) => {
        if (!alive) return;
        applyPublic(body);
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

  function applyPublic(body: WebhookPublic): void {
    setEnabled(body.enabled);
    setUrl(body.url);
    setSavedUrl(body.url);
    setEvents(body.events.filter((kind): kind is WebhookEventName => isEventName(kind)));
    setHasSecret(body.hasSecret);
    setSecretMode(body.hasSecret ? "keep" : "replace");
    setSecret("");
    setLast(body.last);
    setPending(body.pending);
  }

  const knownDevice = status !== null && roles !== null;
  const isMain = knownDevice && roles.mainDevice !== null && status.deviceId === roles.mainDevice;
  const urlIssue = webhookUrlIssue(url, enabled);
  const showSecretInput = secretMode === "replace";

  async function save(): Promise<void> {
    if (urlIssue) return;
    setSaving(true);
    setSaveNote(null);
    try {
      const body = await client.updateWebhook(
        webhookSaveBody({ enabled, url, events, secretMode, secret }),
      );
      applyPublic(body);
      setSaveNote({ ok: true, message: t("settingsSaved") });
    } catch (caught: unknown) {
      const message = caught instanceof BrowserDaemonError ? caught.message : t("loadFailed");
      setSaveNote({ ok: false, message });
    } finally {
      setSaving(false);
    }
  }

  async function sendTest(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await client.testWebhook());
    } catch (caught: unknown) {
      const message = caught instanceof BrowserDaemonError ? caught.message : t("webhookTestFailed");
      setTestResult({ ok: false, error: message });
    } finally {
      setTesting(false);
    }
  }

  const lastLine =
    last === null
      ? t("webhookLastNone")
      : last.ok
        ? t("webhookLastOk", { time: relative, status: last.status ?? "" })
        : t("webhookLastBad", { time: relative, error: last.error ?? t("webhookTestFailed") });

  return (
    <Section title={t("webhookTitle")} hint={t("webhookHint")}>
      {phase === "loading" ? <p className="settings-quiet">{t("loading")}</p> : null}
      {phase === "error" ? (
        <Banner tone="danger">{loadError || t("loadFailed")}</Banner>
      ) : null}
      {phase === "ready" ? (
        <>
          {knownDevice && !isMain ? <Banner tone="warn">{t("webhookNotMain")}</Banner> : null}
          <Card>
            <SettingRow title={t("webhookEnabled")} control="toggle">
              <Toggle
                checked={enabled}
                label={t("webhookEnabled")}
                onChange={(checked) => {
                  setEnabled(checked);
                  setSaveNote(null);
                }}
              />
            </SettingRow>
            <SettingRow title={t("webhookUrl")} hint={t("webhookUrlHint")}>
              <Input
                label={t("webhookUrl")}
                className="settings-mono"
                value={url}
                spellCheck={false}
                placeholder="https://"
                {...(urlIssue ? { error: t(URL_ISSUE[urlIssue]) } : {})}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setSaveNote(null);
                }}
              />
            </SettingRow>
            <SettingRow title={t("webhookSecret")} hint={t("webhookSecretHint")}>
              {secretMode === "clear" ? (
                <span className="settings-saved">
                  <Chip tone="warn">{t("webhookSecretPending")}</Chip>
                  <button
                    type="button"
                    className="settings-textlink"
                    onClick={() => setSecretMode(hasSecret ? "keep" : "replace")}
                  >
                    {t("webhookCancel")}
                  </button>
                </span>
              ) : showSecretInput ? (
                <span className="webhook-secret">
                  <Input
                    label={t("webhookSecret")}
                    secret
                    value={secret}
                    autoComplete="new-password"
                    spellCheck={false}
                    onChange={(event) => {
                      setSecret(event.target.value);
                      setSaveNote(null);
                    }}
                  />
                  {hasSecret ? (
                    <button
                      type="button"
                      className="settings-textlink"
                      onClick={() => {
                        setSecret("");
                        setSecretMode("keep");
                      }}
                    >
                      {t("webhookCancel")}
                    </button>
                  ) : null}
                </span>
              ) : (
                <span className="settings-saved">
                  <Chip tone="success">{t("webhookSecretSet")}</Chip>
                  <button type="button" className="settings-textlink" onClick={() => setSecretMode("replace")}>
                    {t("settingsReplace")}
                  </button>
                  <button type="button" className="settings-textlink" onClick={() => setSecretMode("clear")}>
                    {t("webhookSecretClear")}
                  </button>
                </span>
              )}
            </SettingRow>
            <div className="webhook-events">
              <span className="settings-kicker">{t("webhookEvents")}</span>
              <div className="webhook-event-list">
                {WEBHOOK_EVENT_NAMES.map((kind) => {
                  const on = events.includes(kind);
                  return (
                    <Chip
                      key={kind}
                      tone={on ? "accent" : "neutral"}
                      pressed={on}
                      onClick={() => {
                        setEvents((current) =>
                          current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind],
                        );
                        setSaveNote(null);
                      }}
                    >
                      {t(EVENT_LABEL[kind])}
                    </Chip>
                  );
                })}
              </div>
            </div>
            <div className="settings-actions">
              <Button variant="primary" loading={saving} disabled={urlIssue !== null} onClick={() => void save()}>
                {t("settingsSave")}
              </Button>
              {saveNote ? (
                <span className={saveNote.ok ? "settings-inline-ok" : "settings-inline-bad"}>{saveNote.message}</span>
              ) : null}
            </div>
            <div className="settings-actions">
              <Button loading={testing} disabled={savedUrl.trim() === ""} onClick={() => void sendTest()}>
                {t("webhookTest")}
              </Button>
              {testResult ? (
                <span className={testResult.ok ? "settings-inline-ok" : "settings-inline-bad"}>
                  {testResult.ok ? t("webhookTestOk") : testResult.error || t("webhookTestFailed")}
                </span>
              ) : (
                <span className="settings-quiet">{t("webhookTestHint")}</span>
              )}
            </div>
            <div className="webhook-status">
              <p className={last?.ok === false ? "settings-inline-bad" : last?.ok === true ? "settings-inline-ok" : "settings-quiet"}>
                {lastLine}
              </p>
              <p className="settings-quiet">{t("webhookPending", { count: pending })}</p>
            </div>
          </Card>
        </>
      ) : null}
    </Section>
  );
}

function isEventName(kind: string): kind is WebhookEventName {
  return (WEBHOOK_EVENT_NAMES as readonly string[]).includes(kind);
}
