import type { ReactNode } from "react";

import { Chip } from "./chip.js";

/** Filter chip kept for the current pages. New pages should use `Chip`. */
export function Pill({
  children,
  pressed = false,
  onClick,
}: {
  children: ReactNode;
  pressed?: boolean;
  onClick?: () => void;
}) {
  return (
    <Chip tone={pressed ? "accent" : "neutral"} pressed={pressed} {...(onClick ? { onClick } : {})}>
      {children}
    </Chip>
  );
}
