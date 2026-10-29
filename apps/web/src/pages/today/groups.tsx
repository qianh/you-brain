import { useEffect, useState, type ReactNode } from "react";
import type { TodaySession } from "@you-brain/core/http/types.js";
import type { TopicListItem } from "@you-brain/core/http/types.js";

import { useDaemon } from "../../daemon-context.js";
import { Card, Section } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { Icon } from "../../components/icons.js";
import { SessionRow, toSessionCard } from "../../components/session-row.js";
import { SourceTile } from "../../components/tile.js";
import { ShowMore } from "../../components/show-more.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import { formatDateTime, sourceLabel, type Language } from "../../lib/format.js";
import type { NamedDevice } from "../../lib/format.js";
import { groupSessionsByTopic } from "../../lib/group.js";
import { rowsBeforeToggle, toggleAnchorIndex } from "../../components/show-more-nav.js";
import { nextIndex, type ListKey } from "../../lib/list-nav.js";
import { topicHref } from "../../lib/route.js";
import { isTextEntry } from "../../lib/shortcuts.js";
import { useRoute } from "../../router.js";
import { groupSessionsByHour, latestMoment, topicZone, type TodayMode } from "./model.js";

const LIMIT = 5;

export interface SourceCount {
  source: string;
  count: number;
}

/** magpie 风格的会话区:来源筛选 tab + 搜索框 + 可折叠话题分组。 */
export function TodayGroups({
  mode,
  sessions,
  devices,
  language,
  timeZone,
  topics,
  arrived,
  sourceCounts,
  sourceFilter,
  onSourceFilter,
  query,
  onQuery,
}: {
  mode: TodayMode;
  sessions: readonly TodaySession[];
  devices: readonly NamedDevice[];
  language: Language;
  timeZone: string;
  topics: readonly TopicListItem[];
  arrived: ReadonlySet<string>;
  sourceCounts: readonly SourceCount[];
  sourceFilter: string | "all";
  onSourceFilter: (value: string | "all") => void;
  query: string;
  onQuery: (value: string) => void;
}) {
  useSessionArrows();
  const { t } = useDaemon();
  const hasFilters = sourceFilter !== "all" || query.trim() !== "";
  const toolbar =
    mode === "topic" ? (
      <div className="today-toolbar">
        <div className="today-source-tabs" role="tablist" aria-label={t("todaySourceFilter")}>
          <SourceTab
            active={sourceFilter === "all"}
            count={sourceCounts.reduce((sum, entry) => sum + entry.count, 0)}
            label={t("todaySourceAll")}
            onClick={() => onSourceFilter("all")}
          />
          {sourceCounts.map((entry) => (
            <SourceTab
              key={entry.source}
              source={entry.source}
              active={sourceFilter === entry.source}
              count={entry.count}
              label={sourceLabel(entry.source)}
              onClick={() => onSourceFilter(entry.source)}
            />
          ))}
        </div>
        <input
          className="today-session-search"
          type="search"
          placeholder={t("searchPlaceholder")}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
    ) : null;
  if (mode === "time") {
    const groups = groupSessionsByHour(sessions, timeZone, t("todayUnknownHour"));
    return (
      <div className="today-groups">
        {toolbar}
        {groups.map((group) => (
          <Section key={group.key} title={<span className="today-hour">{group.label}</span>} hint={<Chip>{group.sessions.length}</Chip>}>
            <Card>
              <ShowMore items={group.sessions} limit={LIMIT}>
                {(session) => (
                  <SessionRow
                    key={session.sessionKey}
                    variant="today"
                    session={toSessionCard(session)}
                    devices={devices}
                    timeZone={timeZone}
                    language={language}
                    showTopic
                    arrived={arrived.has(session.sessionKey)}
                  />
                )}
              </ShowMore>
            </Card>
          </Section>
        ))}
      </div>
    );
  }
  const groups = groupSessionsByTopic(sessions, t("unassigned"));
  return (
    <div className="today-groups">
      {toolbar}
      {groups.length === 0 && hasFilters ? (
        <p className="today-quiet">{t("todayNoMatch")}</p>
      ) : null}
      {groups.map((group) => (
        <TopicGroup
          key={group.topicId ?? "none"}
          name={group.topicName}
          topicId={group.topicId}
          sessions={group.sessions}
          devices={devices}
          language={language}
          timeZone={timeZone}
          topics={topics}
          arrived={arrived}
        />
      ))}
    </div>
  );
}

