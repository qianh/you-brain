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
}: {
  tone: BannerTone;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  const mapped = TONE[tone];
  return (
    <div className={`banner ${mapped}`} role={mapped === "danger" ? "alert" : "status"}>
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
