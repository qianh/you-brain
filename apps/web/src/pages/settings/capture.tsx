import { useState } from "react";
import { CAPTURE_SOURCE_IDS, type CaptureSourceId, type Roles, type SharedConfig } from "@you-brain/protocol";

import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Card, Section } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { Input } from "../../components/input.js";
import { Row } from "../../components/row.js";
import { SourceTile } from "../../components/tile.js";
import { useToast } from "../../components/toast.js";
import { Toggle } from "../../components/toggle.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { formatDateTime, sourceLabel } from "../../lib/format.js";
import { prefs } from "../../lib/prefs.js";
import { TERMINAL_NOTIFY_KEY, terminalNotifyOn, terminalNotifyValue } from "../../lib/terminal-notify.js";
import { readCaptureCounts } from "../status/logic.js";
import { consolidateGate, formatConsolidationRun } from "./consolidation-status.js";
import { isTimeOfDay, numberOrZero } from "./logic.js";
import { SettingRow } from "./setting-row.js";

const ACTIVE_CAPTURE_SOURCES: readonly CaptureSourceId[] = CAPTURE_SOURCE_IDS.filter(
  (source): source is CaptureSourceId => source !== "deck",
);

export function CaptureSection({
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
  // 终端会话提醒偏好由 daemon 即时保存，不走底部保存栏。
  const [notifyOn, setNotifyOn] = useState(() => terminalNotifyOn(prefs.getItem(TERMINAL_NOTIFY_KEY)));

  const counts = readCaptureCounts(status);
  const limitError = issues.includes("invalidLimit") ? t("invalidLimit") : undefined;
  const timeError =
    issues.includes("invalidTime") && !isTimeOfDay(roles.consolidation.time)
      ? t("invalidTime")
      : undefined;

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
      <Section title={t("groupCapture")}>
        <Card>
          {ACTIVE_CAPTURE_SOURCES.map((source) => {
            const item = draft.capture.sources[source];
            const count = counts.get(source);
            return (
              <Row
                key={source}
                icon={<SourceTile source={source} />}
                title={sourceLabel(source)}
                titleText={sourceLabel(source)}
                subtitle={
                  <span className="dispatch-chips">
                    <Chip tone={item.enabled ? "success" : "neutral"} dot>
                      {item.enabled ? t("enabled") : t("disabledLabel")}
                    </Chip>
                    {count !== undefined ? (
                      <span className="settings-quiet">{t("statusCapturedCount", { count })}</span>
                    ) : null}
                  </span>
                }
                trailing={
                  <Toggle
                    checked={item.enabled}
                    label={sourceLabel(source)}
                    onChange={(checked) =>
                      onDraft({
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
                }
              />
            );
          })}
        </Card>
      </Section>

      <Section title={t("captureMemoryTitle")}>
        <Card>
          <SettingRow title={t("activeLimit")} hint={t("topicsHint")}>
            <Input
              label={t("activeLimit")}
              type="number"
              min={1}
              step={1}
              value={draft.topics.activeLimit}
              {...(limitError ? { error: limitError } : {})}
              onChange={(event) =>
                onDraft({
                  ...draft,
                  topics: { ...draft.topics, activeLimit: numberOrZero(event.target.valueAsNumber) },
                })
              }
            />
          </SettingRow>
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
              {...(timeError ? { error: timeError } : {})}
              onChange={(event) =>
                onRoles({ ...roles, consolidation: { ...roles.consolidation, time: event.target.value } })
              }
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

      <Section title={t("captureAlertsTitle")} hint={t("remindersHint")}>
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
          <SettingRow title={t("terminalNotify")} hint={t("terminalNotifyHint")} control="toggle">
            <Toggle
              checked={notifyOn}
              label={t("terminalNotify")}
              onChange={(checked) => {
                const value = terminalNotifyValue(checked);
                if (value === null) prefs.removeItem(TERMINAL_NOTIFY_KEY);
                else prefs.setItem(TERMINAL_NOTIFY_KEY, value);
                setNotifyOn(checked);
              }}
            />
          </SettingRow>
        </Card>
      </Section>
    </div>
  );
}
