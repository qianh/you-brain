import { useEffect, useRef, useState } from "react";
import type { TodoStatus, TopicStatus } from "@you-brain/protocol";
import type { TopicDetail, TopicListItem, TopicSessionLink } from "@you-brain/core/http/types.js";

import { Banner } from "../../components/banner.js";
import { IconButton } from "../../components/button.js";
import { Section } from "../../components/card.js";
import { Icon } from "../../components/icons.js";
import { Input } from "../../components/input.js";
import { Menu } from "../../components/menu.js";
import { Select } from "../../components/select.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import { useDaemon } from "../../daemon-context.js";
import { formatDateTime } from "../../lib/format.js";
import { isRecentActivity, joinMeta, statusLabelKey } from "./logic.js";
import { AliasList } from "./alias-list.js";
import { ConclusionList } from "./conclusion-list.js";
import { SessionList } from "./session-list.js";
import { StatusDot } from "./status-dot.js";
import { SummaryText } from "./summary-text.js";
import { TodoList } from "./todo-list.js";
import { MergeDialog, SplitDialog } from "./topic-dialogs.js";
import type { SplitTarget } from "./use-topic-actions.js";

const STATUSES = ["active", "follow_up", "done", "parked"] as const;

function isStatus(value: string): value is TopicStatus {
  return (STATUSES as readonly string[]).includes(value);
}

export function TopicDetailPane({
  detail,
  topics,
  busy,
  historyNote,
  onRename,
  onStatus,
  onAliases,
  onTodo,
  onConclusion,
  onMerge,
  onSplit,
  onCopy,
}: {
  detail: TopicDetail;
  topics: readonly TopicListItem[];
  busy: boolean;
  historyNote: boolean;
  onRename: (name: string) => Promise<boolean>;
  onStatus: (status: TopicStatus) => Promise<boolean>;
  onAliases: (aliases: string[], change: { type: "add" | "remove"; name: string }) => Promise<boolean>;
  onTodo: (todoId: string, text: string, from: TodoStatus, to: TodoStatus) => void;
  onConclusion: (text: string, sessionKey: string) => Promise<boolean>;
  onMerge: (intoTopicId: string) => Promise<boolean>;
  onSplit: (sessionKey: string, sessionTitle: string, target: SplitTarget) => Promise<boolean>;
  onCopy: () => void;
}) {
  const { t, language, timeZone } = useDaemon();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(detail.name);
  const editingRef = useRef(false);
  const skipEdit = useRef(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [split, setSplit] = useState<{ session: TopicSessionLink; mode: "create" | "assign" } | null>(null);
  const others = topics.filter((topic) => topic.topicId !== detail.topicId);
  const relative = useRelativeTime(detail.lastActive, language, timeZone);
  const absolute = formatDateTime(detail.lastActive, language, timeZone);

  useEffect(() => {
    editingRef.current = false;
    skipEdit.current = false;
    setEditing(false);
    setDraft(detail.name);
    setMergeOpen(false);
    setSplit(null);
  }, [detail.topicId]);

  useEffect(() => {
    if (!editingRef.current) setDraft(detail.name);
  }, [detail.name]);

  const startEdit = (): void => {
    if (busy) return;
    editingRef.current = true;
    setDraft(detail.name);
    setEditing(true);
  };

  const commitEdit = (): void => {
    if (skipEdit.current) {
      skipEdit.current = false;
      return;
    }
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    const next = draft.trim();
    if (next === "" || next === detail.name) return;
    void onRename(next);
  };

  return (
    <>
      <header className="topics-head">
        <div className="topics-head-row">
          {editing ? (
            <Input
              className="topics-rename"
              label={t("renameTopic")}
              value={draft}
              autoFocus
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitEdit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitEdit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  skipEdit.current = true;
                  editingRef.current = false;
                  setDraft(detail.name);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <h2 className="topics-name" title={detail.name} onDoubleClick={startEdit}>
              {detail.name}
            </h2>
          )}
          {editing ? null : (
            <IconButton label={t("renameTopic")} disabled={busy} onClick={startEdit}>
              <Icon name="pencil" />
            </IconButton>
          )}
          <div className="topics-status">
            <Select
              label={t("statusPage")}
              value={detail.status}
              disabled={busy}
              onChange={(value) => {
                if (isStatus(value)) void onStatus(value);
              }}
              options={STATUSES.map((status) => ({
                value: status,
                label: t(statusLabelKey(status)),
                icon: <StatusDot status={status} />,
              }))}
            />
          </div>
          <Menu
            label={t("moreActions")}
            trigger={
              <IconButton label={t("moreActions")}>
                <Icon name="more" />
              </IconButton>
            }
            items={[
              {
                id: "merge",
                label: t("mergeIntoOther"),
                disabled: others.length === 0 || busy,
                onSelect: () => setMergeOpen(true),
              },
              { id: "copy", label: t("copyTopicLink"), onSelect: onCopy },
            ]}
          />
        </div>
        <p className="topics-meta" title={absolute}>
          {joinMeta([
            detail.userLocked ? t("userLocked") : null,
            t("groupLabel", { count: detail.sessions.length }),
            isRecentActivity(relative) ? t("recentLine", { time: relative }) : relative === "—" ? null : relative,
          ])}
        </p>
      </header>
      {historyNote ? <Banner tone="info">{t("historyNote")}</Banner> : null}
      <Section title={t("summary")}>
        <SummaryText text={detail.summary} />
      </Section>
      {detail.nextStep.trim() !== "" ? (
        <Section title={t("nextStep")}>
          <div className="topics-next">
            <Icon name="chevron-right" />
            <p>{detail.nextStep}</p>
          </div>
        </Section>
      ) : null}
      <TodoList todos={detail.todos} busy={busy} onSet={onTodo} />
      <ConclusionList
        topicId={detail.topicId}
        conclusions={detail.conclusions}
        sessions={detail.sessions}
        busy={busy}
        onAdd={onConclusion}
      />
      <SessionList
        sessions={detail.sessions}
        others={others.length}
        onSplit={(session, mode) => setSplit({ session, mode })}
      />
      <AliasList topicId={detail.topicId} aliases={detail.aliases} busy={busy} onChange={onAliases} />
      <MergeDialog
        open={mergeOpen}
        sourceName={detail.name}
        sessionCount={detail.sessions.length}
        others={others}
        busy={busy}
        onClose={() => setMergeOpen(false)}
        onConfirm={onMerge}
      />
      <SplitDialog
        open={split !== null}
        sourceName={detail.name}
        session={split?.session ?? null}
        mode={split?.mode ?? "create"}
        others={others}
        busy={busy}
        onClose={() => setSplit(null)}
        onConfirm={(target) => {
          if (!split) return Promise.resolve(false);
          const title = split.session.title.trim() || t("conversation");
          return onSplit(split.session.sessionKey, title, target);
        }}
      />
    </>
  );
}
