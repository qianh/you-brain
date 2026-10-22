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
}) {
  const { t, language, timeZone } = useDaemon();
  const showToc = shouldShowToc(toc);
  return (
    <aside className="portrait-side">
      <details className="portrait-side-fold">
        <summary>
          <span>{t("portraitSideSummary")}</span>
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
                    <li key={item.id}>
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
