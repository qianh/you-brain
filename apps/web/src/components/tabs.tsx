import { useRef } from "react";

export interface TabItem {
  id: string;
  href: string;
  label: string;
  current: boolean;
}

export function Tabs({
  label,
  items,
  onNavigate,
}: {
  label: string;
  items: readonly TabItem[];
  onNavigate: (href: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className="tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const index = Math.max(0, items.findIndex((item) => item.current));
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (index + delta + items.length) % items.length;
        const next = items[nextIndex];
        if (!next) return;
        onNavigate(next.href);
        const tabs = ref.current?.querySelectorAll<HTMLAnchorElement>('[role="tab"]');
        tabs?.[nextIndex]?.focus();
      }}
    >
      {items.map((item) => (
        <a
          key={item.id}
          className="tab"
          role="tab"
          href={item.href}
          aria-selected={item.current}
          tabIndex={item.current ? 0 : -1}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            onNavigate(item.href);
          }}
        >
          {item.label}
        </a>
      ))}
    </div>
  );
}
