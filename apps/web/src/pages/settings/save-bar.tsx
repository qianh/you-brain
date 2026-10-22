import { useLayoutEffect, useState, type RefObject } from "react";

import { Button } from "../../components/button.js";
import { Icon } from "../../components/icons.js";
import { Kbd } from "../../components/kbd.js";
import { useDaemon } from "../../daemon-context.js";
import { modLabel, shortcutMod } from "../../lib/shortcuts.js";

export function SaveBar({
  container,
  busy,
  error,
  onRevert,
  onSave,
}: {
  container: RefObject<HTMLElement | null>;
  busy: boolean;
  error: string | null;
  onRevert: () => void;
  onSave: () => void;
}) {
  const { t } = useDaemon();
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  const shortcut = `${modLabel(shortcutMod(navigator.platform))}S`;

  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      setBox({ left: rect.left, width: rect.width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [container]);

  return (
    <div
      className="settings-save"
      role="region"
      aria-label={t("settingsDirty")}
      style={box ? { left: box.left, width: box.width } : undefined}
    >
      <div className="settings-save-row">
        <p className="settings-save-copy">
          <Icon name="info" />
          <span>{t("settingsDirty")}</span>
        </p>
        <div className="settings-save-actions">
          <Button variant="ghost" size="sm" onClick={onRevert} disabled={busy}>
            {t("settingsRevert")}
          </Button>
          <Button variant="primary" size="sm" loading={busy} onClick={onSave}>
            {t("settingsSave")}
            <Kbd>{shortcut}</Kbd>
          </Button>
        </div>
      </div>
      {error ? (
        <p className="settings-save-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
