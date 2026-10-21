import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ChipTone = "neutral" | "accent" | "success" | "warn" | "danger";

export function Chip({
  tone = "neutral",
  dot = false,
  icon,
  children,
  onClick,
  pressed = false,
  disabled = false,
  className = "",
}: {
  tone?: ChipTone;
  dot?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const classes = ["chip", tone, className].filter(Boolean).join(" ");
  const body = (
    <>
      {dot ? <i className="chip-dot" aria-hidden="true" /> : null}
      {icon}
      {children}
    </>
  );
  if (!onClick) return <span className={classes} data-tone={tone}>{body}</span>;
  const buttonProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    type: "button",
    className: classes,
    onClick,
    disabled,
    "aria-pressed": pressed,
  };
  return (
    <button {...buttonProps} data-tone={tone}>
      {body}
    </button>
  );
}
