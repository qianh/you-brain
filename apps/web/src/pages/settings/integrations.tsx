import type { SharedConfig } from "@you-brain/protocol";

import { Banner } from "../../components/banner.js";
import { Card, Section } from "../../components/card.js";
import { Row } from "../../components/row.js";
import { SourceTile } from "../../components/tile.js";
import { Toggle } from "../../components/toggle.js";
import { useDaemon } from "../../daemon-context.js";
import { sourceLabel } from "../../lib/format.js";
import { DispatchSection } from "./dispatch.js";
import { toggleMember } from "./logic.js";
import { NotionSection } from "./notion.js";
import { SearchKeySection } from "./search-key.js";
import { TelegramSection } from "./telegram.js";
import { WebhookSection } from "./webhook.js";

/** Only CLI tools with a managed global instructions file support auto-injecting coding.md. */
export const PORTRAIT_INJECTABLE_CLIENTS = [
  "claude-code",
  "codex",
  "grok-build",
  "gemini-cli",
] as const;

export function IntegrationsSection({
  draft,
  onDraft,
}: {
  draft: SharedConfig;
  onDraft: (next: SharedConfig) => void;
}) {
  const { t } = useDaemon();
  const selected = draft.integrations.codingPortraitClients;

  return (
    <div className="settings-stack">
      <Banner tone="info">{t("cursorHint")}</Banner>
      <Section title={t("codingPortrait")}>
        <Card>
          {PORTRAIT_INJECTABLE_CLIENTS.map((source) => (
            <Row
              key={source}
              icon={<SourceTile source={source} />}
              title={sourceLabel(source)}
              titleText={sourceLabel(source)}
              trailing={
                <Toggle
                  checked={selected.includes(source)}
                  label={`${t("codingPortrait")} ${sourceLabel(source)}`}
                  onChange={(checked) =>
                    onDraft({
                      ...draft,
                      integrations: {
                        ...draft.integrations,
                        codingPortraitClients: toggleMember(selected, source, checked),
                      },
                    })
                  }
                />
              }
            />
          ))}
        </Card>
      </Section>
      <WebhookSection />
      <TelegramSection />
      <DispatchSection />
      <NotionSection />
      <SearchKeySection />
    </div>
  );
}
