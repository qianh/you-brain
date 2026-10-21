import type { ReactNode } from "react";

import { Icon, type IconName } from "./icons.js";

export function EmptyState({
  title,
  description,
  icon = "inbox",
  size = "md",
  action,
  secondary,
}: {
  title: string;
  description?: string;
  icon?: IconName;
  size?: "md" | "sm";
  action?: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className={size === "sm" ? "empty-state sm" : "empty-state"}>
      <span className="empty-icon">
        <Icon name={icon} size={size === "sm" ? 18 : 24} />
      </span>
      <p className="empty-title">{title}</p>
      {description ? <p>{description}</p> : null}
      {action || secondary ? (
        <div className="empty-actions">
          {action}
          {secondary}
        </div>
      ) : null}
    </div>
  );
}
