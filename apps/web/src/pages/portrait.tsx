import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
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
import { extractToc, parsePortraitMarkdown } from "../lib/markdown.js";
import { settingsHref } from "../lib/route.js";
import { countReadingChars, formatReadingCount, portraitEmptyCopy, writeClipboard } from "./portrait/logic.js";
import { PortraitMarkdown } from "./portrait/markdown-view.js";
import { PortraitProposals } from "./portrait/proposals.js";
import { PortraitSide } from "./portrait/side-panel.js";

const DEFAULT_VARIANTS = [
  { id: "full", path: "" },
  { id: "coding", path: "" },
  { id: "projects", path: "" },
];

const SKELETON_WIDTHS = ["100%", "96%", "92%", "84%", "100%", "70%"];

function useActiveHeading(ids: readonly string[], pane: RefObject<HTMLElement | null>): [string | null, (id: string) => void] {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    setActive(ids[0] ?? null);
    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) return;
    const split = window.matchMedia("(min-width: 960px)");
    let observer: IntersectionObserver;
    const observe = () => {
      observer?.disconnect();
      const root = split.matches ? pane.current : null;
      const visible = new Set<string>();
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const next = ids.find((id) => visible.has(id));
        if (next) setActive(next);
      }, { root, rootMargin: root ? "0px" : "-80px 0px 0px", threshold: [0, 1] });
      for (const node of nodes) observer.observe(node);
    };
    observe();
    split.addEventListener("change", observe);
    return () => {
      observer.disconnect();
      split.removeEventListener("change", observe);
    };
  }, [ids, pane]);
  return [active, setActive];
}

export function PortraitPage({ embedded = false, fileSettings }: { embedded?: boolean; fileSettings?: ReactNode } = {}) {
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
  const toc = useMemo(() => extractToc(parsePortraitMarkdown(content)), [content]);
  // 虚拟父项与组首子项共用锚点;高亮追踪只观察真实标题。
  const ids = useMemo(() => toc.filter((item) => !item.virtual).map((item) => item.id), [toc]);
  const mainRef = useRef<HTMLElement>(null);
  const [activeId, setActiveId] = useActiveHeading(ids, mainRef);
  const words = formatReadingCount(countReadingChars(content), language);
  const emptyCopy = portraitEmptyCopy({ consolidation: status?.consolidation, time: roles?.consolidation.time });

  async function copy(text: string, success: string): Promise<void> {
    const ok = await writeClipboard(text, (value) => navigator.clipboard.writeText(value));
    push({ message: ok ? success : t("portraitCopyFailed"), tone: ok ? "success" : "danger" });
  }

  const variantSwitcher = (
    <Segmented
      label={t("portrait")}
      value={variant}
      options={variants.map((item) => ({ value: item.id, label: variantName(item.id, language) }))}
      onChange={setVariant}
    />
  );

  const pageBody = (
    <div className={`portrait-page${embedded ? " is-embedded" : ""}`}>
        {/* 独立路由用完整页头;嵌入设置页时区块标题在外层,这里只补变体切换器。 */}
        {embedded ? (
          <div className="portrait-embedded-head">{variantSwitcher}</div>
        ) : (
        <PageHeader
          title={t("portrait")}
          description={t("portraitLead")}
          actions={variantSwitcher}
        />
        )}
        <div className={ready && !empty ? "portrait-layout has-side" : "portrait-layout"}>
          <section className="portrait-main" ref={mainRef} tabIndex={0} aria-label={t("portrait")}>
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
                {variant === "coding" ? (
                  <PortraitProposals onApplied={() => setAttempt((value) => value + 1)} />
                ) : null}
              </div>
            ) : null}
            {ready && body && !empty ? (
              <Card className="portrait-doc">
                <PortraitMarkdown source={body.content} />
              </Card>
            ) : null}
            {fileSettings}
          </section>
          {ready && body && !empty ? (
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
              onPortraitChanged={() => setAttempt((value) => value + 1)}
            />
          ) : null}
        </div>
      </div>
  );
  return embedded ? pageBody : <Page>{pageBody}</Page>;
}
