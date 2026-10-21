import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./button.js";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  placement = "center",
  initialFocus = "first",
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
  placement?: "center" | "top";
  initialFocus?: "first" | "cancel";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    const items = (): HTMLElement[] =>
      root ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => !node.hasAttribute("disabled")) : [];
    const cancel = root?.querySelector<HTMLElement>("[data-cancel]");
    const first = items()[0];
    (initialFocus === "cancel" ? cancel ?? first : first)?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const list = items();
      if (list.length === 0) {
        event.preventDefault();
        return;
      }
      const start = list[0];
      const end = list[list.length - 1];
      if (!start || !end) return;
      if (event.shiftKey && document.activeElement === start) {
        event.preventDefault();
        end.focus();
      } else if (!event.shiftKey && document.activeElement === end) {
        event.preventDefault();
        start.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open, onClose, initialFocus]);

  if (!open) return null;
  return createPortal(
    <div
      className={placement === "top" ? "scrim top" : "scrim"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={["dialog", size === "lg" ? "lg" : "", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description ? { "aria-describedby": descId } : {})}
      >
        <header className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descId}>{description}</p> : null}
        </header>
        {children ? <div className="dialog-body">{children}</div> : null}
        {footer ? <footer className="dialog-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "primary",
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: "primary" | "danger";
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      initialFocus="cancel"
      footer={
        <>
          <Button variant="ghost" data-cancel="" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
