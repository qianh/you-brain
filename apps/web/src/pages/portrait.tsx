import { useEffect, useState } from "react";
import type { PortraitResponse, PortraitSnapshot } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { BrowserDaemonError } from "../api/client.js";
import { MarkdownView } from "../components/ui.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { Icon } from "../components/icons.js";
import { Row } from "../components/row.js";
import { Segmented } from "../components/segmented.js";
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
        <Segmented
          label={t("portrait")}
          value={variant}
          options={variants.map((item) => ({ value: item.id, label: variantName(item.id, language) }))}
          onChange={setVariant}
        />
      </header>
      {error ? <p className="form-error">{error}</p> : null}
      <Card padded className="prose">
        <p className="muted tiny">{body?.path || variants.find((item) => item.id === variant)?.path}</p>
        {body?.content ? <MarkdownView source={body.content} /> : <EmptyState title={t("portraitMissing")} icon="user" />}
        {body?.updatedAt ? (
          <p className="muted tiny">
            {t("updated")} {formatDateTime(body.updatedAt, language, timeZone)}
          </p>
        ) : null}
      </Card>
      <section className="stack">
        <h2 className="group-label">
          <span>{t("snapshots")}</span>
        </h2>
        <p className="muted">{t("correctionLater")}</p>
        {snapshots.length === 0 ? <EmptyState title={t("emptySnapshots")} icon="book" /> : null}
        {snapshots.length > 0 ? (
          <Card>
            {snapshots.map((snapshot) => (
              <Row
                key={snapshot.path}
                icon={<Icon name="book" />}
                title={snapshot.name}
                subtitle={
                  <>
                    <span>{snapshot.path}</span>
                    {snapshot.updatedAt ? (
                      <span>{" · "}{formatDateTime(snapshot.updatedAt, language, timeZone)}</span>
                    ) : null}
                  </>
                }
              />
            ))}
          </Card>
        ) : null}
      </section>
    </div>
  );
}
