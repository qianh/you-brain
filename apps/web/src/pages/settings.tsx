import { useEffect, useState } from "react";
import type { Roles, SharedConfig } from "@you-brain/protocol";

import { useDaemon } from "../daemon-context.js";
import { BrowserDaemonError } from "../api/client.js";
import { linesToList, listToLines, uncollectedNotes, validateSettings } from "../lib/copy.js";
import {
  LLM_PROVIDER_IDS,
  providerLabel,
  providerNeedsKey,
  sourceLabel,
  weekdayName,
} from "../lib/format.js";

const SOURCES = ["claude-code", "codex", "grok-build", "cursor", "gemini-cli"] as const;
type SourceId = (typeof SOURCES)[number];

export function SettingsPage() {
  const {
    t,
    language,
    setLanguage,
    config,
    roles,
    status,
    client,
    replaceConfig,
    replaceRoles,
  } = useDaemon();
  const [draft, setDraft] = useState<SharedConfig | null>(null);
  const [rolesDraft, setRolesDraft] = useState<Roles | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [oauthMode, setOauthMode] = useState<"official" | "custom">("official");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [oauthDirty, setOauthDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    if (config) setDraft((current) => current ?? structuredClone(config));
  }, [config]);
  useEffect(() => {
    if (roles) setRolesDraft((current) => current ?? structuredClone(roles));
  }, [roles]);

  if (!draft || !rolesDraft) {
    return (
      <div className="page">
        <h1>{t("settings")}</h1>
        <p className="muted">{t("loading")}</p>
      </div>
    );
  }

  const issues = validateSettings({
    idleMinutes: draft.refine.idleMinutes,
    activeLimit: draft.topics.activeLimit,
    historyDays: draft.topics.historyDays,
    morningDigestTime: draft.reminders.morningDigestTime,
    weeklyReviewTime: draft.reminders.weeklyReviewTime,
    consolidateTime: rolesDraft.consolidation.time,
    timezone: rolesDraft.timezone,
    driveRoot: draft.drive.root,
    baseUrl: draft.llm.baseUrl,
    variants: draft.portrait.variants,
  });
  const notes = uncollectedNotes(draft.capture, language);

  function setConfig(next: SharedConfig): void {
    setDraft(next);
    setMessage(null);
  }

  return (
    <form
      className="page settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (issues.length > 0) {
          setError(t("fieldError"));
          return;
        }
        const secret = apiKey.trim();
        const oauth = oauthDirty
          ? {
              mode: oauthMode,
              clientId: clientId.trim(),
              ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
            }
          : null;
        setBusy(true);
        setError(null);
        setMessage(null);
        void (async () => {
          try {
            const savedConfig = await client.updateConfig(draft);
            const savedRoles = await client.updateRoles(rolesDraft);
            replaceConfig(savedConfig);
            replaceRoles(savedRoles);
            setDraft(structuredClone(savedConfig));
            setRolesDraft(structuredClone(savedRoles));
            if (secret) {
              await client.putLlmKey(savedConfig.llm.provider, secret);
              setApiKey("");
            }
            if (oauth) {
              await client.putOauth(oauth);
              setClientSecret("");
              setOauthDirty(false);
            }
            setMessage(t("saved"));
          } catch (caught) {
            setError(caught instanceof BrowserDaemonError ? caught.message : t("actionFailed"));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <header className="page-head">
        <div>
          <h1>{t("settings")}</h1>
          <p>{t("uiHint")}</p>
        </div>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? t("saving") : t("save")}
        </button>
      </header>
      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="form-ok">{message}</p> : null}
      {issues.map((issue) => (
        <p key={issue} className="form-error">
          {t(issue)}
        </p>
      ))}

      <fieldset>
        <legend>{t("groupAccount")}</legend>
        <p className="muted">{t("accountHint")}</p>
        <p>
          {t("signedInAs")}{" "}
          <strong>{status?.drive.accountEmail || t("notSignedIn")}</strong>
        </p>
        <p className="muted">
          {status?.drive.reachable === true
            ? t("driveOk")
            : status?.drive.reachable === false
              ? t("driveDown")
              : t("driveUnknown")}
        </p>
        <label className="field">
          <span>{t("oauthMode")}</span>
          <select
            value={oauthMode}
            onChange={(event) => {
              setOauthMode(event.target.value === "custom" ? "custom" : "official");
              setOauthDirty(true);
            }}
          >
            <option value="official">{t("oauthOfficial")}</option>
            <option value="custom">{t("oauthCustom")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("clientId")}</span>
          <input
            value={clientId}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setClientId(event.target.value);
              setOauthDirty(true);
            }}
          />
        </label>
        <label className="field">
          <span>{t("clientSecret")}</span>
          <input
            type="password"
            value={clientSecret}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => {
              setClientSecret(event.target.value);
              setOauthDirty(true);
            }}
          />
          <small>{t("secretHint")}</small>
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setTestMessage(null);
            void client
              .googleLogin()
              .then((result) => setTestMessage(result.message || t("loginStarted")))
              .catch((caught: unknown) => {
                setError(caught instanceof BrowserDaemonError ? caught.message : t("actionFailed"));
              });
          }}
        >
          {t("signIn")}
        </button>
        {testMessage ? <p className="form-ok">{testMessage}</p> : null}
      </fieldset>

      <fieldset>
        <legend>{t("groupDrive")}</legend>
        <p className="muted">{t("driveHint")}</p>
        <label className="field">
          <span>{t("driveRoot")}</span>
          <input
            value={draft.drive.root}
            onChange={(event) => setConfig({ ...draft, drive: { root: event.target.value } })}
          />
        </label>
        <p className="field-label">{t("variants")}</p>
        {draft.portrait.variants.map((variant, index) => (
          <div key={`${variant.id}-${index}`} className="pair">
            <input
              aria-label={t("variantId")}
              value={variant.id}
              onChange={(event) => {
                const variants = draft.portrait.variants.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, id: event.target.value } : item,
                );
                setConfig({ ...draft, portrait: { ...draft.portrait, variants } });
              }}
            />
            <input
              aria-label={t("variantPath")}
              value={variant.path}
              onChange={(event) => {
                const variants = draft.portrait.variants.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, path: event.target.value } : item,
                );
                setConfig({ ...draft, portrait: { ...draft.portrait, variants } });
              }}
            />
            <button
              type="button"
              className="btn quiet"
              disabled={draft.portrait.variants.length < 2}
              onClick={() => {
                const variants = draft.portrait.variants.filter((_, itemIndex) => itemIndex !== index);
                setConfig({ ...draft, portrait: { ...draft.portrait, variants } });
              }}
            >
              {t("remove")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn quiet"
          onClick={() =>
            setConfig({
              ...draft,
              portrait: {
                ...draft.portrait,
                variants: [...draft.portrait.variants, { id: "custom", path: "digital-twin/custom.md" }],
              },
            })
          }
        >
          {t("addVariant")}
        </button>
        <label className="field">
          <span>{t("snapshotPattern")}</span>
          <input
            value={draft.portrait.snapshotPattern}
            onChange={(event) =>
              setConfig({
                ...draft,
                portrait: { ...draft.portrait, snapshotPattern: event.target.value },
              })
            }
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>{t("groupCapture")}</legend>
        <p className="muted">{t("captureHint")}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.capture.keepToolCalls}
            onChange={(event) =>
              setConfig({
                ...draft,
                capture: { ...draft.capture, keepToolCalls: event.target.checked },
              })
            }
          />
          <span>{t("keepToolCalls")}</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.capture.includeSubagents}
            onChange={(event) =>
              setConfig({
                ...draft,
                capture: { ...draft.capture, includeSubagents: event.target.checked },
              })
            }
          />
          <span>{t("includeSubagents")}</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.capture.redact}
            onChange={(event) =>
              setConfig({ ...draft, capture: { ...draft.capture, redact: event.target.checked } })
            }
          />
          <span>{t("redact")}</span>
        </label>
        <div className="note">
          <strong>{t("uncollected")}</strong>
          <ul>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
        {SOURCES.map((source) => {
          const item = draft.capture.sources[source];
          return (
            <details key={source} className="source-block">
              <summary>
                <label className="check" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    onChange={(event) =>
                      setConfig({
                        ...draft,
                        capture: {
                          ...draft.capture,
                          sources: {
                            ...draft.capture.sources,
                            [source]: { ...item, enabled: event.target.checked },
                          },
                        },
                      })
                    }
                  />
                  <span>{sourceLabel(source)}</span>
                </label>
              </summary>
              <ListField
                label={t("paths")}
                value={item.paths}
                onChange={(paths) => updateSource(setConfig, draft, source, { ...item, paths })}
              />
              <ListField
                label={t("includeGlobs")}
                value={item.include}
                onChange={(include) => updateSource(setConfig, draft, source, { ...item, include })}
              />
              <ListField
                label={t("excludeGlobs")}
                value={item.exclude}
                onChange={(exclude) => updateSource(setConfig, draft, source, { ...item, exclude })}
              />
            </details>
          );
        })}
      </fieldset>

      <fieldset>
        <legend>{t("groupModel")}</legend>
        <p className="muted">{t("modelHint")}</p>
        <label className="field">
          <span>{t("provider")}</span>
          <select
            value={draft.llm.provider}
            onChange={(event) =>
              setConfig({
                ...draft,
                llm: { ...draft.llm, provider: event.target.value as SharedConfig["llm"]["provider"] },
              })
            }
          >
            {LLM_PROVIDER_IDS.map((provider) => (
              <option key={provider} value={provider}>
                {providerLabel(provider, language)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("model")}</span>
          <input
            value={draft.llm.model}
            spellCheck={false}
            onChange={(event) =>
              setConfig({ ...draft, llm: { ...draft.llm, model: event.target.value } })
            }
          />
        </label>
        <label className="field">
          <span>{t("baseUrl")}</span>
          <input
            value={draft.llm.baseUrl}
            spellCheck={false}
            placeholder="https://"
            onChange={(event) =>
              setConfig({ ...draft, llm: { ...draft.llm, baseUrl: event.target.value } })
            }
          />
          <small>{t("baseUrlHint")}</small>
        </label>
        <label className="field">
          <span>{t("apiKey")}</span>
          <input
            type="password"
            value={apiKey}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <small>
            {providerNeedsKey(draft.llm.provider) ? t("apiKeyHint") : t("leaveBlank")} {t("secretHint")}
          </small>
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setTestMessage(null);
            void client
              .testLlm({
                provider: draft.llm.provider,
                model: draft.llm.model,
                baseUrl: draft.llm.baseUrl,
              })
              .then((result) => setTestMessage(result.message || (result.ok ? t("testOk") : t("testFailed"))))
              .catch((caught: unknown) => {
                setTestMessage(caught instanceof BrowserDaemonError ? caught.message : t("testFailed"));
              });
          }}
        >
          {t("testConnection")}
        </button>
        <p className="muted tiny">{t("testHint")}</p>
      </fieldset>

      <fieldset>
        <legend>{t("groupRefine")}</legend>
        <p className="muted">{t("refineHint")}</p>
        <label className="field">
          <span>{t("idleMinutes")}</span>
          <input
            type="number"
            min={1}
            step={1}
            value={draft.refine.idleMinutes}
            onChange={(event) =>
              setConfig({
                ...draft,
                refine: { idleMinutes: numberOrZero(event.target.valueAsNumber) },
              })
            }
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>{t("groupTopics")}</legend>
        <p className="muted">{t("topicsHint")}</p>
        <label className="field">
          <span>{t("activeLimit")}</span>
          <input
            type="number"
            min={1}
            step={1}
            value={draft.topics.activeLimit}
            onChange={(event) =>
              setConfig({
                ...draft,
                topics: { ...draft.topics, activeLimit: numberOrZero(event.target.valueAsNumber) },
              })
            }
          />
        </label>
        <label className="field">
          <span>{t("historyDays")}</span>
          <input
            type="number"
            min={1}
            step={1}
            value={draft.topics.historyDays}
            onChange={(event) =>
              setConfig({
                ...draft,
                topics: { ...draft.topics, historyDays: numberOrZero(event.target.valueAsNumber) },
              })
            }
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>{t("groupConsolidation")}</legend>
        <p className="muted">{t("consolidationHint")}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={rolesDraft.consolidation.enabled}
            onChange={(event) =>
              setRolesDraft({
                ...rolesDraft,
                consolidation: { ...rolesDraft.consolidation, enabled: event.target.checked },
              })
            }
          />
          <span>{t("consolidationOn")}</span>
        </label>
        <label className="field">
          <span>{t("consolidationTime")}</span>
          <input
            value={rolesDraft.consolidation.time}
            onChange={(event) =>
              setRolesDraft({
                ...rolesDraft,
                consolidation: { ...rolesDraft.consolidation, time: event.target.value },
              })
            }
          />
        </label>
        <label className="field">
          <span>{t("timezone")}</span>
          <input
            value={rolesDraft.timezone}
            spellCheck={false}
            onChange={(event) => setRolesDraft({ ...rolesDraft, timezone: event.target.value })}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>{t("groupReminders")}</legend>
        <p className="muted">{t("remindersHint")}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.reminders.notifications}
            onChange={(event) =>
              setConfig({
                ...draft,
                reminders: { ...draft.reminders, notifications: event.target.checked },
              })
            }
          />
          <span>{t("notifications")}</span>
        </label>
        <label className="field">
          <span>{t("morningTime")}</span>
          <input
            value={draft.reminders.morningDigestTime}
            onChange={(event) =>
              setConfig({
                ...draft,
                reminders: { ...draft.reminders, morningDigestTime: event.target.value },
              })
            }
          />
        </label>
        <label className="field">
          <span>{t("weeklyDay")}</span>
          <select
            value={draft.reminders.weeklyReviewDay}
            onChange={(event) =>
              setConfig({
                ...draft,
                reminders: {
                  ...draft.reminders,
                  weeklyReviewDay: Number(event.target.value),
                },
              })
            }
          >
            {[1, 2, 3, 4, 5, 6, 7].map((day) => (
              <option key={day} value={day}>
                {weekdayName(day, language)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("weeklyTime")}</span>
          <input
            value={draft.reminders.weeklyReviewTime}
            onChange={(event) =>
              setConfig({
                ...draft,
                reminders: { ...draft.reminders, weeklyReviewTime: event.target.value },
              })
            }
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>{t("groupIntegrations")}</legend>
        <p className="muted">{t("integrationsHint")}</p>
        <p className="muted">{t("cursorHint")}</p>
        <IntegrationGroup
          title={t("mcp")}
          selected={draft.integrations.mcpClients}
          onChange={(mcpClients) =>
            setConfig({ ...draft, integrations: { ...draft.integrations, mcpClients } })
          }
        />
        <IntegrationGroup
          title={t("codingPortrait")}
          selected={draft.integrations.codingPortraitClients}
          onChange={(codingPortraitClients) =>
            setConfig({
              ...draft,
              integrations: { ...draft.integrations, codingPortraitClients },
            })
          }
        />
        <IntegrationGroup
          title={t("skills")}
          selected={draft.integrations.skillClients}
          onChange={(skillClients) =>
            setConfig({ ...draft, integrations: { ...draft.integrations, skillClients } })
          }
        />
      </fieldset>

      <fieldset>
        <legend>{t("groupUi")}</legend>
        <label className="field">
          <span>{t("language")}</span>
          <select
            value={draft.ui.language}
            onChange={(event) => {
              const next = event.target.value === "en" ? "en" : "zh";
              setLanguage(next);
              setConfig({ ...draft, ui: { ...draft.ui, language: next } });
            }}
          >
            <option value="zh">{t("languageZh")}</option>
            <option value="en">{t("languageEn")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("shortcut")}</span>
          <input
            value={draft.ui.shortcut}
            spellCheck={false}
            onChange={(event) =>
              setConfig({ ...draft, ui: { ...draft.ui, shortcut: event.target.value } })
            }
          />
          <small>{t("shortcutHint")}</small>
        </label>
      </fieldset>
    </form>
  );
}

function numberOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function updateSource(
  setConfig: (next: SharedConfig) => void,
  draft: SharedConfig,
  source: SourceId,
  value: SharedConfig["capture"]["sources"][SourceId],
): void {
  setConfig({
    ...draft,
    capture: {
      ...draft.capture,
      sources: { ...draft.capture.sources, [source]: value },
    },
  });
}

function ListField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useDaemon();
  const serialized = listToLines(value);
  const [text, setText] = useState(serialized);
  useEffect(() => setText(serialized), [serialized]);
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => onChange(linesToList(text))}
      />
      <small>{t("listHint")}</small>
    </label>
  );
}

function IntegrationGroup({
  title,
  selected,
  onChange,
}: {
  title: string;
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="integration">
      <h3>{title}</h3>
      {SOURCES.map((source) => {
        const on = selected.includes(source);
        return (
          <label key={source} className="check">
            <input
              type="checkbox"
              checked={on}
              onChange={(event) => {
                if (event.target.checked) onChange(on ? [...selected] : [...selected, source]);
                else onChange(selected.filter((item) => item !== source));
              }}
            />
            <span>{sourceLabel(source)}</span>
          </label>
        );
      })}
    </div>
  );
}
