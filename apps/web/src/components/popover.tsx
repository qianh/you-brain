import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export function Popover({
  open,
  onClose,
  trigger,
  children,
  label,
  matchWidth = false,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  label: string;
  matchWidth?: boolean;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const root = rootRef.current;
      const pop = popRef.current;
      if (!root || !pop) return;
      const rect = root.getBoundingClientRect();
      const margin = 8;
      const width = matchWidth ? rect.width : Math.min(440, Math.max(220, pop.offsetWidth));
      const left = Math.min(Math.max(margin, rect.left), window.innerWidth - margin - width);
      const height = pop.offsetHeight;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openUp = height > 0 && spaceBelow < height + margin && rect.top > spaceBelow;
      const top = openUp ? Math.max(margin, rect.top - height - 6) : rect.bottom + 6;
      setStyle({
        top,
        left,
        visibility: "visible",
        ...(matchWidth ? { width, minWidth: width } : {}),
        ["--pop-origin" as string]: openUp ? "bottom left" : "top left",
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, matchWidth, children]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
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
      const back = rootRef.current?.querySelector<HTMLElement>("button, a, input");
      (back ?? previous)?.focus();
    };
  }, [open, onClose]);

  const inherited = rootRef.current?.closest("[data-theme]")?.getAttribute("data-theme") ?? "";
  return (
    <div className="popover-root" ref={rootRef}>
      {trigger}
      {open
        ? createPortal(
            <div
              ref={popRef}
              className={["popover", className].filter(Boolean).join(" ")}
              role="dialog"
              aria-label={label}
              style={style}
              {...(inherited !== "" ? { "data-theme": inherited } : {})}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
