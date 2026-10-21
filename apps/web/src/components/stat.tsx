import type { ReactNode } from "react";

export function StatBlock({
  value,
  label,
  hint,
  compact = false,
  zero = false,
  english = false,
  extra,
}: {
  value: string;
  label: string;
  hint?: string;
  compact?: boolean;
  zero?: boolean;
  english?: boolean;
  extra?: ReactNode;
}) {
  return (
    <div className="stat">
      <strong className={[compact ? "compact" : "", zero ? "is-zero" : ""].filter(Boolean).join(" ") || undefined}>
        {value}
      </strong>
      <span className={english ? "en" : undefined}>{label}</span>
      {hint ? <small>{hint}</small> : null}
      {extra}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}
