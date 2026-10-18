import { useState } from "react";
import type { SearchResponse } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { BrowserDaemonError } from "../api/client.js";
import { Banner, Empty } from "../components/ui.js";
import { searchNotices, searchTitle } from "../lib/copy.js";
import { formatDateTime, sourceLabel } from "../lib/format.js";

export function SearchPage() {
  const { t, language, client, timeZone } = useDaemon();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notices = result ? searchNotices(result, language) : [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("search")}</h1>
          <p>{t("emptySearchPrompt")}</p>
        </div>
      </header>
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          const text = query.trim();
          if (!text) return;
          setBusy(true);
          setError(null);
          void client
            .search({ query: text })
            .then((next) => setResult(next))
            .catch((caught: unknown) => {
              setResult(null);
              setError(caught instanceof BrowserDaemonError ? caught.message : t("actionFailed"));
            })
            .finally(() => setBusy(false));
        }}
      >
        <label className="field grow">
          <span>{t("searchQuery")}</span>
          <input
            value={query}
            placeholder={t("searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy || query.trim() === ""}>
          {busy ? t("working") : t("search")}
        </button>
      </form>
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
      ) : null}
      {result && result.results.length === 0 ? <Empty>{t("emptySearch")}</Empty> : null}
      <div className="stack">
        {result?.results.map((hit) => (
          <article key={`${hit.conversationId}-${hit.updatedAt}-${hit.excerpt.slice(0, 24)}`} className="session">
            <div className="session-meta">
              <span className="pill">{sourceLabel(hit.source)}</span>
              <time dateTime={hit.updatedAt}>{formatDateTime(hit.updatedAt, language, timeZone)}</time>
              <span className="muted">{hit.score.toFixed(2)}</span>
            </div>
            <h3>{searchTitle(hit)}</h3>
            <p className="summary-text">{hit.excerpt}</p>
            <p className="muted tiny">
              {t("conversation")} {hit.conversationId}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
