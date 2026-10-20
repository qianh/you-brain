import type { ReactNode } from "react";

export function StatBlock({
  value,
  label,
  hint,
  compact = false,
}: {
  value: string;
  label: string;
  hint?: string;
  compact?: boolean;
}) {
  return (
    <div className="stat">
      <strong {...(compact ? { className: "compact" } : {})}>{value}</strong>
      <span>{label}</span>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}
