import { useEffect, useState } from "react";
import type { SearchResponse } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { BrowserDaemonError } from "../api/client.js";
import { Banner } from "../components/ui.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { Icon } from "../components/icons.js";
import { SourceMark } from "../components/tile.js";
import { Pill } from "../components/pill.js";
import { Row } from "../components/row.js";
import { searchNotices, searchTitle } from "../lib/copy.js";
import { formatDateTime, sourceLabel } from "../lib/format.js";

const SOURCES = ["claude-code", "codex", "grok-build", "cursor", "gemini-cli"] as const;

export function SearchPage() {
  const { t, language, client, timeZone } = useDaemon();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notices = result ? searchNotices(result, language) : [];

  async function run(text: string, sourceId: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.search(
        sourceId === "" ? { query: trimmed } : { query: trimmed, sources: [sourceId] },
      );
      setResult(next);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof BrowserDaemonError ? caught.message : t("actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial = params.get("q")?.trim() ?? "";
    const initialSource = params.get("source") ?? "";
    if (initial === "") return;
    setQuery(initial);
    if (SOURCES.some((item) => item === initialSource)) setSource(initialSource);
    void run(initial, SOURCES.some((item) => item === initialSource) ? initialSource : "");
    // The address bar is only a starting point for a shared or screenshot link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("search")}</h1>
      </header>
      <form
        className="search-hero"
        onSubmit={(event) => {
          event.preventDefault();
          void run(query, source);
        }}
      >
        <Icon name="search" />
        <input
          aria-label={t("searchQuery")}
          value={query}
          placeholder={t("searchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="btn primary small" disabled={busy || query.trim() === ""}>
          {busy ? t("working") : t("search")}
        </button>
      </form>
      <div className="pill-row" role="group" aria-label={t("filterSources")}>
        <Pill
          pressed={source === ""}
          onClick={() => {
            setSource("");
            if (query.trim() !== "") void run(query, "");
          }}
        >
          {t("allSources")}
        </Pill>
        {SOURCES.map((item) => (
          <Pill
            key={item}
            pressed={source === item}
            onClick={() => {
              const next = source === item ? "" : item;
              setSource(next);
              if (query.trim() !== "") void run(query, next);
            }}
          >
            {sourceLabel(item)}
          </Pill>
        ))}
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {notices.map((notice) => (
        <Banner key={notice.text} tone={notice.tone === "warn" ? "warn" : "info"}>
          {notice.text}
        </Banner>
      ))}
      {result ? (
        <p className="muted">
          {t("results", { count: result.results.length })}
          {" · "}
          {result.searchMode === "keyword" ? t("degradation") : t("searchSemantic")}
          {" · "}
          {result.indexStatus === "stale" ? t("expired") : t("indexFresh")}
        </p>
      ) : (
        <EmptyState title={t("emptySearchPrompt")} icon="search" />
      )}
      {result && result.results.length === 0 ? <EmptyState title={t("emptySearch")} icon="search" /> : null}
      {result && result.results.length > 0 ? (
        <Card>
          {result.results.map((hit) => (
            <Row
              key={`${hit.conversationId}-${hit.updatedAt}-${hit.excerpt.slice(0, 24)}`}
              icon={<SourceMark source={hit.source} />}
              title={searchTitle(hit)}
              subtitle={
                <>
                  <i className="dot dot-ok" />
                  <span>{sourceLabel(hit.source)}</span>
                  <span>{" · "}{hit.excerpt}</span>
                </>
              }
              trailing={
                <>
                  <time dateTime={hit.updatedAt}>{formatDateTime(hit.updatedAt, language, timeZone)}</time>
                  <span>{hit.score.toFixed(2)}</span>
                </>
              }
            />
          ))}
        </Card>
      ) : null}
    </div>
  );
}
