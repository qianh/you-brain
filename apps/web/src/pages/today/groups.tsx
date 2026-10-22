import { useEffect } from "react";
import type { TodaySession } from "@you-brain/core/http/types.js";
import type { TopicListItem } from "@you-brain/core/http/types.js";

import { useDaemon } from "../../daemon-context.js";
import { Card, Section } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { Icon } from "../../components/icons.js";
import { SessionRow, toSessionCard } from "../../components/session-row.js";
import { ShowMore } from "../../components/show-more.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import { formatDateTime, type Language } from "../../lib/format.js";
import type { NamedDevice } from "../../lib/format.js";
import { groupSessionsByTopic } from "../../lib/group.js";
import { nextIndex, type ListKey } from "../../lib/list-nav.js";
import { topicHref } from "../../lib/route.js";
import { isTextEntry } from "../../lib/shortcuts.js";
import { useRoute } from "../../router.js";
import { groupSessionsByHour, latestMoment, topicZone, type TodayMode } from "./model.js";

const LIMIT = 5;

export function TodayGroups({
  mode,
  sessions,
  devices,
  language,
  timeZone,
  topics,
  arrived,
}: {
  mode: TodayMode;
  sessions: readonly TodaySession[];
  devices: readonly NamedDevice[];
  language: Language;
  timeZone: string;
  topics: readonly TopicListItem[];
  arrived: ReadonlySet<string>;
}) {
  useSessionArrows();
  const { t } = useDaemon();
  if (mode === "time") {
    const groups = groupSessionsByHour(sessions, timeZone, t("todayUnknownHour"));
    return (
      <div className="today-groups">
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
  return (
    <Section
      title={title}
      hint={<Chip>{sessions.length}</Chip>}
      actions={
        <time className="today-group-time" dateTime={latest ?? undefined} title={absolute}>
          {relative}
        </time>
      }
    >
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
      const index = rows.findIndex((row) => row === active || (active instanceof Node && row.contains(active)));
      event.preventDefault();
      const next = rows[nextIndex(index, rows.length, key)];
      next?.querySelector<HTMLElement>("[data-session-row]")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
