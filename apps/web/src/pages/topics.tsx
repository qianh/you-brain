import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TopicDetail } from "@you-brain/core/http/types.js";

import { BrowserDaemonError } from "../api/client.js";
import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { Icon } from "../components/icons.js";
import { PageHeader } from "../components/page.js";
import { Segmented } from "../components/segmented.js";
import { Skeleton, SkeletonRow } from "../components/skeleton.js";
import { useDelayed } from "../components/use-delayed.js";
import { useDaemon } from "../daemon-context.js";
import { topicHref } from "../lib/route.js";
import { isTextEntry } from "../lib/shortcuts.js";
import { useRoute } from "../router.js";
import { highlightId, moveInList, showsNarrowDetail, statusCounts, visibleTopics, type StatusFilter } from "./topics/logic.js";
import { TopicDetailPane } from "./topics/topic-detail.js";
import { TopicList } from "./topics/topic-list.js";
import { useTopicActions } from "./topics/use-topic-actions.js";

function useMaxWidth(max: number): boolean {
  const query = `(max-width: ${max}px)`;
  const [matches, setMatches] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (): void => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function scrollRow(container: HTMLElement, id: string, focus: boolean): void {
  const row = container.querySelector<HTMLElement>(`[data-topic-id="${CSS.escape(id)}"]`);
  if (!row) return;
  const rowBox = row.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  if (rowBox.height === 0) return;
  if (rowBox.top < box.top) container.scrollTop -= box.top - rowBox.top;
  else if (rowBox.bottom > box.bottom) container.scrollTop += rowBox.bottom - box.bottom;
  if (focus) row.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
}

export function TopicsPage({ zone }: { zone: "active" | "history" }) {
  const { t, topics, config, loading, error, client, reload, detailRevision } = useDaemon();
  const { location, navigate } = useRoute();
  const narrow = useMaxWidth(859);
  const selected = location.id;
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<TopicDetail | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "missing" | "error">("idle");
  const [retryToken, setRetryToken] = useState(0);
  const epoch = useRef(0);
  const busyRef = useRef(false);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const listRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  const wasDetail = useRef(false);
  const actions = useTopicActions(detail, setDetail, zone, epoch, busyRef);

  const queryForZone = zone === "history" ? query : "";
  const patched = topics.map((topic) => actions.displayTopic(topic));
  const inZone = patched.filter((topic) => topic.zone === zone);
  const counted = visibleTopics(patched, zone, "all", queryForZone);
  const counts = statusCounts(counted);
  const visible = visibleTopics(patched, zone, filter, queryForZone);
  const visibleIds = visible.map((topic) => topic.topicId);
  const detailOpen = showsNarrowDetail(narrow, selected);
  const highlighted = highlightId(visibleIds, selected, cursor, narrow && !detailOpen);
  const sessionCount = detail !== null && detail.topicId === highlighted ? detail.sessions.length : null;
  const days = config?.topics.historyDays ?? 30;
  const pending = loading && topics.length === 0;
  const showListSkeleton = useDelayed(pending);
  const detailWaiting = selected !== null && phase !== "missing" && phase !== "error" && (detail === null || detail.topicId !== selected);
  const showDetailSkeleton = useDelayed(detailWaiting);

  const narrowRef = useRef(narrow);
  const detailOpenRef = useRef(detailOpen);
  const zoneRef = useRef(zone);
  narrowRef.current = narrow;
  detailOpenRef.current = detailOpen;
  zoneRef.current = zone;
  const keyboardRef = useRef({ ids: visibleIds, highlighted, narrow, detailOpen, zone });
  keyboardRef.current = { ids: visibleIds, highlighted, narrow, detailOpen, zone };

  const openTopic = (id: string): void => {
    if (narrowRef.current) {
      if (listRef.current) savedScroll.current = listRef.current.scrollTop;
      navigate(topicHref(zoneRef.current, id));
      return;
    }
    navigate(topicHref(zoneRef.current, id), "replace");
  };
  const openRef = useRef(openTopic);
  openRef.current = openTopic;

  const backToList = (): void => {
    navigate(topicHref(zone), "replace");
  };

  useLayoutEffect(() => {
    if (detailOpen) {
      wasDetail.current = true;
      return;
    }
    if (!wasDetail.current) return;
    wasDetail.current = false;
    const node = listRef.current;
    if (node) node.scrollTop = savedScroll.current;
  }, [detailOpen]);

  useEffect(() => {
    const node = listRef.current;
    if (!highlighted || !node || detailOpen) return;
    scrollRow(node, highlighted, false);
  }, [highlighted, detailOpen]);

  useEffect(() => {
    if (!selected) return;
    const listed = topics.find((topic) => topic.topicId === selected);
    if (listed && listed.zone !== zone) navigate(topicHref(listed.zone, listed.topicId), "replace");
  }, [navigate, selected, topics, zone]);

  useEffect(() => {
    if (!detail || detail.topicId !== selected) return;
    if (detail.zone !== zone) navigate(topicHref(detail.zone, detail.topicId), "replace");
  }, [detail, navigate, selected, zone]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setPhase("idle");
      return;
    }
    if (busyRef.current && detailRef.current?.topicId === selected) return;
    const token = ++epoch.current;
    const same = detailRef.current?.topicId === selected;
    if (!same) {
      setDetail(null);
      setPhase("loading");
    }
    let cancelled = false;
    void client
      .topic(selected)
      .then((next) => {
        if (cancelled || epoch.current !== token) return;
        setDetail(next);
        setPhase("ready");
      })
      .catch((caught: unknown) => {
        if (cancelled || epoch.current !== token) return;
        if (caught instanceof BrowserDaemonError && caught.status === 404) {
          setDetail(null);
          setPhase("missing");
          return;
        }
        if (detailRef.current?.topicId === selected) return;
        setDetail(null);
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [client, detailRevision, retryToken, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isTextEntry(event.target)) return;
      if (document.querySelector(".scrim, .popover")) return;
      const state = keyboardRef.current;
      const key = event.key;
      if (key === "ArrowDown" || key === "ArrowUp" || key === "j" || key === "k") {
        event.preventDefault();
        const direction = key === "ArrowDown" || key === "j" ? "next" : "prev";
        const next = moveInList(state.ids, state.highlighted, direction);
        if (!next) return;
        if (state.narrow && !state.detailOpen) setCursor(next);
        else navigate(topicHref(state.zone, next), "replace");
        window.requestAnimationFrame(() => {
          const node = listRef.current;
          if (node) scrollRow(node, next, true);
        });
        return;
      }
      if (key === "Enter") {
        const target = event.target;
        if (target instanceof Element && target.closest("a, button")) return;
        const id = state.highlighted;
        if (!id) return;
        event.preventDefault();
        openRef.current(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const header = (
    <PageHeader
      title={t("topicsBook")}
      actions={
        <Segmented
          label={t("topicsBook")}
          value={zone}
          options={[
            { value: "active", label: t("zoneActive") },
            { value: "history", label: t("zoneHistory") },
          ]}
          onChange={(value) => navigate(value === "history" ? "/topics/history" : "/topics")}
        />
      }
    />
  );

  const zoneBlank = inZone.length === 0
    ? zone === "history"
      ? { title: t("emptyHistoryTitle"), description: t("emptyHistoryBody", { days }) }
      : {
          title: t("emptyActiveTitle"),
          description: t("emptyActiveBody"),
          action: (
            <Button size="sm" onClick={() => navigate("/status")}>
              {t("viewStatus")}
            </Button>
          ),
        }
    : null;

  let body: ReactNode;
  if (pending) {
    body = showListSkeleton ? (
      <div className="topics-grid" aria-busy="true">
        <Card className="topics-rail">
          <p className="topics-sr">{t("loadingTopics")}</p>
          <div className="topics-list-scroll">
            {Array.from({ length: 5 }, (_, index) => (
              <SkeletonRow key={index} />
            ))}
          </div>
        </Card>
        <Card className="topics-detail">
          <div className="topics-detail-scroll">
            <DetailSkeleton />
          </div>
        </Card>
      </div>
    ) : (
      <div className="topics-stage" aria-busy="true">
        <p className="topics-sr">{t("loadingTopics")}</p>
      </div>
    );
  } else if (error && topics.length === 0) {
    body = (
      <div className="topics-stage">
        <EmptyState
          icon="alert-circle"
          title={t("listFailedTitle")}
          description={t("listFailedBody")}
          action={
            <Button size="sm" onClick={() => void reload("all")}>
              {t("retry")}
            </Button>
          }
        />
      </div>
    );
  } else if (!selected && inZone.length === 0) {
    body = (
      <div className="topics-stage">
        <EmptyState
          size="sm"
          icon="book"
          title={zone === "history" ? t("emptyHistoryTitle") : t("emptyActiveTitle")}
          description={zone === "history" ? t("emptyHistoryBody", { days }) : t("emptyActiveBody")}
          {...(zone === "active"
            ? {
                action: (
                  <Button size="sm" onClick={() => navigate("/status")}>
                    {t("viewStatus")}
                  </Button>
                ),
              }
            : {})}
        />
      </div>
    );
  } else {
    const detailBody = detail && detail.topicId === selected ? (
      <TopicDetailPane
        detail={detail}
        topics={patched}
        busy={actions.busy}
        historyNote={actions.historyNote}
        onRename={actions.rename}
        onStatus={actions.setStatus}
        onAliases={actions.changeAliases}
        onTodo={(todoId, text, from, to) => void actions.setTodo(todoId, text, from, to)}
        onConclusion={actions.addConclusion}
        onMerge={actions.mergeInto}
        onSplit={actions.splitSession}
        onCopy={() => void actions.copyLink()}
      />
    ) : phase === "missing" ? (
      <EmptyState
        icon="search-x"
        title={t("missingTopicTitle")}
        description={t("missingTopicBody")}
        action={
          <Button size="sm" onClick={backToList}>
            {t("backToList")}
          </Button>
        }
      />
    ) : phase === "error" ? (
      <EmptyState
        icon="alert-circle"
        title={t("detailFailedTitle")}
        description={t("detailFailedBody")}
        action={
          <Button size="sm" onClick={() => setRetryToken((value) => value + 1)}>
            {t("retry")}
          </Button>
        }
      />
    ) : showDetailSkeleton || detailWaiting ? (
      showDetailSkeleton ? <DetailSkeleton /> : <p className="topics-sr">{t("loadingTopics")}</p>
    ) : (
      <EmptyState icon="book-open" title={t("emptyPickTitle")} description={t("emptyPickBody")} />
    );
    const centered = !(detail && detail.topicId === selected);
    body = (
      <div className="topics-grid">
        <Card className="topics-rail">
          <TopicList
            ref={listRef}
            zone={zone}
            topics={visible}
            counts={counts}
            filter={filter}
            onFilter={setFilter}
            query={query}
            onQuery={setQuery}
            highlighted={highlighted}
            sessionCount={sessionCount}
            loading={false}
            zoneBlank={zoneBlank}
            onOpen={openTopic}
            onScroll={() => {
              if (detailOpenRef.current || !listRef.current) return;
              savedScroll.current = listRef.current.scrollTop;
            }}
          />
        </Card>
        <Card className="topics-detail">
          <div className="topics-detail-scroll">
            <div className={centered ? "topics-read is-fill" : "topics-read"}>
              <button type="button" className="topics-back" onClick={backToList}>
                <Icon name="chevron-left" size={16} />
                <span>{t("topicsBook")}</span>
              </button>
              {detailBody}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return <div className={detailOpen ? "topics-page is-detail" : "topics-page is-list"}>{header}{body}</div>;
}

function DetailSkeleton() {
  return (
    <div className="topics-skeleton" aria-hidden="true">
      <Skeleton width="46%" height={24} />
      <Skeleton width="72%" height={12} />
      <Skeleton width="100%" height={72} />
      <Skeleton width="100%" height={48} />
      <Skeleton width="90%" height={14} />
      <Skeleton width="74%" height={14} />
    </div>
  );
}
