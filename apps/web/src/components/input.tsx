import { useId, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

import { useDaemon } from "../daemon-context.js";
import { Chip } from "./chip.js";
import { Icon } from "./icons.js";
import { IconButton } from "./button.js";
import { Kbd } from "./kbd.js";

interface FieldChrome {
  label?: string;
  error?: string;
  className?: string;
}

function described(id: string, error?: string): { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string } {
  return {
    id,
    ...(error ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {}),
  };
}

export function Input({
  label,
  error,
  className = "",
  secret = false,
  saved = false,
  id,
  ...rest
}: FieldChrome &
  Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
    secret?: boolean;
    saved?: boolean;
  }) {
  const { t } = useDaemon();
  const auto = useId();
  const fieldId = id ?? auto;
  const [visible, setVisible] = useState(false);
  const type = secret ? (visible ? "text" : "password") : (rest.type ?? "text");
  return (
    <span className={["field", className].filter(Boolean).join(" ")}>
      <span className="input-shell">
        <input
          {...rest}
          {...described(fieldId, error)}
          className={["field-control", error ? "is-error" : ""].filter(Boolean).join(" ")}
          type={type}
          aria-label={rest["aria-label"] ?? label}
        />
        <span className="input-affix">
          {saved ? <Chip tone="success">{t("saved")}</Chip> : null}
          {secret ? (
            <IconButton className="sm" label={visible ? t("hideSecret") : t("showSecret")} onClick={() => setVisible((value) => !value)}>
              <Icon name={visible ? "eye-off" : "eye"} />
            </IconButton>
          ) : null}
        </span>
      </span>
      {error ? (
        <small className="field-error" id={`${fieldId}-error`}>
          {error}
        </small>
      ) : null}
    </span>
  );
}

export function Textarea({
  label,
  error,
  className = "",
  id,
  ...rest
}: FieldChrome & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <span className={className}>
      <textarea
        {...rest}
        {...described(fieldId, error)}
        className={["field-control", error ? "is-error" : ""].filter(Boolean).join(" ")}
        aria-label={rest["aria-label"] ?? label}
        rows={rest.rows ?? 3}
      />
      {error ? (
        <small className="field-error" id={`${fieldId}-error`}>
          {error}
        </small>
      ) : null}
    </span>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  kbd,
  size = "md",
  label = "搜索",
  autoFocus = false,
  onSubmit,
  clearLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  kbd?: string;
  size?: "md" | "lg";
  label?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  clearLabel?: string;
}) {
  const { t } = useDaemon();
  const clear = clearLabel ?? t("clearInput");
  return (
    <label className={["search-field", size === "lg" ? "lg" : "", value ? "has-value" : ""].filter(Boolean).join(" ")}>
      <span className="search-icon">
        <Icon name="search" />
      </span>
      <input
        className="field-control"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autoFocus={autoFocus}
        data-page-search=""
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit?.();
        }}
      />
      <span className="input-affix">
        <span className="search-clear">
          <IconButton label={clear} onClick={() => onChange("")} tabIndex={value ? 0 : -1}>
            <Icon name="x" />
          </IconButton>
        </span>
        {kbd ? <Kbd>{kbd}</Kbd> : null}
      </span>
    </label>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  return <small className="field-error">{children}</small>;
}
