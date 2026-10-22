import { useState } from "react";
import { CAPTURE_SOURCE_IDS, type CaptureSourceId, type SharedConfig } from "@you-brain/protocol";

import { Card } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { Icon } from "../../components/icons.js";
import { IconButton } from "../../components/button.js";
import { Row } from "../../components/row.js";
import { SourceTile } from "../../components/tile.js";
import { Toggle } from "../../components/toggle.js";
import { useDaemon } from "../../daemon-context.js";
import { uncollectedNotes } from "../../lib/copy.js";
import { sourceLabel } from "../../lib/format.js";
import { ListField, SettingRow } from "./setting-row.js";

export function CaptureSection({
  draft,
  onDraft,
}: {
  draft: SharedConfig;
  onDraft: (next: SharedConfig) => void;
}) {
  const { t, language } = useDaemon();
  const [openSource, setOpenSource] = useState<CaptureSourceId | null>(null);
  const notes = uncollectedNotes(draft.capture, language);

  const setFlag = (key: "keepToolCalls" | "includeSubagents" | "redact", checked: boolean): void => {
    onDraft({ ...draft, capture: { ...draft.capture, [key]: checked } });
  };

  return (
    <Card>
      <SettingRow title={t("keepToolCalls")} control="toggle">
        <Toggle checked={draft.capture.keepToolCalls} label={t("keepToolCalls")} onChange={(checked) => setFlag("keepToolCalls", checked)} />
      </SettingRow>
      <SettingRow title={t("includeSubagents")} control="toggle">
        <Toggle
          checked={draft.capture.includeSubagents}
          label={t("includeSubagents")}
          onChange={(checked) => setFlag("includeSubagents", checked)}
        />
      </SettingRow>
      <SettingRow title={t("redact")} control="toggle">
        <Toggle checked={draft.capture.redact} label={t("redact")} onChange={(checked) => setFlag("redact", checked)} />
      </SettingRow>
      <div className="settings-notes">
        <strong>{t("uncollected")}</strong>
        <ul>
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
      {CAPTURE_SOURCE_IDS.map((source) => {
        const item = draft.capture.sources[source];
        const open = openSource === source;
        const update = (patch: Partial<typeof item>): void => {
          onDraft({
            ...draft,
            capture: {
              ...draft.capture,
              sources: { ...draft.capture.sources, [source]: { ...item, ...patch } },
            },
          });
        };
        return (
          <Row
            key={source}
            icon={<SourceTile source={source} />}
            title={sourceLabel(source)}
            titleText={sourceLabel(source)}
            subtitle={
              <Chip tone={item.enabled ? "success" : "neutral"} dot>
                {item.enabled ? t("enabled") : t("disabledLabel")}
              </Chip>
            }
            trailing={
              <>
                <Toggle checked={item.enabled} label={sourceLabel(source)} onChange={(checked) => update({ enabled: checked })} />
                <IconButton
                  label={t("sourceDetails")}
                  aria-expanded={open}
                  onClick={() => setOpenSource(open ? null : source)}
                >
                  <Icon name={open ? "chevron-up" : "chevron-down"} />
                </IconButton>
              </>
            }
          >
            {open ? (
              <>
                <ListField label={t("paths")} value={item.paths} onChange={(paths) => update({ paths })} />
                <ListField label={t("includeGlobs")} value={item.include} onChange={(include) => update({ include })} />
                <ListField label={t("excludeGlobs")} value={item.exclude} onChange={(exclude) => update({ exclude })} />
              </>
            ) : null}
          </Row>
        );
      })}
    </Card>
  );
}
