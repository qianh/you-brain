import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { useDaemon } from "../daemon-context.js";
import { Icon, type IconName } from "./icons.js";
import { IconButton } from "./button.js";

export type ToastTone = "info" | "success" | "warn" | "danger";

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  /** Milliseconds before auto-dismiss. `0` stays until dismissed. */
  duration?: number;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  push: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const ICONS: Record<ToastTone, IconName> = {
  info: "info",
  success: "check-circle",
  warn: "alert",
  danger: "alert-circle",
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useDaemon();
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const push = useCallback(
    (options: ToastOptions) => {
      const id = nextId;
      nextId += 1;
      const tone = options.tone ?? "info";
      const item: ToastItem = {
        id,
        message: options.message,
        tone,
        ...(options.action ? { action: options.action } : {}),
      };
      setItems((current) => [...current, item]);
      const duration = options.duration ?? 4200;
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );
  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" aria-live="polite" aria-relevant="additions">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.tone}`} role={item.tone === "danger" ? "alert" : "status"}>
            <span className="toast-icon">
              <Icon name={ICONS[item.tone]} />
            </span>
            <p className="toast-body">{item.message}</p>
            {item.action ? (
              <button type="button" className="btn small toast-action" onClick={item.action.onClick}>
                {item.action.label}
              </button>
            ) : null}
            <IconButton label={t("dismiss")} onClick={() => dismiss(item.id)}>
              <Icon name="x" />
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value;
}
