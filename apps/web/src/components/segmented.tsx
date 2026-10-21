import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface SegmentOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

export function Segmented({
  label,
  value,
  options,
  onChange,
  className = "",
  labelledBy,
}: {
  label: string;
  value: string;
  options: readonly SegmentOption[];
  onChange: (value: string) => void;
  className?: string;
  labelledBy?: "tablist" | "radiogroup";
}) {
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [box, setBox] = useState({ x: 2, w: 0 });
  const role = labelledBy ?? "tablist";

  useLayoutEffect(() => {
    const measure = (): void => {
      const parent = root.current;
      const index = options.findIndex((option) => option.value === value);
      const current = index < 0 ? undefined : buttons.current[index];
      if (!parent || !current) {
        setBox({ x: 0, w: 0 });
        return;
      }
      const parentBox = parent.getBoundingClientRect();
      const currentBox = current.getBoundingClientRect();
      setBox({ x: currentBox.left - parentBox.left, w: currentBox.width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, [options, value]);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const move = (delta: number): void => {
    if (options.length === 0) return;
    const origin = selectedIndex < 0 ? (delta > 0 ? -1 : 0) : selectedIndex;
    const nextAt = (origin + delta + options.length) % options.length;
    const next = options[nextAt];
    if (!next) return;
    onChange(next.value);
    buttons.current[nextAt]?.focus();
  };

  return (
    <div
      ref={root}
      className={["segmented", className].filter(Boolean).join(" ")}
      role={role}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        move(event.key === "ArrowRight" ? 1 : -1);
      }}
    >
      {box.w > 0 ? <span className="segmented-thumb" style={{ width: box.w, transform: `translateX(${box.x}px)` }} /> : null}
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role={role === "radiogroup" ? "radio" : "tab"}
            {...(role === "tablist" ? { "aria-selected": selected } : { "aria-checked": selected })}
            tabIndex={selected || (selectedIndex < 0 && index === 0) ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            <span className="seg-label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
