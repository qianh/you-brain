import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useDaemon } from "../../daemon-context.js";
import { Icon } from "../../components/icons.js";

export function SummaryText({ text }: { text: string }) {
  const { t } = useDaemon();
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [text]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || open) return;
    const measure = (): void => setOverflow(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, open]);

  if (text.trim() === "") return <p className="topics-muted">{t("noSummary")}</p>;
  return (
    <div className="topics-summary">
      <p ref={ref} className={open ? "topics-prose" : "topics-prose is-clamped"}>
        {text}
      </p>
      {overflow || open ? (
        <button type="button" className="show-more inline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span>{open ? t("showLess") : t("showMore")}</span>
          <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
        </button>
      ) : null}
    </div>
  );
}
