import { useEffect, useMemo, useState } from "react";
import type { PortraitResponse, PortraitSnapshot } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { useRoute } from "../router.js";
import { BrowserDaemonError } from "../api/client.js";
import { Banner } from "../components/banner.js";
import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { Page, PageHeader } from "../components/page.js";
import { Segmented } from "../components/segmented.js";
import { Skeleton } from "../components/skeleton.js";
import { useToast } from "../components/toast.js";
import { useDelayed } from "../components/use-delayed.js";
import { variantName } from "../lib/format.js";
import { extractToc, parseMarkdown } from "../lib/markdown.js";
import { settingsHref } from "../lib/route.js";
import { countReadingChars, formatReadingCount, portraitEmptyCopy, writeClipboard } from "./portrait/logic.js";
import { PortraitMarkdown } from "./portrait/markdown-view.js";
import { PortraitSide } from "./portrait/side-panel.js";

const DEFAULT_VARIANTS = [
  { id: "full", path: "" },
  { id: "coding", path: "" },
  { id: "projects", path: "" },
];

const SKELETON_WIDTHS = ["100%", "96%", "92%", "84%", "100%", "70%"];

function useActiveHeading(ids: readonly string[]): [string | null, (id: string) => void] {
  const key = ids.join("\n");
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    setActive(ids[0] ?? null);
    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        const next = [...visible.entries()].sort((left, right) => left[1] - right[1])[0]?.[0];
        if (next) setActive(next);
      },
      { rootMargin: "-80px 0px -55% 0px", threshold: [0, 1] },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [key, ids]);
  return [active, setActive];
}

export function PortraitPage() {
  const { t, language, config, client, status, roles } = useDaemon();
  const { navigate } = useRoute();
  const { push } = useToast();
  const variants = config?.portrait.variants ?? DEFAULT_VARIANTS;
  const [variant, setVariant] = useState(variants[0]?.id ?? "full");
  const [body, setBody] = useState<PortraitResponse | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<PortraitSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const showSkeleton = useDelayed(loading);

  useEffect(() => {
    const first = variants[0]?.id;
    if (first && !variants.some((item) => item.id === variant)) setVariant(first);
  }, [variants, variant]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void Promise.all([client.portrait(variant), client.portraitSnapshots()])
      .then(([portrait, list]) => {
        if (!alive) return;
        setBody(portrait);
        setSnapshots(list.snapshots);
        setLoadedFor(variant);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setBody(null);
        setLoadedFor(null);
        setError(caught instanceof BrowserDaemonError ? caught.message : t("loadFailed"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [client, variant, attempt, t]);

  const ready = !loading && error === null && body !== null && loadedFor === variant;
  const content = ready && body ? body.content : "";
  const empty = ready && content.trim() === "";
  const toc = useMemo(() => extractToc(parseMarkdown(content)), [content]);
  const ids = useMemo(() => toc.map((item) => item.id), [toc]);
  const [activeId, setActiveId] = useActiveHeading(ids);
  const words = formatReadingCount(countReadingChars(content), language);
  const emptyCopy = portraitEmptyCopy({ consolidation: status?.consolidation, time: roles?.consolidation.time });

  async function copy(text: string, success: string): Promise<void> {
    const ok = await writeClipboard(text, (value) => navigator.clipboard.writeText(value));
    push({ message: ok ? success : t("portraitCopyFailed"), tone: ok ? "success" : "danger" });
  }

  return (
    <Page>
      <div className="portrait-page">
        <PageHeader
          title={t("portrait")}
          description={t("portraitLead")}
          actions={
            <Segmented
              label={t("portrait")}
              value={variant}
              options={variants.map((item) => ({ value: item.id, label: variantName(item.id, language) }))}
              onChange={setVariant}
            />
          }
        />
        {error ? (
          <Banner
            tone="danger"
            action={
              <Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>
                {t("retry")}
              </Button>
            }
          >
            {error}
          </Banner>
        ) : null}
        {!error && !ready && showSkeleton ? (
          <Card className="portrait-doc portrait-skeleton" aria-hidden="true">
            <Skeleton width="48%" height={24} />
            {SKELETON_WIDTHS.map((width, index) => (
              <Skeleton key={index} width={width} height={12} />
            ))}
          </Card>
        ) : null}
        {!error && !ready && !showSkeleton ? <div className="portrait-hold" aria-hidden="true" /> : null}
        {empty ? (
          <div className="portrait-empty">
            <EmptyState
              icon="user"
              title={t("portraitEmptyTitle")}
              description={
                emptyCopy.kind === "off"
                  ? t("portraitEmptyOffBody")
                  : emptyCopy.kind === "scheduled"
                    ? t("portraitEmptyBodyAt", { time: emptyCopy.time })
                    : t("portraitEmptyBody")
              }
              action={
                emptyCopy.kind === "off" ? (
                  <Button variant="primary" onClick={() => navigate(settingsHref("consolidation"))}>
                    {t("portraitEnableConsolidation")}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => navigate("/status")}>
                    {t("portraitViewStatus")}
                  </Button>
                )
              }
            />
          </div>
        ) : null}
        {ready && body && !empty ? (
          <div className="portrait-layout">
            <Card className="portrait-doc">
              <PortraitMarkdown source={body.content} />
            </Card>
            <PortraitSide
              variant={variant}
              toc={toc}
              activeId={activeId}
              onJump={setActiveId}
              path={body.path}
              updatedAt={body.updatedAt}
              words={words}
              snapshots={snapshots}
              onCopyPath={() => {
                void copy(body.path, t("portraitCopiedPath"));
              }}
              onCopyBody={() => {
                void copy(body.content, t("portraitCopied"));
              }}
            />
          </div>
        ) : null}
      </div>
    </Page>
  );
}
