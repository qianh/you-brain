import { useEffect, useState } from "react";
import type { TopicDetail, TopicListItem } from "@you-brain/core/http/types.js";
import type { TopicStatus } from "@you-brain/protocol";

import { useDaemon } from "../daemon-context.js";
import { BrowserDaemonError } from "../api/client.js";
import { Empty, SessionCard, StatusText, toSessionCard } from "../components/ui.js";
import { formatDateTime } from "../lib/format.js";
import { filterTopics } from "../lib/group.js";
import { linesToList } from "../lib/copy.js";
import { topicHref } from "../lib/route.js";
import { todoStatusKey } from "../i18n/messages.js";
import { useRoute } from "../router.js";

const STATUSES: readonly TopicStatus[] = ["active", "follow_up", "done", "parked"];

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
          <h1>{zone === "history" ? t("navTopicsHistory") : t("navTopicsActive")}</h1>
          <p>{zone === "history" ? t("historyHint") : t("activeHint")}</p>
        </div>
      </header>
      <div className="split">
        <section className="list-pane">
          {zone === "history" ? (
            <input
              className="search-input"
              value={query}
              placeholder={t("searchTopics")}
              aria-label={t("searchTopics")}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          {visible.length === 0 ? (
            <Empty>{zone === "history" ? t("emptyHistory") : t("emptyTopics")}</Empty>
          ) : null}
          <ul className="topic-list">
            {visible.map((topic) => (
              <li key={topic.topicId}>
                <a
                  href={topicHref(zone, topic.topicId)}
                  aria-current={topic.topicId === selected ? "true" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(topicHref(zone, topic.topicId));
                  }}
                >
                  <span className="topic-name">{topic.name}</span>
                  <StatusText status={topic.status} />
                  <small>
                    {formatDateTime(topic.lastActive, language, timeZone)}
                    {topic.openTodoCount > 0
                      ? ` · ${t("openTodoCount", { count: topic.openTodoCount })}`
                      : ""}
                  </small>
                </a>
              </li>
            ))}
          </ul>
        </section>
        <section className="detail-pane">
          {!selected ? <Empty>{t("emptyDetail")}</Empty> : null}
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
          ) : null}
        </section>
      </div>
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
          <p className="session-meta">
            <StatusText status={detail.status} />
            <span>{detail.statusBy === "user" ? t("byUser") : t("byAuto")}</span>
            {detail.userLocked ? <span>{t("userLocked")}</span> : null}
            <span>{formatDateTime(detail.lastActive, language, timeZone)}</span>
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

      <section>
        <h3>{t("summary")}</h3>
        <p>{detail.summary || t("noSummary")}</p>
      </section>
      <section>
        <h3>{t("nextStep")}</h3>
        <p>{detail.nextStep || t("noNextStep")}</p>
      </section>

      <section className="action-grid">
        <div>
          <h3>{t("rename")}</h3>
          {renameOpen ? (
            <form
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
              <label className="field">
                <span>{t("topicName")}</span>
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="field">
                <span>{t("aliases")}</span>
                <textarea
                  rows={3}
                  value={aliases}
                  onChange={(event) => setAliases(event.target.value)}
                />
                <small>{t("aliasesHint")}</small>
              </label>
              <div className="row-actions">
                <button type="submit" className="btn primary" disabled={busy || name.trim() === ""}>
                  {t("saveName")}
                </button>
                <button type="button" className="btn quiet" onClick={() => setRenameOpen(false)}>
                  {t("closeForm")}
                </button>
              </div>
            </form>
          ) : (
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
          <label className="field">
            <span>{t("mergeInto")}</span>
            <select
              value={mergeTarget}
              onChange={(event) => setMergeTarget(event.target.value)}
            >
              <option value="">{t("chooseTopic")}</option>
              {others.map((topic) => (
                <option key={topic.topicId} value={topic.topicId}>
                  {topic.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn" disabled={busy || mergeTarget === ""}>
            {mergeName ? t("mergeAction", { name: mergeName }) : t("merge")}
          </button>
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
          <label className="field">
            <span>{t("status")}</span>
            <select name="status" defaultValue={detail.status} key={detail.status}>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(status === "active" ? "statusActive" : status === "follow_up" ? "statusFollowUp" : status === "done" ? "statusDone" : "statusParked")}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn" disabled={busy}>
            {t("applyStatus")}
          </button>
        </form>
      </section>

      <section>
        <h3>{t("conclusions")}</h3>
        {detail.conclusions.length === 0 ? <Empty>{t("noConclusions")}</Empty> : null}
        <ul className="plain-list">
          {detail.conclusions.map((item) => (
            <li key={item.conclusionId}>
              <p>{item.text}</p>
              <small>{formatDateTime(item.ts, language, timeZone)}</small>
            </li>
          ))}
        </ul>
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
            <label className="field">
              <span>{t("sessionForConclusion")}</span>
              <select
                value={conclusionSession}
                onChange={(event) => setConclusionSession(event.target.value)}
              >
                {detail.sessions.map((session) => (
                  <option key={session.sessionKey} value={session.sessionKey}>
                    {session.title || session.source}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("conclusions")}</span>
              <textarea
                rows={3}
                value={conclusion}
                placeholder={t("conclusionPlaceholder")}
                onChange={(event) => setConclusion(event.target.value)}
              />
            </label>
            <button type="submit" className="btn primary" disabled={busy || conclusion.trim() === ""}>
              {t("add")}
            </button>
          </form>
        )}
      </section>

      <section>
        <h3>{t("todos")}</h3>
        {detail.todos.length === 0 ? <Empty>{t("noTodos")}</Empty> : null}
        <ul className="plain-list">
          {detail.todos.map((todo) => (
            <li key={todo.todoId} className="todo-row">
              <div>
                <p>{todo.text}</p>
                <small>
                  {t(todoStatusKey(todo.status))}
                  {todo.userLocked ? ` · ${t("userLocked")}` : ""}
                </small>
              </div>
              {todo.status === "open" ? (
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn"
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
                    className="btn quiet"
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
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>{t("relatedSessions")}</h3>
        {detail.sessions.length === 0 ? <Empty>{t("noSessions")}</Empty> : null}
        {detail.sessions.map((session) => (
          <div key={session.sessionKey} className="session-with-action">
            <SessionCard
              session={toSessionCard(session)}
              devices={devices}
              timeZone={timeZone}
              language={language}
              compact
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
                <div className="segmented">
                  <button
                    type="button"
                    className={splitMode === "create" ? "on" : ""}
                    onClick={() => setSplitMode("create")}
                  >
                    {t("newTopic")}
                  </button>
                  <button
                    type="button"
                    className={splitMode === "assign" ? "on" : ""}
                    onClick={() => setSplitMode("assign")}
                  >
                    {t("existingTopic")}
                  </button>
                </div>
                {splitMode === "create" ? (
                  <label className="field">
                    <span>{t("topicName")}</span>
                    <input value={splitName} onChange={(event) => setSplitName(event.target.value)} />
                  </label>
                ) : (
                  <label className="field">
                    <span>{t("chooseTopic")}</span>
                    <select value={splitTopic} onChange={(event) => setSplitTopic(event.target.value)}>
                      <option value="">{t("chooseTopic")}</option>
                      {others.map((topic) => (
                        <option key={topic.topicId} value={topic.topicId}>
                          {topic.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="row-actions">
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
        ))}
      </section>
    </article>
  );
}

function isTopicStatus(value: string): value is TopicStatus {
  return value === "active" || value === "follow_up" || value === "done" || value === "parked";
}
