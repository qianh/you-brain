import { useState } from "react";
import type { Roles, SharedConfig } from "@you-brain/protocol";

import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Card, Section } from "../../components/card.js";
import { Input } from "../../components/input.js";
import { Select } from "../../components/select.js";
import { useToast } from "../../components/toast.js";
import { Toggle } from "../../components/toggle.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { formatDateTime, weekdayName } from "../../lib/format.js";
import { consolidateGate, formatConsolidationRun } from "./consolidation-status.js";
import { isTimeOfDay } from "./logic.js";
import { SettingRow } from "./setting-row.js";

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
  const blocked = gate === "ready" ? null : t(gate === "not-main" ? "consolidateNotMain" : "consolidateOff");
  const timeError = issues.includes("invalidTime") ? t("invalidTime") : undefined;
  const zoneError = issues.includes("invalidZone") ? t("invalidZone") : undefined;
  const timeProps = (value: string): { error: string } | Record<string, never> =>
    timeError && !isTimeOfDay(value) ? { error: timeError } : {};

  async function runNow(): Promise<void> {
    if (running || gate !== "ready") return;
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
      const message =
        caught instanceof BrowserDaemonError && caught.message !== "" ? caught.message : t("actionFailed");
      push({ message, tone: "danger" });
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
              loading={running}
              disabled={gate !== "ready"}
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
