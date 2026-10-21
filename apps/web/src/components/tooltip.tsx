import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Kbd } from "./kbd.js";

export function Tooltip({
  content,
  shortcut,
  children,
  force = false,
}: {
  content: ReactNode;
  shortcut?: string;
  children: ReactElement;
  /** Keep the tip open. The design gallery uses this for screenshots. */
  force?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(force);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const place = (): void => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.top - 6, left: rect.left + rect.width / 2 });
    setOpen(true);
  };
  const show = (delay: number): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (delay <= 0) {
      place();
      return;
    }
    timer.current = window.setTimeout(place, delay);
  };
  const hide = (): void => {
    if (force) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    setOpen(false);
  };
  useLayoutEffect(() => {
    if (force) place();
  }, [force]);

  return (
    <span
      className="tip-wrap"
      ref={ref}
      onMouseEnter={() => show(400)}
      onMouseLeave={hide}
      onFocus={() => show(0)}
      onBlur={hide}
    >
      {children}
      {open
        ? createPortal(
            <div
              className="tooltip"
              role="tooltip"
              style={{ top: pos.top, left: pos.left, transform: "translate(-50%, -100%)" }}
              {...((ref.current?.closest("[data-theme]")?.getAttribute("data-theme") ?? "") !== ""
                ? { "data-theme": ref.current?.closest("[data-theme]")?.getAttribute("data-theme") ?? "" }
                : {})}
            >
              <span className="tooltip-row">
                {content}
                {shortcut ? <Kbd>{shortcut}</Kbd> : null}
              </span>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
