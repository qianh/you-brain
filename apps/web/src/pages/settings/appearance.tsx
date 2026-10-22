import { useEffect, useState } from "react";
import type { SharedConfig } from "@you-brain/protocol";

import { Card } from "../../components/card.js";
import { Icon } from "../../components/icons.js";
import { Input } from "../../components/input.js";
import { Kbd } from "../../components/kbd.js";
import { Segmented } from "../../components/segmented.js";
import { useDaemon } from "../../daemon-context.js";
import { modLabel, shortcutMod } from "../../lib/shortcuts.js";
import { useTheme, type ThemeChoice } from "../../theme-context.js";
import { shortcutGlyph, shortcutParts } from "./logic.js";
import { SettingRow } from "./setting-row.js";

const THEMES: readonly ThemeChoice[] = ["system", "light", "dark"];

export function AppearanceSection({
  draft,
  onAppearance,
}: {
  draft: SharedConfig;
  onAppearance: (patch: Partial<SharedConfig["ui"]>) => Promise<void>;
}) {
  const { t, language } = useDaemon();
  const { choice, setChoice } = useTheme();
  const [shortcut, setShortcut] = useState(draft.ui.shortcut);
  const mod = modLabel(shortcutMod(navigator.platform));
  const glyphs = shortcutParts(shortcut).map((part) => shortcutGlyph(part, mod === "⌘" ? "⌘" : "Ctrl"));

  useEffect(() => setShortcut(draft.ui.shortcut), [draft.ui.shortcut]);

  const commitShortcut = (): void => {
    if (shortcut !== draft.ui.shortcut) void onAppearance({ shortcut });
  };

  const moveTheme = (delta: number): void => {
    const index = THEMES.indexOf(choice);
    const next = THEMES[(index + delta + THEMES.length) % THEMES.length];
    if (next) setChoice(next);
  };

  return (
    <div className="settings-stack">
      <Card>
        <div className="settings-block-label" id="settings-theme-label">
          {t("themeLabel")}
        </div>
        <div
          className="settings-themes"
          role="radiogroup"
          aria-labelledby="settings-theme-label"
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            moveTheme(event.key === "ArrowRight" ? 1 : -1);
          }}
        >
          {THEMES.map((theme) => {
            const selected = choice === theme;
            const label = theme === "system" ? t("themeSystem") : theme === "light" ? t("themeLight") : t("themeDark");
            return (
              <button
                key={theme}
                type="button"
                className="settings-theme"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setChoice(theme)}
              >
                <ThemePreview theme={theme} />
                <span className="settings-theme-name">
                  {label}
                  {selected ? <Icon name="check" /> : null}
                </span>
              </button>
            );
          })}
        </div>
        <p className="settings-theme-hint">{t("themeHint")}</p>
      </Card>
      <Card>
        <SettingRow title={t("language")} control="wide">
          <Segmented
            label={t("language")}
            labelledBy="radiogroup"
            value={language}
            options={[
              { value: "zh", label: t("languageZh") },
              { value: "en", label: t("languageEn") },
            ]}
            onChange={(value) => {
              const next = value === "en" ? "en" : "zh";
              if (next !== language) void onAppearance({ language: next });
            }}
          />
        </SettingRow>
        <SettingRow
          title={t("shortcut")}
          hint={
            <span className="settings-shortcut-hint">
              {glyphs.length > 0 ? (
                <span className="settings-chords">
                  {glyphs.map((glyph, index) => (
                    <Kbd key={`${glyph}-${index}`}>{glyph}</Kbd>
                  ))}
                </span>
              ) : null}
              <span>{t("shortcutHint")}</span>
            </span>
          }
        >
          <Input
            label={t("shortcut")}
            className="settings-mono"
            value={shortcut}
            spellCheck={false}
            onChange={(event) => setShortcut(event.target.value)}
            onBlur={commitShortcut}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitShortcut();
              }
            }}
          />
        </SettingRow>
      </Card>
    </div>
  );
}

function ThemePreview({ theme }: { theme: ThemeChoice }) {
  if (theme === "system") {
    return (
      <span className="settings-preview split">
        <span className="settings-preview-pane" data-theme="light">
          <Mini />
        </span>
        <span className="settings-preview-pane" data-theme="dark">
          <Mini />
        </span>
      </span>
    );
  }
  return (
    <span className="settings-preview" data-theme={theme}>
      <Mini />
    </span>
  );
}

function Mini() {
  return (
    <span className="settings-mini">
      <span className="settings-mini-bar" />
      <span className="settings-mini-line" />
      <span className="settings-mini-line short" />
    </span>
  );
}
