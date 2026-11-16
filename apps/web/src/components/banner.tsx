import type { ReactNode } from "react";

import { Icon, type IconName } from "./icons.js";
import { IconButton } from "./button.js";

export type BannerTone = "info" | "success" | "warn" | "danger" | "ok" | "bad";

const TONE: Record<BannerTone, "info" | "success" | "warn" | "danger"> = {
  info: "info",
  success: "success",
  warn: "warn",
  danger: "danger",
  ok: "success",
  bad: "danger",
};

const ICONS: Record<"info" | "success" | "warn" | "danger", IconName> = {
  info: "info",
  success: "check-circle",
  warn: "alert",
  danger: "alert-circle",
};

export function Banner({
  tone,
  children,
  action,
  onDismiss,
  dismissLabel = "关闭",
  className = "",
  actionBelow = false,
}: {
  tone: BannerTone;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
  /** 按钮组换到正文下方整行右对齐;用于窄面板里展开的长提醒。 */
  actionBelow?: boolean;
}) {
  const mapped = TONE[tone];
  const below = actionBelow && Boolean(action || onDismiss);
  return (
    <div
      className={["banner", mapped, below ? "actions-below" : "", className].filter(Boolean).join(" ")}
      role={mapped === "danger" ? "alert" : "status"}
    >
      <span className="banner-icon">
        <Icon name={ICONS[mapped]} />
      </span>
      <span className="banner-text">{children}</span>
      {action || onDismiss ? (
        <span className="banner-actions">
          {action}
          {onDismiss ? (
            <IconButton label={dismissLabel} onClick={onDismiss}>
              <Icon name="x" />
            </IconButton>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
