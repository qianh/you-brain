import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Spinner } from "./spinner.js";
import { Tooltip } from "./tooltip.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  iconRight,
  children,
  className = "",
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [locked, setLocked] = useState<number | null>(null);
  useEffect(() => {
    if (!loading) {
      setLocked(null);
      return;
    }
    const width = ref.current?.offsetWidth;
    if (width) setLocked(width);
  }, [loading]);
  const classes = ["button", variant, size === "sm" ? "sm" : "", loading ? "is-loading" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={locked !== null ? { width: locked } : undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {!loading ? iconRight : null}
    </button>
  );
}

export function IconButton({
  label,
  shortcut,
  children,
  className = "",
  disabled,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  label: string;
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} {...(shortcut !== undefined ? { shortcut } : {})}>
      <button
        type="button"
        className={["icon-btn", className].filter(Boolean).join(" ")}
        aria-label={label}
        disabled={disabled}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}
