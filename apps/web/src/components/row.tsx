import type { ReactNode } from "react";

export function Row({
  icon,
  title,
  subtitle,
  trailing,
  children,
  href,
  current = false,
  onClick,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  href?: string;
  current?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const inner = (
    <>
      {icon ? <span className="row-icon">{icon}</span> : null}
      <span className="row-main">
        <span className="row-title">{title}</span>
        {subtitle ? <span className="row-sub">{subtitle}</span> : null}
      </span>
      {trailing ? <span className="row-trail">{trailing}</span> : null}
    </>
  );
  const rowClass = "row";
  return (
    <div className={["row-wrap", className].filter(Boolean).join(" ")}>
      {href ? (
        <a
          className={rowClass}
          href={href}
          {...(current ? { "aria-current": "true" as const } : {})}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            onClick?.();
          }}
        >
          {inner}
        </a>
      ) : onClick ? (
        <button type="button" className={rowClass} onClick={onClick}>
          {inner}
        </button>
      ) : (
        <div className={rowClass}>{inner}</div>
      )}
      {children ? <div className="row-detail">{children}</div> : null}
    </div>
  );
}
