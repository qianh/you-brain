import { forwardRef, type ReactNode } from "react";
import type { TopicListItem } from "@you-brain/core/http/types.js";
import type { TopicStatus } from "@you-brain/protocol";

import { Button } from "../../components/button.js";
import { Chip } from "../../components/chip.js";
import { EmptyState } from "../../components/empty.js";
import { SearchField } from "../../components/input.js";
import { Row } from "../../components/row.js";
import { SkeletonRow } from "../../components/skeleton.js";
import { useDaemon } from "../../daemon-context.js";
import { topicHref } from "../../lib/route.js";
import { STATUS_FILTERS, joinMeta, statusLabelKey, type StatusFilter } from "./logic.js";
import { RelativeTime } from "./relative-time.js";
import { StatusDot } from "./status-dot.js";

export const TopicList = forwardRef<HTMLDivElement, {
  zone: "active" | "history";
  topics: readonly TopicListItem[];
  counts: Record<StatusFilter, number>;
  filter: StatusFilter;
  onFilter: (filter: StatusFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  highlighted: string | null;
  sessionCount: number | null;
  loading: boolean;
  zoneBlank: { title: string; description: string; action?: ReactNode } | null;
  onOpen: (id: string) => void;
  onScroll: () => void;
}>(function TopicList({
  zone,
  topics,
  counts,
  filter,
  onFilter,
  query,
  onQuery,
  highlighted,
  sessionCount,
  loading,
  zoneBlank,
  onOpen,
  onScroll,
}, ref) {
  const { t } = useDaemon();
  const filters: Array<{ id: StatusFilter; label: string }> = STATUS_FILTERS.map((id) => ({
    id,
    label: id === "all" ? t("filterAll") : t(statusLabelKey(id as TopicStatus)),
  }));
  return (
    <div className="topics-list">
      <div className="topics-filters" role="toolbar" aria-label={t("filterAll")}>
        {filters.map((item) => {
          const pressed = filter === item.id;
          return (
            <Chip key={item.id} tone={pressed ? "accent" : "neutral"} pressed={pressed} onClick={() => onFilter(item.id)}>
              {item.label}
              <span className="topics-count">{counts[item.id]}</span>
            </Chip>
          );
        })}
      </div>
      {zone === "history" ? (
        <div className="topics-search">
          <SearchField label={t("searchTopicsLabel")} placeholder={t("searchTopics")} value={query} onChange={onQuery} />
        </div>
      ) : null}
      <div className="topics-list-scroll" ref={ref} role="list" aria-label={t("listLabel")} aria-busy={loading} onScroll={onScroll}>
        {loading ? (
          <>
            <p className="topics-sr">{t("loadingTopics")}</p>
            {Array.from({ length: 5 }, (_, index) => (
              <SkeletonRow key={index} />
            ))}
          </>
        ) : topics.length === 0 ? (
          <ListEmpty
            query={query}
            filter={filter}
            zoneBlank={zoneBlank}
            onQuery={onQuery}
            onFilter={onFilter}
          />
        ) : (
          topics.map((topic) => {
            const selected = topic.topicId === highlighted;
            const sessions = selected ? sessionCount : null;
            return (
              <div key={topic.topicId} className={selected ? "topics-item is-selected" : "topics-item"} data-topic-id={topic.topicId} role="listitem">
                <Row
                  href={topicHref(zone, topic.topicId)}
                  current={selected}
                  onClick={() => onOpen(topic.topicId)}
                  icon={<StatusDot status={topic.status} />}
                  title={topic.name}
                  titleText={topic.name}
                  subtitle={
                    <span className="topics-subline">
                      <span className="topics-sr">{t(statusLabelKey(topic.status))}</span>
                      <span>{joinMeta([sessions !== null ? t("groupLabel", { count: sessions }) : null])}</span>
                      {sessions !== null ? <span aria-hidden="true"> · </span> : null}
                      <RelativeTime iso={topic.lastActive} />
                    </span>
                  }
                  trailing={
                    <>
                      {topic.status !== "active" ? (
                        <Chip tone={topic.status === "follow_up" ? "warn" : topic.status === "done" ? "accent" : "neutral"}>
                          {t(statusLabelKey(topic.status))}
                        </Chip>
                      ) : null}
                      {topic.openTodoCount > 0 ? <Chip>{topic.openTodoCount}</Chip> : null}
                    </>
                  }
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});

function ListEmpty({
  query,
  filter,
  zoneBlank,
  onQuery,
  onFilter,
}: {
  query: string;
  filter: StatusFilter;
  zoneBlank: { title: string; description: string; action?: ReactNode } | null;
  onQuery: (query: string) => void;
  onFilter: (filter: StatusFilter) => void;
}) {
  const { t } = useDaemon();
  if (query.trim() !== "") {
    return (
      <EmptyState
        size="sm"
        icon="search"
        title={t("searchEmptyTitle")}
        description={t("searchEmptyBody")}
        action={
          <Button size="sm" onClick={() => onQuery("")}>
            {t("clearSearch")}
          </Button>
        }
      />
    );
  }
  if (filter !== "all") {
    return (
      <EmptyState
        size="sm"
        icon="book"
        title={t("filterEmptyTitle")}
        description={t("filterEmptyBody")}
        action={
          <Button size="sm" onClick={() => onFilter("all")}>
            {t("showAllTopics")}
          </Button>
        }
      />
    );
  }
  if (zoneBlank) {
    return (
      <EmptyState
        size="sm"
        icon="book"
        title={zoneBlank.title}
        description={zoneBlank.description}
        {...(zoneBlank.action ? { action: zoneBlank.action } : {})}
      />
    );
  }
  return <EmptyState size="sm" icon="book" title={t("filterEmptyTitle")} description={t("filterEmptyBody")} />;
}
