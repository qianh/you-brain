import { useEffect, useRef, useState } from "react";

import { Icon } from "../../components/icons.js";
import { useDaemon } from "../../daemon-context.js";
import { SETTINGS_SECTIONS, settingsHref, type SettingsSection } from "../../lib/route.js";
import { SETTINGS_NAV, nextSection } from "./meta.js";

export function SettingsNav({
  section,
  onOpen,
}: {
  section: SettingsSection;
  onOpen: (section: SettingsSection) => void;
}) {
  const { t } = useDaemon();
  const refs = useRef<Array<HTMLAnchorElement | null>>([]);
  const [horizontal, setHorizontal] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 759px)");
    const apply = (): void => setHorizontal(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const index = SETTINGS_SECTIONS.indexOf(section);
    refs.current[index]?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [section]);

  const move = (delta: number): void => {
    const next = nextSection(section, delta);
    onOpen(next);
    const index = SETTINGS_SECTIONS.indexOf(next);
    refs.current[index]?.focus();
  };

  return (
    <nav className="settings-nav" aria-label={t("settings")}>
      <div
        className="settings-nav-list"
        role="tablist"
        aria-orientation={horizontal ? "horizontal" : "vertical"}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            event.preventDefault();
            move(-1);
          } else if (event.key === "Home") {
            event.preventDefault();
            onOpen(SETTINGS_SECTIONS[0] ?? "account");
            refs.current[0]?.focus();
          } else if (event.key === "End") {
            event.preventDefault();
            const last = SETTINGS_SECTIONS.length - 1;
            onOpen(SETTINGS_SECTIONS[last] ?? "appearance");
            refs.current[last]?.focus();
          }
        }}
      >
        {SETTINGS_NAV.map((item, index) => {
          const selected = item.id === section;
          return (
            <a
              key={item.id}
              ref={(node) => {
                refs.current[index] = node;
              }}
              className="settings-nav-item"
              href={settingsHref(item.id)}
              role="tab"
              aria-selected={selected}
              aria-controls="settings-panel"
              tabIndex={selected ? 0 : -1}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault();
                onOpen(item.id);
              }}
            >
              <Icon name={item.icon} />
              <span>{t(item.label)}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
