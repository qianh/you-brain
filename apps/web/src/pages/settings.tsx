import { useEffect, useState, type ReactNode } from "react";
import type { Roles, SharedConfig } from "@you-brain/protocol";

import { useDaemon } from "../daemon-context.js";
import { BrowserDaemonError } from "../api/client.js";
import { Card, CardHead } from "../components/card.js";
import { Icon } from "../components/icons.js";
import { SourceMark } from "../components/tile.js";
import { ProviderPicker } from "../components/picker.js";
import { Row } from "../components/row.js";
import { Segmented } from "../components/segmented.js";
import { Select } from "../components/select.js";
import { Toggle } from "../components/toggle.js";
import { linesToList, listToLines, uncollectedNotes, validateSettings } from "../lib/copy.js";
import { providerNeedsKey, sourceLabel, weekdayName } from "../lib/format.js";
import { useTheme, type ThemeChoice } from "../theme-context.js";

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
  const { choice, setChoice } = useTheme();
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
  const [openSource, setOpenSource] = useState<SourceId | null>(null);

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
  const cli = draft.llm.provider.endsWith("-cli");

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
            if (secret && !savedConfig.llm.provider.endsWith("-cli")) {
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
      <header className="page-head sticky">
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

      <Card>
        <CardHead title={t("groupAccountDrive")} hint={t("accountHint")} />
        <div className="card-body">
          <Row
            title={t("signedInAs")}
            subtitle={
              <>
                <i
                  className={
                    status?.drive.reachable === true
                      ? "dot dot-ok"
                      : status?.drive.reachable === false
                        ? "dot dot-bad"
                        : "dot dot-muted"
                  }
                />
                <span>
                  {status?.drive.reachable === true
                    ? t("driveOk")
                    : status?.drive.reachable === false
                      ? t("driveDown")
                      : t("driveUnknown")}
                </span>
              </>
            }
            trailing={<strong>{status?.drive.accountEmail || t("notSignedIn")}</strong>}
          />
          <SettingRow title={t("oauthMode")}>
            <Select
              label={t("oauthMode")}
              value={oauthMode}
              onChange={(value) => {
                setOauthMode(value === "custom" ? "custom" : "official");
                setOauthDirty(true);
              }}
            >
              <option value="official">{t("oauthOfficial")}</option>
              <option value="custom">{t("oauthCustom")}</option>
            </Select>
          </SettingRow>
          <SettingRow title={t("clientId")}>
            <input
              className="control"
              value={clientId}
              autoComplete="off"
              spellCheck={false}
              aria-label={t("clientId")}
              onChange={(event) => {
                setClientId(event.target.value);
                setOauthDirty(true);
              }}
            />
          </SettingRow>
          <SettingRow title={t("clientSecret")} hint={t("secretHint")}>
            <input
              className="control"
              type="password"
              value={clientSecret}
              autoComplete="new-password"
              spellCheck={false}
              aria-label={t("clientSecret")}
              onChange={(event) => {
                setClientSecret(event.target.value);
                setOauthDirty(true);
              }}
            />
          </SettingRow>
          <div className="inset-actions">
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
          </div>
          <SettingRow title={t("driveRoot")} hint={t("driveHint")}>
            <input
              className="control"
              aria-label={t("driveRoot")}
              value={draft.drive.root}
              onChange={(event) => setConfig({ ...draft, drive: { root: event.target.value } })}
            />
          </SettingRow>
        </div>
      </Card>

      <Card>
        <CardHead title={t("groupPortrait")} />
        <div className="card-body">
          <div className="inset-actions">
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
          </div>
          <SettingRow title={t("snapshotPattern")}>
            <input
              className="control"
              aria-label={t("snapshotPattern")}
              value={draft.portrait.snapshotPattern}
              onChange={(event) =>
                setConfig({
                  ...draft,
                  portrait: { ...draft.portrait, snapshotPattern: event.target.value },
                })
              }
            />
          </SettingRow>
        </div>
      </Card>

      <Card>
        <CardHead title={t("groupModel")} hint={t("modelHint")} />
        <div className="card-body">
          <SettingRow title={t("provider")}>
            <ProviderPicker
              value={draft.llm.provider}
              language={language}
              onChange={(provider) =>
                setConfig({
                  ...draft,
                  llm: { ...draft.llm, provider: provider as SharedConfig["llm"]["provider"] },
                })
              }
            />
          </SettingRow>
          <SettingRow title={t("model")} {...(cli ? { hint: t("modelBlankHint") } : {})}>
            <input
              className="control"
              aria-label={t("model")}
              value={draft.llm.model}
              spellCheck={false}
              onChange={(event) =>
                setConfig({ ...draft, llm: { ...draft.llm, model: event.target.value } })
              }
            />
          </SettingRow>
          {cli ? null : (
            <>
              <SettingRow title={t("baseUrl")} hint={t("baseUrlHint")}>
                <input
                  className="control"
                  aria-label={t("baseUrl")}
                  value={draft.llm.baseUrl}
                  spellCheck={false}
                  placeholder="https://"
                  onChange={(event) =>
                    setConfig({ ...draft, llm: { ...draft.llm, baseUrl: event.target.value } })
                  }
                />
              </SettingRow>
              <SettingRow
                title={t("apiKey")}
                hint={`${providerNeedsKey(draft.llm.provider) ? t("apiKeyHint") : t("leaveBlank")} ${t("secretHint")}`}
              >
                <input
                  className="control"
                  type="password"
                  aria-label={t("apiKey")}
                  value={apiKey}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </SettingRow>
            </>
          )}
          <div className="inset-actions">
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
            {testMessage ? <p className="form-ok">{testMessage}</p> : null}
          </div>
        </div>
      </Card>

      <Card>
        <CardHead title={t("groupCapture")} hint={t("captureHint")} />
        <div className="card-body">
          <Row
            title={t("keepToolCalls")}
            trailing={
              <Toggle
                checked={draft.capture.keepToolCalls}
                label={t("keepToolCalls")}
                onChange={(checked) =>
                  setConfig({ ...draft, capture: { ...draft.capture, keepToolCalls: checked } })
                }
              />
            }
          />
          <Row
            title={t("includeSubagents")}
            trailing={
              <Toggle
                checked={draft.capture.includeSubagents}
                label={t("includeSubagents")}
                onChange={(checked) =>
                  setConfig({ ...draft, capture: { ...draft.capture, includeSubagents: checked } })
                }
              />
            }
          />
          <Row
            title={t("redact")}
            trailing={
              <Toggle
                checked={draft.capture.redact}
                label={t("redact")}
                onChange={(checked) =>
                  setConfig({ ...draft, capture: { ...draft.capture, redact: checked } })
                }
              />
            }
          />
          <div className="inset-actions">
            <div className="note">
              <strong>{t("uncollected")}</strong>
              <ul>
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          </div>
          {SOURCES.map((source) => {
            const item = draft.capture.sources[source];
            const open = openSource === source;
            return (
              <Row
                key={source}
                icon={<SourceMark source={source} />}
                title={sourceLabel(source)}
                subtitle={
                  <>
                    <i className={item.enabled ? "dot dot-ok" : "dot dot-muted"} />
                    <span>{item.enabled ? t("enabled") : t("disabledLabel")}</span>
                  </>
                }
                trailing={
                  <>
                    <Toggle
                      checked={item.enabled}
                      label={sourceLabel(source)}
                      onChange={(checked) =>
                        setConfig({
                          ...draft,
                          capture: {
                            ...draft.capture,
                            sources: {
                              ...draft.capture.sources,
                              [source]: { ...item, enabled: checked },
                            },
                          },
                        })
                      }
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      aria-expanded={open}
                      aria-label={t("sourceDetails")}
                      onClick={() => setOpenSource(open ? null : source)}
                    >
                      <Icon name={open ? "chevronUp" : "chevron"} size={16} />
                    </button>
                  </>
                }
              >
                {open ? (
                  <>
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
                  </>
                ) : null}
              </Row>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHead title={t("groupRefine")} hint={t("refineHint")} />
        <div className="card-body">
          <SettingRow title={t("idleMinutes")}>
            <input
              className="control"
              type="number"
              min={1}
              step={1}
              aria-label={t("idleMinutes")}
              value={draft.refine.idleMinutes}
              onChange={(event) =>
                setConfig({
                  ...draft,
                  refine: { idleMinutes: numberOrZero(event.target.valueAsNumber) },
                })
              }
            />
          </SettingRow>
        </div>
      </Card>

      <Card>
        <CardHead title={t("groupTopics")} hint={t("topicsHint")} />
        <div className="card-body">
          <SettingRow title={t("activeLimit")}>
            <input
              className="control"
              type="number"
              min={1}
              step={1}
              aria-label={t("activeLimit")}
              value={draft.topics.activeLimit}
              onChange={(event) =>
                setConfig({
                  ...draft,
                  topics: { ...draft.topics, activeLimit: numberOrZero(event.target.valueAsNumber) },
                })
              }
            />
          </SettingRow>
          <SettingRow title={t("historyDays")}>
            <input
              className="control"
              type="number"
              min={1}
              step={1}
              aria-label={t("historyDays")}
              value={draft.topics.historyDays}
              onChange={(event) =>
                setConfig({
                  ...draft,
                  topics: { ...draft.topics, historyDays: numberOrZero(event.target.valueAsNumber) },
                })
              }
            />
          </SettingRow>
        </div>
      </Card>

      <Card>
        <CardHead title={t("groupConsolidation")} hint={t("consolidationHint")} />
        <div className="card-body">
          <Row
            title={t("consolidationOn")}
            trailing={
              <Toggle
                checked={rolesDraft.consolidation.enabled}
                label={t("consolidationOn")}
                onChange={(checked) =>
                  setRolesDraft({
                    ...rolesDraft,
                    consolidation: { ...rolesDraft.consolidation, enabled: checked },
                  })
                }
              />
            }
          />
          <SettingRow title={t("consolidationTime")}>
            <input
              className="control"
              aria-label={t("consolidationTime")}
              value={rolesDraft.consolidation.time}
              onChange={(event) =>
                setRolesDraft({
                  ...rolesDraft,
                  consolidation: { ...rolesDraft.consolidation, time: event.target.value },
                })
              }
            />
          </SettingRow>
          <SettingRow title={t("timezone")}>
            <input
              className="control"
              aria-label={t("timezone")}
              value={rolesDraft.timezone}
              spellCheck={false}
              onChange={(event) => setRolesDraft({ ...rolesDraft, timezone: event.target.value })}
            />
          </SettingRow>
        </div>
      </Card>

      <Card>
        <CardHead title={t("groupReminders")} hint={t("remindersHint")} />
        <div className="card-body">
          <Row
            title={t("notifications")}
            trailing={
              <Toggle
                checked={draft.reminders.notifications}
                label={t("notifications")}
                onChange={(checked) =>
                  setConfig({
                    ...draft,
                    reminders: { ...draft.reminders, notifications: checked },
                  })
                }
              />
            }
          />
          <SettingRow title={t("morningTime")}>
            <input
              className="control"
              aria-label={t("morningTime")}
              value={draft.reminders.morningDigestTime}
              onChange={(event) =>
                setConfig({
                  ...draft,
                  reminders: { ...draft.reminders, morningDigestTime: event.target.value },
                })
              }
            />
          </SettingRow>
          <SettingRow title={t("weeklyDay")}>
            <Select
              label={t("weeklyDay")}
              value={String(draft.reminders.weeklyReviewDay)}
              onChange={(value) =>
                setConfig({
                  ...draft,
                  reminders: { ...draft.reminders, weeklyReviewDay: Number(value) },
                })
              }
            >
              {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                <option key={day} value={day}>
                  {weekdayName(day, language)}
                </option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow title={t("weeklyTime")}>
            <input
              className="control"
              aria-label={t("weeklyTime")}
              value={draft.reminders.weeklyReviewTime}
              onChange={(event) =>
                setConfig({
                  ...draft,
                  reminders: { ...draft.reminders, weeklyReviewTime: event.target.value },
                })
              }
            />
          </SettingRow>
        </div>
      </Card>

      <Card>
        <CardHead title={t("groupIntegrations")} hint={t("integrationsHint")} />
        <div className="card-body">
          <p className="inset-actions muted">{t("cursorHint")}</p>
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
        </div>
      </Card>

      <Card>
        <CardHead title={t("groupAppearance")} hint={t("themeHint")} />
        <div className="card-body">
          <Row
            title={t("themeLabel")}
            trailing={
              <Segmented
                label={t("themeLabel")}
                value={choice}
                options={[
                  { value: "system", label: t("themeSystem") },
                  { value: "light", label: t("themeLight") },
                  { value: "dark", label: t("themeDark") },
                ]}
                onChange={(value) => setChoice(themeChoice(value))}
              />
            }
          />
          <SettingRow title={t("language")}>
            <Select
              label={t("language")}
              value={draft.ui.language}
              onChange={(value) => {
                const next = value === "en" ? "en" : "zh";
                setLanguage(next);
                setConfig({ ...draft, ui: { ...draft.ui, language: next } });
              }}
            >
              <option value="zh">{t("languageZh")}</option>
              <option value="en">{t("languageEn")}</option>
            </Select>
          </SettingRow>
          <SettingRow title={t("shortcut")} hint={t("shortcutHint")}>
            <input
              className="control"
              aria-label={t("shortcut")}
              value={draft.ui.shortcut}
              spellCheck={false}
              onChange={(event) =>
                setConfig({ ...draft, ui: { ...draft.ui, shortcut: event.target.value } })
              }
            />
          </SettingRow>
        </div>
      </Card>
    </form>
  );
}

function SettingRow({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Row
      className="trail-field"
      title={title}
      trailing={children}
      {...(hint !== undefined ? { subtitle: hint } : {})}
    />
  );
}

function themeChoice(value: string): ThemeChoice {
  if (value === "light" || value === "dark") return value;
  return "system";
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
    <>
      <div className="card-head">
        <h2>{title}</h2>
      </div>
      {SOURCES.map((source) => {
        const on = selected.includes(source);
        return (
          <Row
            key={source}
            icon={<SourceMark source={source} />}
            title={sourceLabel(source)}
            trailing={
              <Toggle
                checked={on}
                label={`${title} ${sourceLabel(source)}`}
                onChange={(checked) => {
                  if (checked) onChange(on ? [...selected] : [...selected, source]);
                  else onChange(selected.filter((item) => item !== source));
                }}
              />
            }
          />
        );
      })}
    </>
  );
}
