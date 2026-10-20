import type { ReactNode } from "react";

export function Pill({
  children,
  pressed = false,
  onClick,
}: {
  children: ReactNode;
  pressed?: boolean;
  onClick?: () => void;
}) {
  if (!onClick) return <span className={pressed ? "pill on" : "pill"}>{children}</span>;
  return (
    <button type="button" className={pressed ? "pill on" : "pill"} aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}
