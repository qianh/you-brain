import { CAPTURE_SOURCE_IDS, type SharedConfig } from "@you-brain/protocol";

import { Banner } from "../../components/banner.js";
import { Card, Section } from "../../components/card.js";
import { Row } from "../../components/row.js";
import { SourceTile } from "../../components/tile.js";
import { Toggle } from "../../components/toggle.js";
import { useDaemon } from "../../daemon-context.js";
import { sourceLabel } from "../../lib/format.js";
import { toggleMember } from "./logic.js";
import { NotionSection } from "./notion.js";
import { WebhookSection } from "./webhook.js";

const GROUPS = [
  { key: "mcpClients", title: "mcp" },
  { key: "codingPortraitClients", title: "codingPortrait" },
  { key: "skillClients", title: "skills" },
] as const;

export function IntegrationsSection({
  draft,
  onDraft,
}: {
  draft: SharedConfig;
  onDraft: (next: SharedConfig) => void;
}) {
  const { t } = useDaemon();

  return (
    <div className="settings-stack">
      <Banner tone="info">{t("cursorHint")}</Banner>
      {GROUPS.map((group) => {
        const selected = draft.integrations[group.key];
        return (
          <Section key={group.key} title={t(group.title)}>
            <Card>
              {CAPTURE_SOURCE_IDS.map((source) => {
                const on = selected.includes(source);
                return (
                  <Row
                    key={source}
                    icon={<SourceTile source={source} />}
                    title={sourceLabel(source)}
                    titleText={sourceLabel(source)}
                    trailing={
                      <Toggle
                        checked={on}
                        label={`${t(group.title)} ${sourceLabel(source)}`}
                        onChange={(checked) =>
                          onDraft({
                            ...draft,
                            integrations: {
                              ...draft.integrations,
                              [group.key]: toggleMember(selected, source, checked),
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
        );
      })}
      <WebhookSection />
      <NotionSection />
    </div>
  );
}
