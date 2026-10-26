import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Spinner } from "./spinner.js";

export type ChipTone = "neutral" | "accent" | "success" | "warn" | "danger";

export function Chip({
  tone = "neutral",
  dot = false,
  icon,
  children,
  onClick,
  pressed = false,
  disabled = false,
  loading = false,
  className = "",
}: {
  tone?: ChipTone;
  dot?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  /** Shows a spinner and blocks clicks while a change is in flight. */
  loading?: boolean;
  className?: string;
}) {
  const classes = ["chip", tone, loading ? "is-loading" : "", className].filter(Boolean).join(" ");
  const body = (
    <>
      {dot ? <i className="chip-dot" aria-hidden="true" /> : null}
      {loading ? <Spinner /> : icon}
      {children}
    </>
  );
  if (!onClick) return <span className={classes} data-tone={tone}>{body}</span>;
  const buttonProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    type: "button",
    className: classes,
    onClick,
    disabled: disabled || loading,
    "aria-pressed": pressed,
    ...(loading ? { "aria-busy": true } : {}),
  };
  return (
    <button {...buttonProps} data-tone={tone}>
      {body}
    </button>
  );
}
