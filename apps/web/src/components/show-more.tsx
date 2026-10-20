import { useState, type ReactNode } from "react";

import { useDaemon } from "../daemon-context.js";
import { Icon } from "./icons.js";

export function ShowMore<T>({
  items,
  limit = 8,
  children,
}: {
  items: readonly T[];
  limit?: number;
  children: (item: T, index: number) => ReactNode;
}) {
  const { t } = useDaemon();
  const [open, setOpen] = useState(false);
  const hidden = Math.max(0, items.length - limit);
  const visible = open || hidden === 0 ? items : items.slice(0, limit);
  return (
    <>
      {visible.map((item, index) => children(item, index))}
      {hidden > 0 ? (
        <button type="button" className="show-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span>{open ? t("showLess") : t("showMoreCount", { count: hidden })}</span>
          <Icon name={open ? "chevronUp" : "chevron"} size={16} />
        </button>
      ) : null}
    </>
  );
}

export function ClampText({ text, limit = 96 }: { text: string; limit?: number }) {
  const { t } = useDaemon();
  const [open, setOpen] = useState(false);
  const folded = text.length > limit;
  return (
    <div className="clamp">
      <p>{open || !folded ? text : `${text.slice(0, limit).trimEnd()}…`}</p>
      {folded ? (
        <button type="button" className="show-more inline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span>{open ? t("showLess") : t("showMore")}</span>
          <Icon name={open ? "chevronUp" : "chevron"} size={16} />
        </button>
      ) : null}
    </div>
  );
}
