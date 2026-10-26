import type { ReactNode } from "react";

export function StatBlock({
  value,
  label,
  hint,
  compact = false,
  zero = false,
  english = false,
  extra,
  onSelect,
  title,
}: {
  value: string;
  label: string;
  hint?: string;
  compact?: boolean;
  zero?: boolean;
  english?: boolean;
  extra?: ReactNode;
  /** Makes the block a button that goes where its number is counted. */
  onSelect?: () => void;
  /** Tooltip for a number that has no page of its own. */
  title?: string;
}) {
  const body = (
    <>
      <strong className={[compact ? "compact" : "", zero ? "is-zero" : ""].filter(Boolean).join(" ") || undefined}>
        {value}
      </strong>
      <span className={english ? "en" : undefined}>{label}</span>
      {hint ? <small>{hint}</small> : null}
      {extra}
    </>
  );
  if (!onSelect) {
    return (
      <div className="stat" {...(title ? { title } : {})}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" className="stat stat-select" onClick={onSelect} {...(title ? { title } : {})}>
      {body}
    </button>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}
