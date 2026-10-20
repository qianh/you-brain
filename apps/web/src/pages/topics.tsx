import { useEffect, useState } from "react";
import type { TopicDetail, TopicListItem } from "@you-brain/core/http/types.js";
import type { TopicStatus } from "@you-brain/protocol";

import { useDaemon } from "../daemon-context.js";
import { BrowserDaemonError } from "../api/client.js";
import { Field, StatusText } from "../components/ui.js";
import { Card } from "../components/card.js";
import { EmptyState } from "../components/empty.js";
import { Icon } from "../components/icons.js";
import { Row } from "../components/row.js";
import { Segmented } from "../components/segmented.js";
import { Select } from "../components/select.js";
import { SessionRow, toSessionCard } from "../components/session-row.js";
import { ClampText, ShowMore } from "../components/show-more.js";
import { formatDateTime } from "../lib/format.js";
import { filterTopics } from "../lib/group.js";
import { linesToList } from "../lib/copy.js";
import { topicHref } from "../lib/route.js";
import { todoStatusKey } from "../i18n/messages.js";
import { useRoute } from "../router.js";

const STATUSES: readonly TopicStatus[] = ["active", "follow_up", "done", "parked"];

function statusLabelKey(status: TopicStatus): "statusActive" | "statusFollowUp" | "statusDone" | "statusParked" {
  if (status === "follow_up") return "statusFollowUp";
  if (status === "done") return "statusDone";
  if (status === "parked") return "statusParked";
  return "statusActive";
}

export function TopicsPage({ zone }: { zone: "active" | "history" }) {
  const daemon = useDaemon();
  const { location, navigate } = useRoute();
  const { t, language, topics, devices, timeZone, client, reload, detailRevision } = daemon;
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<TopicDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const inZone = topics.filter((topic) => topic.zone === zone);
  const visible = zone === "history" ? filterTopics(inZone, query) : inZone;
  const selected = location.id;

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    if (topics.length > 0 && !topics.some((topic) => topic.topicId === selected)) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setDetailError(null);
    void client
      .topic(selected)
      .then((next) => {
        if (!controller.signal.aborted) setDetail(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setDetailError(error instanceof BrowserDaemonError ? error.message : t("actionFailed"));
      });
    return () => controller.abort();
  }, [client, selected, detailRevision, t, topics]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("topicsBook")}</h1>
          <p>{zone === "history" ? t("historyHint") : t("activeHint")}</p>
        </div>
        <Segmented
          label={t("topicsBook")}
          value={zone}
          options={[
            { value: "active", label: t("zoneActive") },
            { value: "history", label: t("zoneHistory") },
          ]}
          onChange={(value) => navigate(value === "history" ? "/topics/history" : "/topics")}
        />
      </header>
      {zone === "history" ? (
        <input
          className="control"
          value={query}
          placeholder={t("searchTopics")}
          aria-label={t("searchTopics")}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      {visible.length === 0 ? (
        <EmptyState title={zone === "history" ? t("emptyHistory") : t("emptyTopics")} icon="book" />
      ) : (
        <Card>
          {visible.map((topic) => {
            const open = topic.topicId === selected;
            const sessions = detail && detail.topicId === topic.topicId ? detail.sessions.length : null;
            return (
              <Row
                key={topic.topicId}
                href={topicHref(zone, topic.topicId)}
                current={open}
                onClick={() => navigate(open ? topicHref(zone) : topicHref(zone, topic.topicId))}
                icon={<Icon name="book" />}
                title={topic.name}
                subtitle={
                  <>
                    <StatusText status={topic.status} />
                    <span>{" · "}{formatDateTime(topic.lastActive, language, timeZone)}</span>
                    {sessions !== null ? <span>{" · "}{t("groupLabel", { count: sessions })}</span> : null}
                    {topic.openTodoCount > 0 ? (
                      <span>{" · "}{t("openTodoCount", { count: topic.openTodoCount })}</span>
                    ) : null}
                  </>
                }
                trailing={<Icon name={open ? "chevronUp" : "chevron"} size={16} />}
              >
                {open ? (
                  <>
                    {detailError ? <p className="form-error">{detailError}</p> : null}
                    {detail && detail.topicId === selected ? (
                      <TopicEditor
                        detail={detail}
                        topics={topics}
                        devices={devices}
                        onChanged={async (options) => {
                          if (options) {
                            const nextId = options.id ?? location.id ?? undefined;
                            navigate(topicHref(options.zone ?? zone, nextId));
                          }
                          await reload("topics");
                        }}
                      />
                    ) : detailError ? null : (
                      <p className="muted">{t("loading")}</p>
                    )}
                  </>
                ) : null}
              </Row>
            );
          })}
        </Card>
      )}
      {selected && detail && detail.topicId === selected && !visible.some((topic) => topic.topicId === selected) ? (
        <Card padded>
          <TopicEditor
            detail={detail}
            topics={topics}
            devices={devices}
            onChanged={async (options) => {
              if (options) {
                const nextId = options.id ?? location.id ?? undefined;
                navigate(topicHref(options.zone ?? zone, nextId));
              }
              await reload("topics");
            }}
          />
        </Card>
      ) : null}
      {!selected && visible.length > 0 ? <p className="muted">{t("emptyDetailInline")}</p> : null}
    </div>
  );
}

