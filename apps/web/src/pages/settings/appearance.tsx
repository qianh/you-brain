import type { SharedConfig } from "@you-brain/protocol";

import { Card } from "../../components/card.js";
import { Icon } from "../../components/icons.js";
import { Segmented } from "../../components/segmented.js";
import { useDaemon } from "../../daemon-context.js";
import { useTheme, type ThemeChoice } from "../../theme-context.js";
import { SettingRow } from "./setting-row.js";

const THEMES: readonly ThemeChoice[] = ["system", "light", "dark", "dopamine"];

const THEME_LABEL = {
  system: "themeSystem",
  light: "themeLight",
  dark: "themeDark",
  dopamine: "themeDopamine",
} as const satisfies Record<ThemeChoice, string>;

export function AppearanceSection({
  onAppearance,
}: {
  onAppearance: (patch: Partial<SharedConfig["ui"]>) => Promise<void>;
}) {
  const { t, language } = useDaemon();
  const { choice, setChoice } = useTheme();

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
            const label = t(THEME_LABEL[theme]);
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
