import type { SharedConfig } from "@you-brain/protocol";

import { Card } from "../../components/card.js";
import { Section } from "../../components/card.js";
import { Input } from "../../components/input.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { numberOrZero } from "./logic.js";
import { SettingRow } from "./setting-row.js";

export function RefineSection({
  draft,
  issues,
  onDraft,
}: {
  draft: SharedConfig;
  issues: readonly MessageKey[];
  onDraft: (next: SharedConfig) => void;
}) {
  const { t } = useDaemon();
  const idleError = issues.includes("invalidIdle") ? t("invalidIdle") : undefined;
  const limitError = issues.includes("invalidLimit") ? t("invalidLimit") : undefined;
  const historyError = issues.includes("invalidHistory") ? t("invalidHistory") : undefined;

  return (
    <div className="settings-stack">
      <Section title={t("groupRefine")}>
        <Card>
          <SettingRow title={t("idleMinutes")}>
            <Input
              label={t("idleMinutes")}
              type="number"
              min={1}
              step={1}
              value={draft.refine.idleMinutes}
              {...(idleError ? { error: idleError } : {})}
              onChange={(event) =>
                onDraft({ ...draft, refine: { idleMinutes: numberOrZero(event.target.valueAsNumber) } })
              }
            />
          </SettingRow>
        </Card>
      </Section>
      <Section title={t("groupTopics")} hint={t("topicsHint")}>
        <Card>
          <SettingRow title={t("activeLimit")}>
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
          <SettingRow title={t("historyDays")}>
            <Input
              label={t("historyDays")}
              type="number"
              min={1}
              step={1}
              value={draft.topics.historyDays}
              {...(historyError ? { error: historyError } : {})}
              onChange={(event) =>
                onDraft({
                  ...draft,
                  topics: { ...draft.topics, historyDays: numberOrZero(event.target.valueAsNumber) },
                })
              }
            />
          </SettingRow>
        </Card>
      </Section>
    </div>
  );
}
