import type { Roles, SharedConfig } from "@you-brain/protocol";

import { Card, Section } from "../../components/card.js";
import { Input } from "../../components/input.js";
import { Select } from "../../components/select.js";
import { Toggle } from "../../components/toggle.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { weekdayName } from "../../lib/format.js";
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
  const { t, language } = useDaemon();
  const timeError = issues.includes("invalidTime") ? t("invalidTime") : undefined;
  const zoneError = issues.includes("invalidZone") ? t("invalidZone") : undefined;
  const timeProps = (value: string): { error: string } | Record<string, never> =>
    timeError && !isTimeOfDay(value) ? { error: timeError } : {};

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