function TopicEditor({
  detail,
  topics,
  devices,
  onChanged,
}: {
  detail: TopicDetail;
  topics: readonly TopicListItem[];
  devices: readonly { deviceId: string; displayName: string }[];
  onChanged: (options?: { zone?: "active" | "history"; id?: string }) => Promise<void>;
}) {
  const { t, language, timeZone, client } = useDaemon();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(detail.name);
  const [aliases, setAliases] = useState(detail.aliases.join("\n"));
  const [mergeTarget, setMergeTarget] = useState("");
  const [splitKey, setSplitKey] = useState<string | null>(null);
  const [splitMode, setSplitMode] = useState<"create" | "assign">("create");
  const [splitName, setSplitName] = useState("");
  const [splitTopic, setSplitTopic] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [conclusionSession, setConclusionSession] = useState(detail.sessions[0]?.sessionKey ?? "");
  const [historyNote, setHistoryNote] = useState(false);
  const others = topics.filter((topic) => topic.topicId !== detail.topicId);
  const mergeName = others.find((topic) => topic.topicId === mergeTarget)?.name ?? "";

  useEffect(() => {
    setRenameOpen(false);
    setName(detail.name);
    setAliases(detail.aliases.join("\n"));
    setMergeTarget("");
    setSplitKey(null);
    setSplitName("");
    setSplitTopic("");
    setConclusion("");
    setConclusionSession(detail.sessions[0]?.sessionKey ?? "");
    setHistoryNote(false);
    setError(null);
  }, [detail.topicId]);

  async function run(task: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof BrowserDaemonError ? caught.message : t("actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="topic-detail">
      <header className="detail-head">
        <div>
          <h2>{detail.name}</h2>
          <p className="meta-line">
            <StatusText status={detail.status} />
            <span>{" · "}{detail.statusBy === "user" ? t("byUser") : t("byAuto")}</span>
            {detail.userLocked ? <span>{" · "}{t("userLocked")}</span> : null}
            <span>{" · "}{formatDateTime(detail.lastActive, language, timeZone)}</span>
            <span>{" · "}{t("groupLabel", { count: detail.sessions.length })}</span>
          </p>
        </div>
        {detail.zone === "history" ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await client.updateTopic(detail.topicId, { op: "status", status: "active" });
                setHistoryNote(true);
                await onChanged({ zone: "active" });
              })
            }
          >
            {t("reactivate")}
          </button>
        ) : null}
      </header>
      {historyNote && detail.zone === "history" ? <p className="note">{t("historyNote")}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      <section className="section-block">
        <h3>{t("summary")}</h3>
        <ClampText text={detail.summary || t("noSummary")} />
      </section>
      <section className="section-block">
        <h3>{t("nextStep")}</h3>
        <ClampText text={detail.nextStep || t("noNextStep")} />
      </section>

      <section className="action-grid">
        <div>
          <h3>{t("rename")}</h3>
          {renameOpen ? (
            <form
              className="action-form"
              onSubmit={(event) => {
                event.preventDefault();
                const nextName = name.trim();
                if (!nextName) return;
                const nextAliases = linesToList(aliases);
                void run(async () => {
                  await client.updateTopic(detail.topicId, {
                    op: "rename",
                    name: nextName,
                    aliases: nextAliases,
                  });
                  setRenameOpen(false);
                  await onChanged();
                });
              }}
            >
              <div className="action-line">
                <input
                  className="control"
                  aria-label={t("topicName")}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <button type="submit" className="btn primary" disabled={busy || name.trim() === ""}>
                  {t("saveName")}
                </button>
              </div>
              <Field label={t("aliases")} hint={t("aliasesHint")}>
                <textarea rows={3} value={aliases} onChange={(event) => setAliases(event.target.value)} />
              </Field>
              <div className="row-trail">
                <button type="button" className="btn quiet" onClick={() => setRenameOpen(false)}>
                  {t("closeForm")}
                </button>
              </div>
            </form>
          ) : (
            <div className="action-line">
              <span className="action-name">{detail.name}</span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setName(detail.name);
                  setAliases(detail.aliases.join("\n"));
                  setRenameOpen(true);
                }}
              >
                {t("rename")}
              </button>
            </div>
          )}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!mergeTarget) return;
            const target = others.find((topic) => topic.topicId === mergeTarget);
            void run(async () => {
              await client.updateTopic(detail.topicId, { op: "merge", intoTopicId: mergeTarget });
              await onChanged({ id: mergeTarget, zone: target?.zone ?? "active" });
            });
          }}
        >
          <h3>{t("merge")}</h3>
          <div className="action-line">
            <Select label={t("mergeInto")} value={mergeTarget} onChange={setMergeTarget}>
              <option value="">{t("chooseTopic")}</option>
              {others.map((topic) => (
                <option key={topic.topicId} value={topic.topicId}>
                  {topic.name}
                </option>
              ))}
            </Select>
            <button type="submit" className="btn" disabled={busy || mergeTarget === ""}>
              {mergeName ? t("mergeAction", { name: mergeName }) : t("merge")}
            </button>
          </div>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const status = event.currentTarget.elements.namedItem("status");
            const value = status instanceof HTMLSelectElement ? status.value : detail.status;
            if (!isTopicStatus(value)) return;
            void run(async () => {
              await client.updateTopic(detail.topicId, { op: "status", status: value });
              const nextZone = detail.zone === "history" && value === "active" ? "active" : undefined;
              if (nextZone) setHistoryNote(true);
              if (nextZone) await onChanged({ zone: nextZone });
              else await onChanged();
            });
          }}
        >
          <h3>{t("status")}</h3>
          <div className="action-line">
            <Select label={t("status")} name="status" defaultValue={detail.status} key={detail.status}>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(statusLabelKey(status))}
                </option>
              ))}
            </Select>
            <button type="submit" className="btn" disabled={busy}>
              {t("applyStatus")}
            </button>
          </div>
        </form>
      </section>

      <section className="section-block">
        <h3>{t("conclusions")}</h3>
        {detail.conclusions.length === 0 ? <EmptyState title={t("noConclusions")} icon="inbox" /> : null}
        <ShowMore items={detail.conclusions} limit={4}>
          {(item) => (
            <div key={item.conclusionId} className="todo-row">
              <p>{item.text}</p>
              <small>{formatDateTime(item.ts, language, timeZone)}</small>
            </div>
          )}
        </ShowMore>
        {detail.sessions.length === 0 ? (
          <p className="muted">{t("conclusionNeedSession")}</p>
        ) : (
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const text = conclusion.trim();
              if (!text || !conclusionSession) return;
              void run(async () => {
                await client.conclusion({
                  topicId: detail.topicId,
                  text,
                  sessionKey: conclusionSession,
                });
                setConclusion("");
                await onChanged();
              });
            }}
          >
            <h3>{t("addConclusion")}</h3>
            <Select label={t("sessionForConclusion")} value={conclusionSession} onChange={setConclusionSession}>
              {detail.sessions.map((session) => (
                <option key={session.sessionKey} value={session.sessionKey}>
                  {session.title || session.source}
                </option>
              ))}
            </Select>
            <Field label={t("conclusions")}>
              <textarea
                rows={3}
                value={conclusion}
                placeholder={t("conclusionPlaceholder")}
                onChange={(event) => setConclusion(event.target.value)}
              />
            </Field>
            <button type="submit" className="btn primary" disabled={busy || conclusion.trim() === ""}>
              {t("add")}
            </button>
          </form>
        )}
      </section>

      <section className="section-block">
        <h3>{t("todos")}</h3>
        {detail.todos.length === 0 ? <EmptyState title={t("noTodos")} icon="inbox" /> : null}
        <ShowMore items={detail.todos} limit={6}>
          {(todo) => (
            <div key={todo.todoId} className="todo-row">
              <div>
                <p>{todo.text}</p>
                <small>
                  {t(todoStatusKey(todo.status))}
                  {todo.userLocked ? ` · ${t("userLocked")}` : ""}
                </small>
              </div>
              {todo.status === "open" ? (
                <div className="row-trail">
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await client.todo({ todoId: todo.todoId, status: "done" });
                        await onChanged();
                      })
                    }
                  >
                    {t("markDone")}
                  </button>
                  <button
                    type="button"
                    className="btn quiet small"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await client.todo({ todoId: todo.todoId, status: "dropped" });
                        await onChanged();
                      })
                    }
                  >
                    {t("markDropped")}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </ShowMore>
      </section>

      <section className="section-block">
        <h3>{t("relatedSessions")}</h3>
        {detail.sessions.length === 0 ? <EmptyState title={t("noSessions")} icon="inbox" /> : null}
        <ShowMore items={detail.sessions} limit={4}>
          {(session) => (
            <div key={session.sessionKey} className="stack">
              <SessionRow
                session={toSessionCard(session)}
                devices={devices}
                timeZone={timeZone}
                language={language}
              />
              {splitKey === session.sessionKey ? (
                <form
                  className="inline-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      if (splitMode === "create") {
                        const nextName = splitName.trim();
                        if (!nextName) return;
                        await client.updateTopic(detail.topicId, {
                          op: "split",
                          sessionKey: session.sessionKey,
                          target: { action: "create", name: nextName },
                        });
                      } else if (splitTopic) {
                        await client.updateTopic(detail.topicId, {
                          op: "split",
                          sessionKey: session.sessionKey,
                          target: { action: "assign", topicId: splitTopic },
                        });
                      } else {
                        return;
                      }
                      setSplitKey(null);
                      await onChanged();
                    });
                  }}
                >
                  <Segmented
                    label={t("split")}
                    value={splitMode}
                    options={[
                      { value: "create", label: t("newTopic") },
                      { value: "assign", label: t("existingTopic") },
                    ]}
                    onChange={(value) => setSplitMode(value === "assign" ? "assign" : "create")}
                  />
                  {splitMode === "create" ? (
                    <Field label={t("topicName")}>
                      <input value={splitName} onChange={(event) => setSplitName(event.target.value)} />
                    </Field>
                  ) : (
                    <Select label={t("chooseTopic")} value={splitTopic} onChange={setSplitTopic}>
                      <option value="">{t("chooseTopic")}</option>
                      {others.map((topic) => (
                        <option key={topic.topicId} value={topic.topicId}>
                          {topic.name}
                        </option>
                      ))}
                    </Select>
                  )}
                  <div className="row-trail">
                    <button type="submit" className="btn primary" disabled={busy}>
                      {t("move")}
                    </button>
                    <button type="button" className="btn quiet" onClick={() => setSplitKey(null)}>
                      {t("closeForm")}
                    </button>
                  </div>
                </form>
              ) : (
                <button type="button" className="btn quiet" onClick={() => setSplitKey(session.sessionKey)}>
                  {t("split")}
                </button>
              )}
            </div>
          )}
        </ShowMore>
      </section>
    </article>
  );
}

function isTopicStatus(value: string): value is TopicStatus {
  return value === "active" || value === "follow_up" || value === "done" || value === "parked";
}
