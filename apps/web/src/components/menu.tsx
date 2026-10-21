import { useEffect, useRef, useState, type ReactNode } from "react";

import { nextIndex, typeaheadIndex } from "../lib/list-nav.js";
import { Kbd } from "./kbd.js";
import { Popover } from "./popover.js";

export interface MenuItem {
  id: string;
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

export function Menu({
  label,
  trigger,
  items,
  defaultOpen = false,
}: {
  label: string;
  trigger: ReactNode;
  items: readonly MenuItem[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [active, setActive] = useState(0);
  const [buffer, setBuffer] = useState("");
  const bufferAt = useRef(0);
  const labels = items.map((item) => item.label ?? "");

  useEffect(() => {
    if (!open) return;
    const first = items.findIndex((item) => !item.separator && !item.disabled);
    setActive(first);
  }, [open, items]);

  const choose = (index: number): void => {
    const item = items[index];
    if (!item || item.separator || item.disabled) return;
    item.onSelect?.();
    setOpen(false);
  };

  return (
    <Popover open={open} onClose={() => setOpen(false)} label={label} trigger={<span onClick={() => setOpen((value) => !value)}>{trigger}</span>}>
      <div
        role="menu"
        aria-label={label}
        tabIndex={-1}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const enabled = items.map((item, index) => (!item.separator && !item.disabled ? index : -1)).filter((index) => index >= 0);
            if (enabled.length === 0) return;
            const current = enabled.indexOf(active);
            const next = nextIndex(current, enabled.length, event.key);
            const picked = enabled[next];
            if (picked !== undefined) setActive(picked);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            choose(active);
            return;
          }
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            const now = Date.now();
            const nextBuffer = now - bufferAt.current < 600 ? buffer + event.key : event.key;
            bufferAt.current = now;
            setBuffer(nextBuffer);
            const found = typeaheadIndex(labels, nextBuffer, active + 1);
            if (found >= 0) setActive(found);
          }
        }}
      >
        {items.map((item, index) =>
          item.separator ? (
            <div key={item.id} className="menu-sep" role="separator" />
          ) : (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={["menu-item", item.danger ? "danger" : "", index === active ? "is-active" : ""].filter(Boolean).join(" ")}
              disabled={item.disabled}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              {item.icon}
              <span className="menu-label">{item.label}</span>
              {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
            </button>
          ),
        )}
      </div>
    </Popover>
  );
}
