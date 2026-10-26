import type { SearchHit } from "@you-brain/core/http/types.js";

import { useDaemon } from "../../daemon-context.js";
import { SourceTile } from "../../components/tile.js";
import { Tooltip } from "../../components/tooltip.js";
import { formatDateTime, sourceLabel } from "../../lib/format.js";
import { flattenExcerpt, formatScore, highlightParts, relevanceCells } from "./logic.js";
import { searchTitle } from "../../lib/copy.js";

export function SearchResults({
  hits,
  query,
  cursor,
  pending,
  onSelect,
}: {
  hits: readonly SearchHit[];
  query: string;
  cursor: number;
  pending: boolean;
  onSelect: (index: number) => void;
}) {
  const { t, language, timeZone } = useDaemon();
  return (
    <div
      className={pending ? "search-hits is-pending" : "search-hits"}
      role="listbox"
      aria-label={t("searchList")}
      aria-activedescendant={cursor >= 0 ? `search-hit-${cursor}` : undefined}
    >
      {hits.map((hit, index) => {
        const flat = flattenExcerpt(hit.excerpt);
        const text = flat !== "" ? flat : searchTitle(hit);
        const parts = highlightParts(text, query);
        const when = formatDateTime(hit.updatedAt, language, timeZone);
        const score = formatScore(hit.score);
        const cells = relevanceCells(hit.score);
        const selected = index === cursor;
        return (
          <div
            key={`${hit.source}-${hit.conversationId}-${index}`}
            id={`search-hit-${index}`}
            role="option"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={selected ? "search-hit is-current" : "search-hit"}
            onClick={() => onSelect(index)}
          >
            <SourceTile source={hit.source} label={sourceLabel(hit.source)} />
            <span className="search-hit-copy">
              <span className="search-hit-excerpt" title={text}>
                {parts.map((part, partIndex) =>
                  part.mark ? <mark key={partIndex}>{part.text}</mark> : <span key={partIndex}>{part.text}</span>,
                )}
              </span>
              <span className="search-hit-meta">
                <span>{sourceLabel(hit.source)}</span>
                {hit.device ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{hit.device}</span>
                  </>
                ) : null}
                <span aria-hidden="true">·</span>
                <time dateTime={hit.updatedAt}>{when}</time>
              </span>
            </span>
            <Tooltip content={score}>
              <span className="search-meter" aria-label={t("searchRelevance", { score })}>
                {[0, 1, 2].map((cell) => (
                  <i key={cell} className={cell < cells ? "on" : undefined} />
                ))}
                <span className="search-sr">{t("searchRelevance", { score })}</span>
              </span>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
}
