import { useEffect, useState } from "react";
import type { PortraitSnapshot } from "@you-brain/core/http/types.js";

import { useDaemon } from "../../daemon-context.js";
import { Button, IconButton } from "../../components/button.js";
import { Chip } from "../../components/chip.js";
import { Icon } from "../../components/icons.js";
import { Tooltip } from "../../components/tooltip.js";
import { formatDateTime, formatRelative } from "../../lib/format.js";
import { shouldShowToc, type TocItem } from "../../lib/markdown.js";
import { PortraitCorrections } from "./corrections.js";
import { scrollBehavior, snapshotVersion } from "./logic.js";
import { PortraitProbes } from "./probes.js";
import { PortraitProposals } from "./proposals.js";

/** Items waiting for the user's review on this layer: coding proposals plus unreviewed probes. */
function usePendingReviewCount(variant: string): number {
  const { client } = useDaemon();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const wantsProposals = variant === "coding";
    const wantsProbes = variant === "full" || variant === "coding";
    void Promise.all([
      wantsProposals ? client.portraitProposals().then((body) => body.proposals.length) : Promise.resolve(0),
      wantsProbes ? client.portraitProbes().then((body) => body.probes.length) : Promise.resolve(0),
    ])
      .then(([proposals, probes]) => {
        if (alive) setCount(proposals + probes);
      })
      .catch(() => {
        if (alive) setCount(0);
      });
    return () => {
      alive = false;
    };
  }, [client, variant]);
  return count;
}

export function PortraitSide({
  variant,
  toc,
  activeId,
  onJump,
  path,
  updatedAt,
  words,
  snapshots,
  onCopyPath,
  onCopyBody,
  onPortraitChanged,
}: {
  variant: string;
  toc: readonly TocItem[];
  activeId: string | null;
  onJump: (id: string) => void;
  path: string;
  updatedAt: string | null;
  words: string;
  snapshots: readonly PortraitSnapshot[];
  onCopyPath: () => void;
  onCopyBody: () => void;
  onPortraitChanged?: () => void;
}) {
  const { t, language, timeZone } = useDaemon();
  const showToc = shouldShowToc(toc);
  const pending = usePendingReviewCount(variant);
  const [open, setOpen] = useState(false);
  // Pending review items used to hide behind a closed fold; open it once when some arrive.
  useEffect(() => {
    if (pending > 0) setOpen(true);
  }, [pending]);
  return (
    <aside className="portrait-side" tabIndex={0} aria-label={t("portraitSideSummary")}>
      <details
        className="portrait-side-fold"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <span>{t("portraitSideSummary")}</span>
          {pending > 0 ? <Chip>{t("portraitSidePending", { count: String(pending) })}</Chip> : null}
          <Icon name="chevron-down" />
        </summary>
        <div className="portrait-side-body">
          {showToc ? (
            <nav className="portrait-block portrait-toc" aria-label={t("portraitToc")}>
              <p className="portrait-kicker">{t("portraitToc")}</p>
              <ol>
                {toc.map((item) => {
                  const current = item.id === activeId;
                  return (
                    <li key={item.virtual ? `${item.id}-v` : item.id}>
                      <a
                        href={`#${item.id}`}
                        data-level={item.level}
                        className={current ? "is-current" : undefined}
                        {...(current ? { "aria-current": "location" as const } : {})}
                        onClick={(event) => {
                          event.preventDefault();
                          onJump(item.id);
                          const node = document.getElementById(item.id);
                          node?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
                        }}
                      >
                        {item.text}
                      </a>
                    </li>
                  );
                })}
              </ol>
            </nav>
          ) : null}
          <section className="portrait-block" aria-label={t("portraitFile")}>
            <p className="portrait-kicker">{t("portraitFile")}</p>
            <div className="portrait-path-row">
              <code className="portrait-path" title={path}>
                {path}
              </code>
              <IconButton className="sm" label={t("portraitCopyPath")} onClick={onCopyPath}>
                <Icon name="copy" size={14} />
              </IconButton>
            </div>
            {updatedAt ? (
              <p className="portrait-meta-line" title={formatDateTime(updatedAt, language, timeZone)}>
                {t("portraitUpdatedAt", { time: formatRelative(updatedAt, language, timeZone) })}
              </p>
            ) : null}
            <p className="portrait-meta-line">{t("portraitWords", { count: words })}</p>
            <Button className="portrait-copy" variant="secondary" size="sm" icon={<Icon name="copy" size={14} />} onClick={onCopyBody}>
              {t("portraitCopyAll")}
            </Button>
          </section>
          {variant === "coding" ? (
            <PortraitProposals
              onApplied={() => {
                onPortraitChanged?.();
              }}
            />
          ) : null}
          {variant === "full" || variant === "coding" ? <PortraitProbes /> : null}
          <PortraitCorrections variant={variant} toc={toc} />
          <section className="portrait-block" aria-label={t("portraitHistory")}>
            <div className="portrait-kicker-row">
              <p className="portrait-kicker">{t("portraitHistory")}</p>
              <Chip>{snapshots.length}</Chip>
            </div>
            {snapshots.length === 0 ? <p className="portrait-meta-line">{t("portraitNoHistory")}</p> : null}
            {snapshots.length > 0 ? (
              <ul className="portrait-snaps">
                {snapshots.map((snapshot) => (
                  <li key={snapshot.path} className="portrait-snap">
                    <Tooltip content={snapshot.name}>
                      <span className="portrait-snap-name">{snapshotVersion(snapshot.name)}</span>
                    </Tooltip>
                    <time dateTime={snapshot.updatedAt ?? undefined} title={formatDateTime(snapshot.updatedAt, language, timeZone)}>
                      {formatRelative(snapshot.updatedAt, language, timeZone)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </details>
    </aside>
  );
}
