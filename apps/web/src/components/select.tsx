import type { ChangeEvent, ReactNode } from "react";

import { Icon } from "./icons.js";

export function Select({
  label,
  children,
  value,
  defaultValue,
  name,
  onChange,
}: {
  label: string;
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  name?: string;
  onChange?: (value: string) => void;
}) {
  const controlled = value !== undefined;
  return (
    <span className="select">
      <select
        aria-label={label}
        name={name}
        {...(controlled ? { value } : {})}
        {...(defaultValue !== undefined ? { defaultValue } : {})}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange?.(event.target.value)}
      >
        {children}
      </select>
      <Icon name="chevron" size={16} />
    </span>
  );
}
