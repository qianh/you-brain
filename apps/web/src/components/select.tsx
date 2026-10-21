import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { nextIndex, typeaheadIndex } from "../lib/list-nav.js";
import { Icon } from "./icons.js";
import { Popover } from "./popover.js";

export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  group?: string;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return textOf(props.children);
  }
  return "";
}

export function optionsFromChildren(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = [];
  const visit = (nodes: ReactNode, group?: string): void => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const props = child.props as { value?: string | number; label?: string; children?: ReactNode; disabled?: boolean };
      if (child.type === "optgroup") {
        visit(props.children, String(props.label ?? ""));
        return;
      }
      if (child.type === "option") {
        options.push({
          value: props.value === undefined ? textOf(props.children) : String(props.value),
          label: textOf(props.children),
          disabled: Boolean(props.disabled),
          ...(group ? { group } : {}),
        });
      }
    });
  };
  visit(children);
  return options;
}

export function Select({
  label,
  value,
  defaultValue,
  onChange,
  options,
  children,
  placeholder,
  disabled = false,
  searchable,
  name,
  error,
  defaultOpen = false,
}: {
  label: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  options?: readonly SelectOption[];
  children?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  name?: string;
  error?: string;
  /** Opens the list on mount. Used by the design gallery. */
  defaultOpen?: boolean;
}) {
  const listId = useId();
  const resolved = useMemo(() => options ?? optionsFromChildren(children), [options, children]);
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = value !== undefined ? value : inner;
  const selected = resolved.find((option) => option.value === current);
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [buffer, setBuffer] = useState("");
  const bufferAt = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const showSearch = searchable === true || resolved.length > 8;
  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(
    () => (needle === "" ? resolved : resolved.filter((option) => option.label.toLocaleLowerCase().includes(needle))),
    [needle, resolved],
  );

  useEffect(() => {
    if (!open) return;
    const index = Math.max(0, resolved.findIndex((option) => option.value === current));
    setActive(index);
    if (showSearch) searchRef.current?.focus();
  }, [open, showSearch, current, resolved]);

  const commit = (next: string): void => {
    if (value === undefined) setInner(next);
    onChange?.(next);
    setOpen(false);
    setQuery("");
  };

  const onListKey = (event: ReactKeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive((index) => nextIndex(index, visible.length, event.key as "ArrowDown" | "ArrowUp" | "Home" | "End"));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = visible[active];
      if (option && !option.disabled) commit(option.value);
      return;
    }
    if (showSearch) return;
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const next = now - bufferAt.current < 600 ? buffer + event.key : event.key;
      bufferAt.current = now;
      setBuffer(next);
      const found = typeaheadIndex(visible.map((option) => option.label), next, active + 1);
      if (found >= 0) setActive(found);
    }
  };

  let lastGroup = "";
  return (
    <span className="select">
      {name ? (
        <select name={name} value={current} hidden aria-hidden="true" tabIndex={-1} onChange={() => undefined}>
          {resolved.map((option) => (
            <option key={`${option.group ?? ""}-${option.value}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        label={label}
        matchWidth
        trigger={
          <button
            type="button"
            className="select-trigger"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={label}
            disabled={disabled}
            {...(error ? { "aria-invalid": true as const } : {})}
            onClick={() => setOpen((state) => !state)}
          >
            <span className="select-value">
              {selected?.icon}
              {selected?.label || placeholder || label}
            </span>
            <Icon name="chevron-down" />
          </button>
        }
      >
        <div className="select-pop">
          {showSearch ? (
            <div className="select-search">
              <input
                ref={searchRef}
                className="field-control"
                value={query}
                placeholder={label}
                aria-label={label}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onListKey}
              />
            </div>
          ) : null}
          <div id={listId} role="listbox" aria-label={label} className="select-list" tabIndex={showSearch ? -1 : 0} onKeyDown={onListKey}>
            {visible.length === 0 ? <div className="select-empty">—</div> : null}
            {visible.map((option, index) => {
              const header = option.group && option.group !== lastGroup ? option.group : null;
              if (option.group) lastGroup = option.group;
              const chosen = option.value === current;
              return (
                <div key={`${option.group ?? ""}-${option.value}`}>
                  {header ? <div className="select-group">{header}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={chosen}
                    disabled={option.disabled}
                    className={["select-option", index === active ? "is-active" : ""].filter(Boolean).join(" ")}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => {
                      if (!option.disabled) commit(option.value);
                    }}
                  >
                    <span className="check-slot">{chosen ? <Icon name="check" /> : null}</span>
                    {option.icon}
                    <span>{option.label}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </Popover>
      {error ? <small className="field-error">{error}</small> : null}
    </span>
  );
}
