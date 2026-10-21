import type { ReactNode } from "react";

import { Icon } from "./icons.js";

export function Row({
  icon,
  title,
  subtitle,
  meta,
  trailing,
  children,
  href,
  current = false,
  onClick,
  className = "",
  expandable = false,
  expanded = false,
  titleText,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  href?: string;
  current?: boolean;
  onClick?: () => void;
  className?: string;
  expandable?: boolean;
  expanded?: boolean;
  titleText?: string;
}) {
  const clickable = Boolean(href || onClick);
  const single = !subtitle;
  const inner = (
    <>
      {icon ? <span className="row-lead">{icon}</span> : null}
      <span className="row-main">
        <span className="row-title" title={titleText}>
          {title}
        </span>
        {subtitle ? <span className="row-sub">{subtitle}</span> : null}
      </span>
      {meta ? <span className="row-meta">{meta}</span> : null}
      {trailing || clickable || expandable ? (
        <span className="row-trail">
          {trailing}
          {expandable ? (
            <span className={expanded ? "row-chevron is-open" : "row-chevron"}>
              <Icon name="chevron-down" />
            </span>
          ) : clickable ? (
            <span className="row-chevron">
              <Icon name="chevron-right" />
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
  const rowClass = ["row", single ? "is-single" : "", clickable ? "is-clickable" : ""].filter(Boolean).join(" ");
  const showDetail = Boolean(children) && (!expandable || expanded);
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
        <button type="button" className={rowClass} aria-expanded={expandable ? expanded : undefined} onClick={onClick}>
          {inner}
        </button>
      ) : (
        <div className={rowClass}>{inner}</div>
      )}
      {showDetail ? <div className="row-detail">{children}</div> : null}
    </div>
  );
}
