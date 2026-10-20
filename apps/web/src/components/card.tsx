import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
  padded = false,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  const classes = ["card", padded ? "card-padded" : "", className].filter(Boolean).join(" ");
  return <section className={classes}>{children}</section>;
}

export function CardHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <header className="card-head">
      <h2>{title}</h2>
      {hint ? <p>{hint}</p> : null}
    </header>
  );
}
