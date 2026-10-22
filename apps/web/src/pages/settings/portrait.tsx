import type { SharedConfig } from "@you-brain/protocol";

import { Button, IconButton } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { FieldError, Input } from "../../components/input.js";
import { Icon } from "../../components/icons.js";
import { useDaemon } from "../../daemon-context.js";
import type { MessageKey } from "../../i18n/messages.js";
import { SettingRow } from "./setting-row.js";

export function PortraitSection({
  draft,
  issues,
  onDraft,
}: {
  draft: SharedConfig;
  issues: readonly MessageKey[];
  onDraft: (next: SharedConfig) => void;
}) {
  const { t } = useDaemon();
  const variants = draft.portrait.variants;
  const invalid = issues.includes("invalidVariant");

  const write = (next: SharedConfig["portrait"]["variants"]): void => {
    onDraft({ ...draft, portrait: { ...draft.portrait, variants: next } });
  };

  return (
    <Card>
      <div className="settings-variants">
        <p className="settings-kicker">{t("variants")}</p>
        {variants.map((variant, index) => (
          <div key={`${variant.id}-${index}`} className="settings-variant">
            <Input
              label={t("variantId")}
              value={variant.id}
              spellCheck={false}
              onChange={(event) => {
                const id = event.target.value;
                write(variants.map((item, itemIndex) => (itemIndex === index ? { ...item, id } : item)));
              }}
            />
            <Input
              label={t("variantPath")}
              className="settings-mono"
              value={variant.path}
              spellCheck={false}
              onChange={(event) => {
                const path = event.target.value;
                write(variants.map((item, itemIndex) => (itemIndex === index ? { ...item, path } : item)));
              }}
            />
            <IconButton
              label={variants.length < 2 ? t("settingsKeepVariant") : t("remove")}
              disabled={variants.length < 2}
              onClick={() => write(variants.filter((_, itemIndex) => itemIndex !== index))}
            >
              <Icon name="trash" />
            </IconButton>
          </div>
        ))}
        {invalid ? <FieldError>{t("invalidVariant")}</FieldError> : null}
        <div>
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="plus" />}
            onClick={() => write([...variants, { id: "custom", path: "digital-twin/custom.md" }])}
          >
            {t("addVariant")}
          </Button>
        </div>
      </div>
      <div className="settings-snapshot">
        <span className="settings-kicker">{t("snapshotPattern")}</span>
        <Input
          label={t("snapshotPattern")}
          className="settings-mono"
          value={draft.portrait.snapshotPattern}
          spellCheck={false}
          onChange={(event) =>
            onDraft({ ...draft, portrait: { ...draft.portrait, snapshotPattern: event.target.value } })
          }
        />
      </div>
    </Card>
  );
}
