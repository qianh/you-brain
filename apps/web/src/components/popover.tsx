import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Popover({
  open,
  onClose,
  trigger,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  label: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const margin = 12;
      const width = Math.min(440, Math.max(240, window.innerWidth - margin * 2));
      const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - margin - width);
      const height = popRef.current?.offsetHeight ?? 0;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openUp = height > 0 && spaceBelow < height + margin && rect.top > spaceBelow;
      const top = openUp ? Math.max(margin, rect.top - height - 6) : rect.bottom + 6;
      setStyle({ top, left, width, visibility: "visible" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    const onPointer = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open, onClose]);
  return (
    <div className="popover-root" ref={rootRef}>
      {trigger}
      {open
        ? createPortal(
            <div ref={popRef} className="popover" role="dialog" aria-label={label} style={style}>
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
