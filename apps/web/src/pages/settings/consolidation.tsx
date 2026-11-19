import { useEffect, useState } from "react";
import type { Roles, SharedConfig } from "@you-brain/protocol";

import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Card, Section } from "../../components/card.js";
import { Input } from "../../components/input.js";
import { Select } from "../../components/select.js";
import { ProviderTile } from "../../components/tile.js";
import { useToast } from "../../components/toast.js";
import { Toggle } from "../../components/toggle.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { formatDateTime, LLM_PROVIDER_IDS, providerLabel, weekdayName } from "../../lib/format.js";
import { consolidateGate, formatConsolidationRun } from "./consolidation-status.js";
import { isCliProvider, isTimeOfDay, providerOptions } from "./logic.js";
import { SettingRow } from "./setting-row.js";

function validHttpUrlOrEmpty(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function ConsolidationSection({
  draft,
  roles,
  issues,
  onDraft,
  onRoles,
}: {
  draft: SharedConfig;
  roles: Roles;
  issues: readonly MessageKey[];
  onDraft: (next: SharedConfig) => void;
  onRoles: (next: Roles) => void;
}) {
  const { t, language, timeZone, status, roles: savedRoles, client, reload } = useDaemon();
  const { push } = useToast();
  const [running, setRunning] = useState(false);
  const [gatewayModels, setGatewayModels] = useState<Array<{ id: string; name?: string }> | null>(null);
  const consolidateMagpie = draft.consolidateLlm.enabled && draft.consolidateLlm.provider === "magpie";

  useEffect(() => {
    if (!consolidateMagpie) {
      setGatewayModels(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      client
        .llmModels({ provider: "magpie", baseUrl: draft.consolidateLlm.baseUrl })
        .then((view) => {
          if (!cancelled) setGatewayModels(view.models);
        })
        .catch(() => {
          if (!cancelled) setGatewayModels([]);
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [consolidateMagpie, draft.consolidateLlm.baseUrl, client]);
  const finished = status?.consolidation.lastFinishedAt ?? null;
  const relative = useRelativeTime(finished, language, timeZone);
  const absolute = formatDateTime(finished, language, timeZone);
  const lastRun = status?.consolidation.lastRun;
  const runDetail = lastRun
    ? formatConsolidationRun(lastRun, {
        succeeded: t("consolidateSucceeded"),
        failed: t("consolidateFailedRun"),
      })
    : null;
  const gate = consolidateGate({
    enabled: status?.consolidation.enabled === true,
    deviceId: status?.deviceId ?? null,
    mainDevice: savedRoles?.mainDevice ?? null,
  });
  const backendRunning = status?.consolidation.running === true;
  const isRunning = running || backendRunning;
  const blocked =
    gate !== "ready"
      ? t(gate === "not-main" ? "consolidateNotMain" : "consolidateOff")
      : backendRunning
        ? t("consolidateRunning")
        : null;
  const timeError = issues.includes("invalidTime") ? t("invalidTime") : undefined;
  const zoneError = issues.includes("invalidZone") ? t("invalidZone") : undefined;
  const baseError = issues.includes("invalidBase") ? t("invalidBase") : undefined;
  const timeProps = (value: string): { error: string } | Record<string, never> =>
    timeError && !isTimeOfDay(value) ? { error: timeError } : {};
  const consolidateCli = isCliProvider(draft.consolidateLlm.provider);
  const groups = { local: t("settingsGroupLocal"), api: t("providerGroupApi") };
  const consolidateProviderOpts = providerOptions(LLM_PROVIDER_IDS).map((option) => {
    const label = providerLabel(option.value, language);
    return {
      value: option.value,
      label,
      group: groups[option.group],
      icon: <ProviderTile provider={option.value} label={label} size="sm" />,
    };
  });

  async function runNow(): Promise<void> {
    if (isRunning || gate !== "ready") return;
    setRunning(true);
    try {
      const result = await client.consolidate({ force: true });
      const failed = result.steps.find((step) => !step.ok);
      push({
        message: result.ok ? t("consolidateDone") : failed?.error || t("actionFailed"),
        tone: result.ok ? "success" : "danger",
      });
      await reload("status");
    } catch (caught) {
      if (caught instanceof BrowserDaemonError && caught.code === "CONSOLIDATION_RUNNING") {
        push({ message: t("consolidateRunning"), tone: "danger" });
        await reload("status");
      } else {
        const message =
          caught instanceof BrowserDaemonError && caught.message !== "" ? caught.message : t("actionFailed");
        push({ message, tone: "danger" });
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="settings-stack">
      <Section title={t("groupConsolidation")}>
        <Card>
          <SettingRow title={t("consolidationOn")} control="toggle">
            <Toggle
              checked={roles.consolidation.enabled}
              label={t("consolidationOn")}
              onChange={(checked) =>
                onRoles({ ...roles, consolidation: { ...roles.consolidation, enabled: checked } })
              }
            />
          </SettingRow>
          <SettingRow title={t("consolidationTime")}>
            <Input
              label={t("consolidationTime")}
              value={roles.consolidation.time}
              spellCheck={false}
              {...timeProps(roles.consolidation.time)}
              onChange={(event) =>
                onRoles({ ...roles, consolidation: { ...roles.consolidation, time: event.target.value } })
              }
            />
          </SettingRow>
          <SettingRow title={t("timezone")}>
            <Input
              label={t("timezone")}
              className="settings-mono"
              value={roles.timezone}
              spellCheck={false}
              {...(zoneError ? { error: zoneError } : {})}
              onChange={(event) => onRoles({ ...roles, timezone: event.target.value })}
            />
          </SettingRow>
          <SettingRow title={t("consolidateCustomLlm")} hint={t("consolidateCustomLlmHint")} control="toggle">
            <Toggle
              checked={draft.consolidateLlm.enabled}
              label={t("consolidateCustomLlm")}
              onChange={(checked) =>
                onDraft({
                  ...draft,
                  consolidateLlm: { ...draft.consolidateLlm, enabled: checked },
                })
              }
            />
          </SettingRow>
          {draft.consolidateLlm.enabled ? (
            <>
              <SettingRow title={t("provider")} control="select">
                <span className="settings-provider">
                  <Select
                    label={t("provider")}
                    value={draft.consolidateLlm.provider}
                    options={consolidateProviderOpts}
                    onChange={(value) =>
                      onDraft({
                        ...draft,
                        consolidateLlm: {
                          ...draft.consolidateLlm,
                          provider: value as SharedConfig["consolidateLlm"]["provider"],
                        },
                      })
                    }
                  />
                </span>
              </SettingRow>
              <SettingRow
                title={t("model")}
                {...(consolidateCli
                  ? { hint: t("modelBlankHint") }
                  : consolidateMagpie && (!gatewayModels || gatewayModels.length === 0)
                    ? { hint: t("magpieModelHint") }
                    : {})}
              >
                {consolidateMagpie && gatewayModels && gatewayModels.length > 0 ? (
                  <Select
                    label={t("model")}
                    value={draft.consolidateLlm.model}
                    placeholder={t("magpieModelPlaceholder")}
                    options={[
                      ...(draft.consolidateLlm.model.trim() !== "" &&
                      !gatewayModels.some((item) => item.id === draft.consolidateLlm.model)
                        ? [{ value: draft.consolidateLlm.model, label: draft.consolidateLlm.model }]
                        : []),
                      ...gatewayModels.map((item) => ({ value: item.id, label: item.name ?? item.id })),
                    ]}
                    onChange={(value) =>
                      onDraft({
                        ...draft,
                        consolidateLlm: { ...draft.consolidateLlm, model: value },
                      })
                    }
                  />
                ) : (
                  <Input
                    label={t("model")}
                    value={draft.consolidateLlm.model}
                    spellCheck={false}
                    onChange={(event) =>
                      onDraft({
                        ...draft,
                        consolidateLlm: { ...draft.consolidateLlm, model: event.target.value },
                      })
                    }
                  />
                )}
              </SettingRow>
              {consolidateCli ? null : (
                <SettingRow title={t("baseUrl")} hint={t("baseUrlHint")}>
                  <Input
                    label={t("baseUrl")}
                    className="settings-mono"
                    value={draft.consolidateLlm.baseUrl}
                    spellCheck={false}
                    placeholder="https://"
                    {...(baseError && !validHttpUrlOrEmpty(draft.consolidateLlm.baseUrl)
                      ? { error: baseError }
                      : {})}
                    onChange={(event) =>
                      onDraft({
                        ...draft,
                        consolidateLlm: { ...draft.consolidateLlm, baseUrl: event.target.value },
                      })
                    }
                  />
                </SettingRow>
              )}
            </>
          ) : null}
          <SettingRow
            title={t("consolidation")}
            control="toggle"
            {...(runDetail !== null
              ? {
                  hint:
                    lastRun?.ok === false ? (
                      <span className="settings-inline-bad">{t("consolidateLastRun", { detail: runDetail })}</span>
                    ) : (
                      t("consolidateLastRun", { detail: runDetail })
                    ),
                }
              : {})}
          >
            {finished ? (
              <time className="settings-status" dateTime={finished} title={absolute}>
                {relative}
              </time>
            ) : (
              <span className="settings-quiet">{t("consolidationNever")}</span>
            )}
          </SettingRow>
          <SettingRow
            title={t("consolidateNow")}
            control="toggle"
            {...(blocked !== null ? { hint: blocked } : {})}
          >
            <Button
              variant="primary"
              size="sm"
              loading={isRunning}
              disabled={gate !== "ready" || isRunning}
              onClick={() => {
                void runNow();
              }}
            >
              {t("consolidateNow")}
            </Button>
          </SettingRow>
        </Card>
      </Section>
      <Section title={t("groupReminders")} hint={t("remindersHint")}>
        <Card>
          <SettingRow title={t("notifications")} control="toggle">
            <Toggle
              checked={draft.reminders.notifications}
              label={t("notifications")}
              onChange={(checked) =>
                onDraft({ ...draft, reminders: { ...draft.reminders, notifications: checked } })
              }
            />
          </SettingRow>
          <SettingRow title={t("morningTime")}>
            <Input
              label={t("morningTime")}
              value={draft.reminders.morningDigestTime}
              spellCheck={false}
              {...timeProps(draft.reminders.morningDigestTime)}
              onChange={(event) =>
                onDraft({ ...draft, reminders: { ...draft.reminders, morningDigestTime: event.target.value } })
              }
            />
          </SettingRow>
          <SettingRow title={t("weeklyDay")} control="select">
            <Select
              label={t("weeklyDay")}
              value={String(draft.reminders.weeklyReviewDay)}
              onChange={(value) =>
                onDraft({ ...draft, reminders: { ...draft.reminders, weeklyReviewDay: Number(value) } })
              }
              options={[1, 2, 3, 4, 5, 6, 7].map((day) => ({
                value: String(day),
                label: weekdayName(day, language),
              }))}
            />
          </SettingRow>
          <SettingRow title={t("weeklyTime")}>
            <Input
              label={t("weeklyTime")}
              value={draft.reminders.weeklyReviewTime}
              spellCheck={false}
              {...timeProps(draft.reminders.weeklyReviewTime)}
              onChange={(event) =>
                onDraft({ ...draft, reminders: { ...draft.reminders, weeklyReviewTime: event.target.value } })
              }
            />
          </SettingRow>
        </Card>
      </Section>
    </div>
  );
}
