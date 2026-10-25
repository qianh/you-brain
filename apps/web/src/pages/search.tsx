import { useEffect, useRef, useState } from "react";
import type { SearchResponse } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { useRoute } from "../router.js";
import { BrowserDaemonError } from "../api/client.js";
import { Banner } from "../components/banner.js";
import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { Chip } from "../components/chip.js";
import { EmptyState } from "../components/empty.js";
import { Icon } from "../components/icons.js";
import { SearchField } from "../components/input.js";
import { Kbd } from "../components/kbd.js";
import { Page, PageHeader } from "../components/page.js";
import { Select } from "../components/select.js";
import { SkeletonRow } from "../components/skeleton.js";
import { SourceTile } from "../components/tile.js";
import { useDelayed } from "../components/use-delayed.js";
import { sourceLabel } from "../lib/format.js";
import { nextIndex, type ListKey } from "../lib/list-nav.js";
import { SearchResults } from "./search/result-list.js";
import {
  SEARCH_SOURCES,
  hasActiveFilters,
  isSearchRange,
  joinNotice,
  nextSources,
  parseSearchSources,
  rangeBounds,
  searchNoticeLines,
  suggestionNames,
  type SearchRange,
  type SearchSource,
} from "./search/logic.js";

export function SearchPage() {
  const { t, topics, client, timeZone } = useDaemon();
  const { location } = useRoute();
  const [query, setQuery] = useState(location.q ?? "");
  const [sources, setSources] = useState<SearchSource[]>(() => parseSearchSources(window.location.search));
  const [range, setRange] = useState<SearchRange>("all");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [notesOpen, setNotesOpen] = useState(false);
  const generation = useRef(0);
  const sourcesRef = useRef(sources);
  const rangeRef = useRef(range);
  sourcesRef.current = sources;
  rangeRef.current = range;
  const showSkeleton = useDelayed(busy);
  const suggestions = suggestionNames(topics);

  function run(text: string, sourceIds: readonly string[], nextRange: SearchRange): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    const id = generation.current + 1;
    generation.current = id;
    setBusy(true);
    setError(null);
    const bounds = rangeBounds(nextRange, new Date(), timeZone);
    void client
      .search({
        query: trimmed,
        ...(sourceIds.length > 0 ? { sources: [...sourceIds] } : {}),
        ...(bounds.from !== undefined ? { from: bounds.from } : {}),
        ...(bounds.to !== undefined ? { to: bounds.to } : {}),
      })
      .then((next) => {
        if (generation.current !== id) return;
        setResult(next);
        setCursor(next.results.length > 0 ? 0 : -1);
      })
      .catch((caught: unknown) => {
        if (generation.current !== id) return;
        setError(caught instanceof BrowserDaemonError ? caught.message : t("actionFailed"));
      })
      .finally(() => {
        if (generation.current === id) setBusy(false);
      });
  }

  useEffect(() => {
    if (location.q === null) return;
    setQuery(location.q);
    run(location.q, sourcesRef.current, rangeRef.current);
    // Deep link from the command palette. Filters stay as the reader left them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.q]);

  useEffect(() => {
    const hits = result?.results.length ?? 0;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("input, textarea, select, [role=dialog]")) {
        if (event.key === "ArrowDown" && target.matches("[data-page-search]") && hits > 0) {
          event.preventDefault();
          setCursor(0);
          document.getElementById("search-hit-0")?.focus();
        }
        return;
      }
      const inList = target === document.body || target === document.documentElement || target.closest(".search-stage") !== null;
      if (!inList || hits === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End" || event.key === "j" || event.key === "k") {
        event.preventDefault();
        const key: ListKey = event.key === "j" ? "ArrowDown" : event.key === "k" ? "ArrowUp" : event.key;
        setCursor((current) => {
          const next = nextIndex(current, hits, key);
          document.getElementById(`search-hit-${next}`)?.focus();
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [result]);

  const hits = result?.results ?? [];
  const notices = result
    ? searchNoticeLines(result, { keyword: t("searchKeywordNote"), stale: t("searchStaleNote") })
    : [];
  const summary = joinNotice(notices);
  const filtered = hasActiveFilters(sources, range);
  const showInitial = result === null && !busy && error === null;
  const showNone = result !== null && hits.length === 0 && !busy && error === null;

  function submit(text = query): void {
    run(text, sources, range);
  }

  function pickSource(source: string): void {
    const next = nextSources(sources, source);
    setSources(next);
    if (query.trim() !== "") run(query, next, range);
  }

  function pickRange(value: string): void {
    if (!isSearchRange(value) || value === range) return;
    setRange(value);
    if (query.trim() !== "") run(query, sources, value);
  }

  function clearFilters(): void {
    setSources([]);
    setRange("all");
    if (query.trim() !== "") run(query, [], "all");
  }

  return (
    <Page>
      <div className="search-page">
        <PageHeader title={t("search")} />
        <div className="search-panel">
          <form
            className="search-bar"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <SearchField
              size="lg"
              autoFocus
              value={query}
              onChange={setQuery}
              label={t("searchQuery")}
              placeholder={t("searchPlaceholder")}
            />
            {query.trim() !== "" ? (
              <Button className="search-go" type="submit" variant="primary" loading={busy} iconRight={<Kbd>↵</Kbd>}>
                {t("search")}
              </Button>
            ) : null}
          </form>
          <div className="search-filters">
            <div className="search-sources" role="group" aria-label={t("filterSources")}>
              <Chip tone={sources.length === 0 ? "accent" : "neutral"} pressed={sources.length === 0} onClick={() => {
                if (sources.length === 0) return;
                setSources([]);
                if (query.trim() !== "") run(query, [], range);
              }}>
                {t("allSources")}
              </Chip>
              {SEARCH_SOURCES.map((source) => {
                const on = sources.includes(source);
                return (
                  <Chip key={source} tone={on ? "accent" : "neutral"} pressed={on} onClick={() => pickSource(source)} icon={<SourceTile source={source} size="sm" label={sourceLabel(source)} />}>
                    {sourceLabel(source)}
                  </Chip>
                );
              })}
            </div>
            <div className="search-range">
              <span className="search-range-label" id="search-range-label">
                {t("searchRangeShort")}
              </span>
              <Select
                label={t("searchRangeLabel")}
                value={range}
                onChange={pickRange}
                options={[
                  { value: "all", label: t("searchRangeAll") },
                  { value: "today", label: t("searchRangeToday") },
                  { value: "7d", label: t("searchRangeWeek") },
                  { value: "30d", label: t("searchRangeMonth") },
                ]}
              />
            </div>
          </div>
          {result ? (
            <div className="search-note">
              {summary !== "" ? (
                <button type="button" className="search-note-toggle" aria-expanded={notesOpen} onClick={() => setNotesOpen((open) => !open)}>
                  <Icon name="info" />
                  <span className="search-note-text">{summary}</span>
                  <Icon name={notesOpen ? "chevron-up" : "chevron-down"} size={14} />
                </button>
              ) : (
                <span />
              )}
              <span className="search-count">{t("results", { count: hits.length })}</span>
            </div>
          ) : null}
          {notesOpen && notices.length > 0 ? (
            <ul className="search-note-detail">
              {notices.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
        {error ? (
          <Banner
            tone="danger"
            action={
              <Button variant="ghost" size="sm" onClick={() => submit()}>
                {t("retry")}
              </Button>
            }
          >
            {error}
          </Banner>
        ) : null}
        <div className="search-stage" aria-busy={busy || undefined}>
          {showSkeleton ? (
            <Card className="search-skel" aria-hidden="true">
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </Card>
          ) : null}
          {hits.length > 0 ? (
            <Card>
              <SearchResults hits={hits} query={query} cursor={cursor} pending={busy} onSelect={(index) => {
                setCursor(index);
                document.getElementById(`search-hit-${index}`)?.focus();
              }} />
            </Card>
          ) : null}
          {showInitial ? (
            <div className="search-empty">
              <EmptyState
                icon="search"
                title={t("searchIntroTitle")}
                description={t("searchIntroBody")}
                secondary={
                  suggestions.length > 0 ? (
                    <div className="search-try">
                      <span className="search-try-label">{t("searchTry")}</span>
                      <div className="search-try-list">
                        {suggestions.map((name) => (
                          <Chip
                            key={name}
                            onClick={() => {
                              setQuery(name);
                              run(name, sources, range);
                            }}
                          >
                            <span className="search-try-name" title={name}>
                              {name}
                            </span>
                          </Chip>
                        ))}
                      </div>
                    </div>
                  ) : undefined
                }
              />
            </div>
          ) : null}
          {showNone ? (
            <div className="search-empty">
              <EmptyState
                icon="search-x"
                title={t("searchNoneTitle", { query: query.trim() })}
                description={t(filtered ? "searchNoneBody" : "searchNoneKeywordBody")}
                action={
                  filtered ? (
                    <Button variant="secondary" onClick={clearFilters}>
                      {t("searchClearFilters")}
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
