import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
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
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(force);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });

  const show = (delay: number): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (delay <= 0) {
      setOpen(true);
      return;
    }
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = (): void => {
    if (force) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    setOpen(false);
  };
  useLayoutEffect(() => {
    if (force) setOpen(true);
  }, [force]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const anchor = ref.current?.getBoundingClientRect();
      const tip = tipRef.current?.getBoundingClientRect();
      if (!anchor || !tip) return;
      const margin = 8;
      const gap = 6;
      const left = Math.max(margin, Math.min(anchor.left + (anchor.width - tip.width) / 2, window.innerWidth - margin - tip.width));
      const above = anchor.top - gap - tip.height;
      const top = above >= margin ? above : Math.max(margin, Math.min(anchor.bottom + gap, window.innerHeight - margin - tip.height));
      setPos({ top, left, visibility: "visible" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, content, shortcut]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

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
              ref={tipRef}
              className="tooltip"
              role="tooltip"
              style={pos}
              {...((ref.current?.closest("[data-theme]")?.getAttribute("data-theme") ?? "") !== ""
                ? { "data-theme": ref.current?.closest("[data-theme]")?.getAttribute("data-theme") ?? "" }
                : {})}
            >
              <span className="tooltip-row">
                <span className="tooltip-content">{content}</span>
                {shortcut ? <Kbd>{shortcut}</Kbd> : null}
              </span>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
