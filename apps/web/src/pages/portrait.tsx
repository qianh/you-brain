import { useEffect, useState } from "react";
import type { PortraitResponse, PortraitSnapshot } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { BrowserDaemonError } from "../api/client.js";
import { Empty, MarkdownView } from "../components/ui.js";
import { formatDateTime, variantName } from "../lib/format.js";

const DEFAULT_VARIANTS = [
  { id: "full", path: "" },
  { id: "brief", path: "" },
  { id: "coding", path: "" },
];

export function PortraitPage() {
  const { t, language, config, client, timeZone } = useDaemon();
  const variants = config?.portrait.variants ?? DEFAULT_VARIANTS;
  const [variant, setVariant] = useState(variants[0]?.id ?? "full");
  const [body, setBody] = useState<PortraitResponse | null>(null);
  const [snapshots, setSnapshots] = useState<PortraitSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const first = variants[0]?.id;
    if (first && !variants.some((item) => item.id === variant)) setVariant(first);
  }, [variants, variant]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void Promise.all([client.portrait(variant), client.portraitSnapshots()])
      .then(([portrait, list]) => {
        if (controller.signal.aborted) return;
        setBody(portrait);
        setSnapshots(list.snapshots);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setBody(null);
        setError(caught instanceof BrowserDaemonError ? caught.message : t("loadFailed"));
      });
    return () => controller.abort();
  }, [client, variant, t]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("portrait")}</h1>
          <p>{t("portraitHint")}</p>
        </div>
      </header>
      <div className="segmented" role="tablist" aria-label={t("portrait")}>
        {variants.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className={item.id === variant ? "on" : ""}
            aria-selected={item.id === variant}
            onClick={() => setVariant(item.id)}
          >
            {variantName(item.id, language)}
          </button>
        ))}
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      <section className="card prose">
        <p className="muted tiny">{body?.path || variants.find((item) => item.id === variant)?.path}</p>
        {body?.content ? <MarkdownView source={body.content} /> : <Empty>{t("portraitMissing")}</Empty>}
        {body?.updatedAt ? (
          <p className="muted tiny">
            {t("updated")} {formatDateTime(body.updatedAt, language, timeZone)}
          </p>
        ) : null}
      </section>
      <section>
        <h2>{t("snapshots")}</h2>
        <p className="muted">{t("correctionLater")}</p>
        {snapshots.length === 0 ? <Empty>{t("emptySnapshots")}</Empty> : null}
        <ul className="plain-list">
          {snapshots.map((snapshot) => (
            <li key={snapshot.path}>
              <strong>{snapshot.name}</strong>
              <small>
                {snapshot.path}
                {snapshot.updatedAt
                  ? ` · ${formatDateTime(snapshot.updatedAt, language, timeZone)}`
                  : ""}
              </small>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
