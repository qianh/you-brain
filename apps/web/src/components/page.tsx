import type { ReactNode } from "react";

export function Page({ children, reading = false }: { children: ReactNode; reading?: boolean }) {
  return <div className={reading ? "page-frame read" : "page-frame"}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-copy">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
