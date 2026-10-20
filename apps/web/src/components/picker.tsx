import { useEffect, useId, useRef, useState } from "react";

import { useDaemon } from "../daemon-context.js";
import { LLM_PROVIDER_IDS, providerLabel, type Language } from "../lib/format.js";
import { Icon } from "./icons.js";
import { Popover } from "./popover.js";

type ProviderGroup = "all" | "api" | "local";

export function ProviderPicker({
  value,
  language,
  onChange,
}: {
  value: string;
  language: Language;
  onChange: (value: string) => void;
}) {
  const { t } = useDaemon();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<ProviderGroup>("all");
  const searchId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const needle = query.trim().toLocaleLowerCase();
  const matches = (provider: string): boolean => {
    if (group === "api" && provider.endsWith("-cli")) return false;
    if (group === "local" && !provider.endsWith("-cli")) return false;
    if (needle === "") return true;
    return providerLabel(provider, language).toLocaleLowerCase().includes(needle);
  };
  const api = LLM_PROVIDER_IDS.filter((provider) => !provider.endsWith("-cli") && matches(provider));
  const local = LLM_PROVIDER_IDS.filter((provider) => provider.endsWith("-cli") && matches(provider));

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      label={t("provider")}
      trigger={
        <button
          type="button"
          className="select-trigger"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((current) => !current)}
        >
          <span>{providerLabel(value, language)}</span>
          <Icon name="chevron" size={16} />
        </button>
      }
    >
      <label className="picker-search" htmlFor={searchId}>
        <Icon name="search" size={16} />
        <input
          id={searchId}
          ref={inputRef}
          value={query}
          placeholder={t("pickerFilter")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="picker-layout">
        <div className="picker-rail" role="toolbar" aria-label={t("filterSources")}>
          <RailButton
            label={t("allSources")}
            pressed={group === "all"}
            onClick={() => setGroup("all")}
            icon="monitor"
          />
          <RailButton
            label={t("providerGroupApi")}
            pressed={group === "api"}
            onClick={() => setGroup("api")}
            icon="pulse"
          />
          <RailButton
            label={t("providerGroupLocal")}
            pressed={group === "local"}
            onClick={() => setGroup("local")}
            icon="laptop"
          />
        </div>
        <div className="picker-list" role="listbox" aria-label={t("provider")}>
          <ProviderGroupList
            title={t("providerGroupApi")}
            providers={api}
            value={value}
            language={language}
            onPick={(provider) => {
              onChange(provider);
              setOpen(false);
            }}
          />
          <ProviderGroupList
            title={t("providerGroupLocal")}
            providers={local}
            value={value}
            language={language}
            onPick={(provider) => {
              onChange(provider);
              setOpen(false);
            }}
          />
          {api.length === 0 && local.length === 0 ? <p className="picker-empty">{t("emptySearch")}</p> : null}
        </div>
      </div>
    </Popover>
  );
}

function RailButton({
  label,
  pressed,
  onClick,
  icon,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  icon: "monitor" | "pulse" | "laptop";
}) {
  return (
    <button type="button" aria-label={label} aria-pressed={pressed} className={pressed ? "on" : ""} onClick={onClick}>
      <Icon name={icon} size={16} />
    </button>
  );
}

function ProviderGroupList({
  title,
  providers,
  value,
  language,
  onPick,
}: {
  title: string;
  providers: readonly string[];
  value: string;
  language: Language;
  onPick: (provider: string) => void;
}) {
  if (providers.length === 0) return null;
  return (
    <>
      <div className="picker-group">{title}</div>
      {providers.map((provider) => {
        const selected = provider === value;
        return (
          <button
            key={provider}
            type="button"
            role="option"
            aria-selected={selected}
            className={selected ? "picker-option on" : "picker-option"}
            onClick={() => onPick(provider)}
          >
            <span>{providerLabel(provider, language)}</span>
            {selected ? <Icon name="check" size={16} /> : null}
          </button>
        );
      })}
    </>
  );
}