function SourceTab({
  source,
  label,
  count,
  active,
  onClick,
}: {
  source?: string;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? "today-source-tab is-active" : "today-source-tab"}
      onClick={onClick}
    >
      {source ? <SourceTile source={source} size="sm" /> : null}
      <span>{label}</span>
      <span className="today-source-count">{count}</span>
    </button>
  );
}

function TopicGroup({
  name,
  topicId,
  sessions,
  devices,
  language,
  timeZone,
  topics,
  arrived,
}: {
  name: string;
  topicId: string | null;
  sessions: TodaySession[];
  devices: readonly NamedDevice[];
  language: Language;
  timeZone: string;
  topics: readonly TopicListItem[];
  arrived: ReadonlySet<string>;
}) {
  const { t } = useDaemon();
  const { navigate } = useRoute();
  const [collapsed, setCollapsed] = useState(false);
  const latest = latestMoment(sessions);
  const relative = useRelativeTime(latest, language, timeZone);
  const absolute = formatDateTime(latest, language, timeZone);
  const title =
    topicId === null ? (
      <span className="today-unassigned">{name}</span>
    ) : (
      <button
        type="button"
        className="today-topic-link"
        onClick={() => navigate(topicHref(topicZone(topics, topicId), topicId))}
      >
        <span>{name}</span>
        <Icon name="chevron-right" size={14} />
      </button>
    );
  const header = (
    <>
      <button
        type="button"
        className={collapsed ? "today-group-caret is-collapsed" : "today-group-caret"}
        aria-label={collapsed ? t("todayGroupExpand") : t("todayGroupCollapse")}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        ▾
      </button>
      {title}
    </>
  );
  return (
    <Section
      title={<span className="today-group-head">{header}</span>}
      hint={<Chip>{sessions.length}</Chip>}
      actions={
        <time className="today-group-time" dateTime={latest ?? undefined} title={absolute}>
          {relative}
        </time>
      }
    >
      {collapsed ? null : (
        <Card>
          <ShowMore items={sessions} limit={LIMIT}>
            {(session) => (
              <SessionRow
                key={session.sessionKey}
                variant="today"
                session={toSessionCard(session)}
                devices={devices}
                timeZone={timeZone}
                language={language}
                arrived={arrived.has(session.sessionKey)}
              />
            )}
          </ShowMore>
        </Card>
      )}
    </Section>
  );
}

function listKey(key: string): ListKey | null {
  if (key === "ArrowDown" || key === "j") return "ArrowDown";
  if (key === "ArrowUp" || key === "k") return "ArrowUp";
  if (key === "Home") return "Home";
  if (key === "End") return "End";
  return null;
}

function useSessionArrows(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const key = listKey(event.key);
      if (!key) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEntry(event.target)) return;
      if (document.querySelector("[role='dialog']")) return;
      const rows = [...document.querySelectorAll<HTMLElement>(".today-page [data-session-key]")];
      if (rows.length === 0) return;
      const active = document.activeElement;
      let index = rows.findIndex((row) => row === active || (active instanceof Node && row.contains(active)));
      if (index < 0 && active instanceof HTMLElement && active.matches("button.show-more:not(.inline)")) {
        index = toggleAnchorIndex(
          rowsBeforeToggle(
            rows.map((row) => row.compareDocumentPosition(active)),
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          key,
        );
      }
      event.preventDefault();
      const next = rows[nextIndex(index, rows.length, key)];
      next?.querySelector<HTMLElement>("[data-session-row]")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
