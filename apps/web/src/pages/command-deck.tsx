import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CompositionEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

import type {
  DeckConfig,
  DeckConversation,
  DeckExecutorView,
  DeckJobView,
  DeckTask,
  DeckTurn,
} from "@you-brain/core/deck/index.js";

import { Icon } from "../components/icons.js";
import { ConfirmDialog } from "../components/dialog.js";
import { EmptyState } from "../components/empty.js";
import { Page, PageHeader } from "../components/page.js";
import { Spinner } from "../components/spinner.js";
import { useToast } from "../components/toast.js";
import { Select } from "../components/select.js";
import { MarkdownView } from "../components/ui.js";
import { useDaemon } from "../daemon-context.js";
import { subscribeDeckDelta } from "../lib/deck-stream.js";
import { useImeGuard } from "../lib/ime-guard.js";

type Phase = "loading" | "ready" | "error";

interface DeckState {
  conversations: DeckConversation[];
  jobs: DeckJobView[];
  tasks: DeckTask[];
  executors: DeckExecutorView[];
}

/** 等主控产出的那条消息：只在它自己的会话里显示思考态。 */
interface Awaiting {
  conversationId: string;
  since: number;
  /** 发出时会话的轮数；服务端轮数超过它即说明主控产出已落地。 */
  knownTurns: number;
}

/** 主控回答的流式增量（谁的就显示在谁的会话里）。 */
interface StreamState {
  conversationId: string;
  text: string;
}

export function CommandDeckPage() {
  const { client, t, detailRevision } = useDaemon();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("loading");
  const [state, setState] = useState<DeckState>({
    conversations: [],
    jobs: [],
    tasks: [],
    executors: [],
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<DeckConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [awaiting, setAwaiting] = useState<Awaiting | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [deletingTask, setDeletingTask] = useState<DeckTask | null>(null);
  const [deletingConversation, setDeletingConversation] = useState<DeckConversation | null>(null);
  const [masterConfig, setMasterConfig] = useState<DeckConfig>({});
  const [masterModelDraft, setMasterModelDraft] = useState("");
  const [error, setError] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  /** 只有用户本来就贴在底部时才自动跟随；往上翻了就不拽。 */
  const stickToBottomRef = useRef(true);
  const composerIme = useImeGuard();
  const modelIme = useImeGuard();

  const describeError = useCallback(
    (caught: unknown): string => {
      const message = caught instanceof Error ? caught.message : String(caught);
      return t("commandDeckLoadError").replace("{message}", message);
    },
    [t],
  );

  const loadAll = useCallback(async () => {
    // 执行者目录要探测本机 CLI/应用,最慢;不挡首屏,到了再补进执行面板。
    void client
      .deckExecutors()
      .then((executors) => setState((current) => ({ ...current, executors: executors.executors })))
      .catch(() => undefined);
    try {
      const [conversations, tasks, jobs, config] = await Promise.all([
        client.deckConversations(),
        client.deckTasks(),
        client.deckJobs(),
        client.deckConfig(),
      ]);
      setState((current) => ({
        conversations: conversations.conversations,
        tasks: tasks.tasks,
        executors: current.executors,
        jobs: jobs.jobs,
      }));
      setMasterConfig(config.config);
      setMasterModelDraft(config.config.masterModel ?? "");
      setPhase("ready");
      setError("");
    } catch (caught) {
      setPhase("error");
      setError(describeError(caught));
    }
  }, [client, describeError]);

  const loadConversation = useCallback(
    async (id: string) => {
      try {
        const response = await client.deckConversation(id);
        setActive(response.conversation);
        // 主控产出（assistant/event 轮）已落地 → 撤掉这会话的思考态与流式缓冲。
        const conversation = response.conversation;
        setAwaiting((current) => {
          if (
            current !== null &&
            current.conversationId === id &&
            conversation !== null &&
            conversation.turns.length > current.knownTurns
          ) {
            return null;
          }
          return current;
        });
        setStream((current) => {
          if (
            current !== null &&
            current.conversationId === id &&
            conversation !== null &&
            conversation.turns.length > 0
          ) {
            const roles = conversation.turns.map((turn) => turn.role);
            const lastRole = roles[roles.length - 1];
            if (lastRole === "assistant" || lastRole === "event") return null;
          }
          return current;
        });
      } catch (caught) {
        setError(describeError(caught));
      }
    },
    [client, describeError],
  );

  useEffect(() => {
    void (async () => {
      await loadAll();
      try {
        const conversations = await client.deckConversations();
        const first = conversations.conversations[0];
        if (first !== undefined && activeIdRef.current === null) {
          activeIdRef.current = first.id;
          setActiveId(first.id);
        }
      } catch {
        // loadAll 已经报过错。
      }
    })();
    // 只在挂载时拉一次；后续靠 SSE 的 deck 变更。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // daemon 发 deck 变更（用户轮落盘、主控产出、任务跑完）→ 刷新列表、执行面板与当前会话。
  useEffect(() => {
    if (detailRevision === revisionRef.current) return;
    revisionRef.current = detailRevision;
    void loadAll();
    if (activeIdRef.current !== null) void loadConversation(activeIdRef.current);
  }, [detailRevision, loadAll, loadConversation]);

  useEffect(() => {
    if (activeId !== null) {
      activeIdRef.current = activeId;
      stickToBottomRef.current = true;
      void loadConversation(activeId);
    } else {
      activeIdRef.current = null;
      setActive(null);
    }
  }, [activeId, loadConversation]);

  const busy = awaiting !== null || state.jobs.some((job) => job.status === "running");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // 主控回答逐字上屏（SSE delta）。250ms 一条，只有流式主控（grok/claude/opencode）会发。
  useEffect(() => subscribeDeckDelta((conversationId, text) => setStream({ conversationId, text })), []);

  const showThinking =
    awaiting !== null && active !== null && active.id === awaiting.conversationId;
  const streaming =
    stream !== null &&
    active !== null &&
    stream.conversationId === active.id &&
    stream.text.trim() !== "";

  const resizeComposer = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [draft, resizeComposer]);

  const followScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node && stickToBottomRef.current) node.scrollTop = node.scrollHeight;
  }, []);

  useEffect(() => {
    followScroll();
  }, [active?.turns.length, active?.updatedAt, showThinking, streaming, stream?.text, followScroll]);

  // 发送即返回：用户轮已落盘并上屏，主控在后台跑，产出经 SSE 推送。
  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    try {
      const response = await client.deckSend({
        text,
        ...(activeIdRef.current !== null ? { conversationId: activeIdRef.current } : {}),
      });
      const conversation = response.conversation;
      setActive(conversation);
      setActiveId(conversation.id);
      activeIdRef.current = conversation.id;
      setAwaiting({ conversationId: conversation.id, since: Date.now(), knownTurns: conversation.turns.length });
      setStream(null);
      setDraft("");
      stickToBottomRef.current = true;
      await loadAll();
      inputRef.current?.focus();
    } catch (caught) {
      toast.push({ message: describeError(caught), tone: "danger" });
    } finally {
      setSending(false);
    }
  }, [client, describeError, draft, loadAll, sending, toast]);

  const saveMaster = useCallback(
    async (patch: { masterProvider?: string; masterModel?: string }) => {
      try {
        const response = await client.writeDeckConfig(patch);
        setMasterConfig(response.config);
        setMasterModelDraft(response.config.masterModel ?? "");
      } catch (caught) {
        toast.push({ message: describeError(caught), tone: "danger" });
      }
    },
    [client, describeError, toast],
  );

  const startNew = useCallback(() => {
    setActiveId(null);
    setDraft("");
    inputRef.current?.focus();
  }, []);

  const runTask = useCallback(
    (task: DeckTask) => {
      void (async () => {
        try {
          await client.deckRunTask(task.id);
          toast.push({ message: t("commandDeckRunning"), tone: "info" });
          setActiveId(`task-${task.id}`);
        } catch (caught) {
          toast.push({ message: describeError(caught), tone: "danger" });
        }
      })();
    },
    [client, describeError, t, toast],
  );

  const executorSummary = useMemo(() => {
    if (state.executors.length === 0) return "";
    const available = state.executors.filter((executor) => executor.available).length;
    return `${available}/${state.executors.length}`;
  }, [state.executors]);

  const jobs = useMemo(() => {
    const rank = (job: DeckJobView): number => (job.status === "running" ? 0 : job.status === "error" ? 1 : 2);
    return [...state.jobs].sort((a, b) => rank(a) - rank(b) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }, [state.jobs]);

  if (phase === "loading") {
    return (
      <Page>
        <div className="deck-loading">
          <Spinner label={t("commandDeckTitle")} />
        </div>
      </Page>
    );
  }
  if (phase === "error") {
    return (
      <Page>
        <PageHeader title={t("commandDeckTitle")} />
        <EmptyState icon="alert" title={error} />
      </Page>
    );
  }

  return (
    <Page>
      <div className="deck">
        <aside className="deck-side">
          <div className="deck-side-head">
            <button type="button" className="btn" onClick={startNew}>
              <Icon name="plus" /> {t("commandDeckNew")}
            </button>
          </div>
          <DeckSection title={t("commandDeckThreads")}>
            {state.conversations.length === 0 ? (
              <p className="deck-side-empty">{t("commandDeckThreadsEmpty")}</p>
            ) : (
              <ul className="deck-thread-list">
                {state.conversations.map((conversation) => (
                  <li key={conversation.id}>
                    <div
                      className={`deck-thread${conversation.id === activeId ? " is-active" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setActiveId(conversation.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setActiveId(conversation.id);
                        }
                      }}
                    >
                      <span className="deck-thread-title">{conversation.title}</span>
                      <span className="deck-thread-time">
                        {new Date(conversation.updatedAt).toLocaleString()}
                      </span>
                      <button
                        type="button"
                        className="deck-thread-delete"
                        title={t("commandDeckThreadDelete")}
                        aria-label={t("commandDeckThreadDelete")}
                        onClick={(event) => {
                          event.stopPropagation();
                          setDeletingConversation(conversation);
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DeckSection>
        </aside>
        <section className="deck-main">
          {active === null ? (
            <div className="deck-intro">
              <EmptyState icon="command" title={t("commandDeckTitle")} description={t("commandDeckSubtitle")} />
            </div>
          ) : (
            <>
              <header className="deck-main-head">
                <h2>{active.title}</h2>
                {active.taskId !== undefined ? <span className="pill">{t("commandDeckTasks")}</span> : null}
              </header>
              <div
                className="deck-scroll"
                ref={scrollRef}
                onScroll={() => {
                  const node = scrollRef.current;
                  if (!node) return;
                  stickToBottomRef.current =
                    node.scrollHeight - node.scrollTop - node.clientHeight < 80;
                }}
              >
                {active.turns.map((turn) => (
                  <DeckTurnView key={turn.id} turn={turn} />
                ))}
                {streaming && stream !== null ? (
                  <div className="deck-turn deck-turn-assistant deck-turn-streaming">
                    <MarkdownView source={stream.text} />
                  </div>
                ) : null}
                {showThinking && !streaming ? (
                  <div className="deck-turn deck-turn-assistant">
                    <span className="deck-thinking">
                      <Spinner /> {t("commandDeckThinking")}
                      <span className="deck-thinking-elapsed">
                        {Math.max(0, Math.round((nowMs - awaiting.since) / 1000))}s
                      </span>
                    </span>
                  </div>
                ) : null}
              </div>
            </>
          )}
          <footer className="deck-composer">
            <div className="deck-composer-box">
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onCompositionStart={composerIme.onCompositionStart}
                onCompositionEnd={composerIme.onCompositionEnd}
                onKeyDown={(event) => {
                  if (composerIme.isComposing(event)) return;
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={t("commandDeckInputPlaceholder")}
                rows={2}
              />
              <div className="deck-composer-bar">
                <input
                  className="deck-master-model"
                  value={masterModelDraft}
                  placeholder={t("commandDeckMasterModel")}
                  title={t("commandDeckMasterModel")}
                  aria-label={t("commandDeckMasterModel")}
                  onChange={(event) => setMasterModelDraft(event.target.value)}
                  onBlur={() => {
                    if (masterModelDraft.trim() === (masterConfig.masterModel ?? "")) return;
                    void saveMaster({ masterModel: masterModelDraft });
                  }}
                  onCompositionStart={modelIme.onCompositionStart}
                  onCompositionEnd={modelIme.onCompositionEnd}
                  onKeyDown={(event) => {
                    if (modelIme.isComposing(event)) return;
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <Select
                  label={t("commandDeckMaster")}
                  value={masterConfig.masterProvider ?? ""}
                  onChange={(value) => {
                    void saveMaster({ masterProvider: value });
                  }}
                  options={[
                    { value: "", label: t("commandDeckMasterAuto") },
                    ...state.executors
                      .filter((executor) => executor.kind === "cli-agent")
                      .map((executor) => ({
                        value: executor.id,
                        label: `${executor.id}${executor.available ? "" : "（未就绪）"}`,
                      })),
                  ]}
                />
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void send()}
                  disabled={sending || draft.trim() === ""}
                >
                  {t("commandDeckSend")}
                </button>
              </div>
            </div>
          </footer>
        </section>
        <aside className="deck-rail">
          <DeckSection title={`${t("commandDeckJobs")}（${jobs.filter((job) => job.status === "running").length}）`}>
            {jobs.length === 0 ? (
              <p className="deck-side-empty">{t("commandDeckJobsEmpty")}</p>
            ) : (
              <ul className="deck-job-list">
                {jobs.slice(0, 10).map((job) => (
                  <li key={job.id}>
                    <button
                      type="button"
                      className={`deck-job deck-job-${job.status}`}
                      onClick={() => setActiveId(job.conversationId)}
                      title={
                        job.status === "error" && job.error !== undefined
                          ? `${job.title}：${job.error}`
                          : `${job.title} · ${job.executor.kind}:${job.executor.id}`
                      }
                    >
                      <span className="deck-job-icon">
                        {job.status === "running" ? (
                          <Spinner />
                        ) : (
                          <Icon name={job.status === "error" ? "alert" : "check"} />
                        )}
                      </span>
                      <span className="deck-job-body">
                        <span className="deck-job-title">{job.title}</span>
                        <span className="deck-job-meta">
                          {job.executor.id}
                          {job.status === "running"
                            ? ` · ${Math.max(0, Math.round((nowMs - Date.parse(job.startedAt)) / 1000))}s`
                            : job.status === "error"
                              ? ` · ${t("commandDeckFailed")}`
                              : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </DeckSection>
          <DeckSection title={`${t("commandDeckTasks")}（${state.tasks.length}）`}>
            {state.tasks.length === 0 ? (
              <p className="deck-side-empty">{t("commandDeckTasksEmpty")}</p>
            ) : (
              <ul className="deck-task-list">
                {state.tasks.map((task) => (
                  <li key={task.id} className="deck-task">
                    <div className="deck-task-main">
                      <span className="deck-task-title">{task.title}</span>
                      <span
                        className={`deck-task-status${task.lastStatus === "error" ? " is-error" : ""}`}
                      >
                        {task.lastStatus === "error"
                          ? t("commandDeckFailed")
                          : task.lastRunAt === null
                            ? t("commandDeckNeverRun")
                            : `${t("commandDeckLastRun")} ${task.lastRunAt.slice(5, 16).replace("T", " ")}`}
                      </span>
                    </div>
                    <div className="deck-task-actions">
                      <button
                        type="button"
                        className="btn small"
                        title={t("commandDeckTaskRun")}
                        onClick={() => runTask(task)}
                      >
                        <Icon name="corner-down-left" />
                      </button>
                      <button
                        type="button"
                        className="btn small danger"
                        title={t("commandDeckTaskDelete")}
                        onClick={() => setDeletingTask(task)}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DeckSection>
          <DeckSection
            title={`${t("commandDeckExecutors")}${executorSummary === "" ? "" : ` ${executorSummary}`}`}
          >
            <ul className="deck-executor-list">
              {state.executors.map((executor) => (
                <li
                  key={`${executor.kind}:${executor.id}`}
                  className={executor.available ? "" : "is-off"}
                  // 说明文字(路径、input 约定等)不占版面,悬停才看。
                  title={executor.detail}
                >
                  <span className="deck-executor-kind">{executor.kind}</span>
                  <span className="deck-executor-id">{executor.id}</span>
                  {executor.available ? null : <span className="deck-executor-detail">未就绪</span>}
                </li>
              ))}
            </ul>
          </DeckSection>
        </aside>
      </div>
      <ConfirmDialog
        open={deletingConversation !== null}
        title={t("commandDeckThreadDelete")}
        description={
          deletingConversation === null
            ? ""
            : t("commandDeckThreadDeleteConfirm").replace("{title}", deletingConversation.title)
        }
        tone="danger"
        confirmLabel={t("commandDeckThreadDelete")}
        cancelLabel={t("cancel")}
        onConfirm={() => {
          void (async () => {
            const conversation = deletingConversation;
            if (conversation === null) return;
            try {
              await client.deckDeleteConversation(conversation.id);
              setDeletingConversation(null);
              if (activeIdRef.current === conversation.id) {
                setActiveId(null);
                setActive(null);
                setAwaiting(null);
                setStream(null);
              }
              await loadAll();
            } catch (caught) {
              toast.push({ message: describeError(caught), tone: "danger" });
            }
          })();
        }}
        onClose={() => setDeletingConversation(null)}
      />
      <ConfirmDialog
        open={deletingTask !== null}
        title={t("commandDeckTaskDelete")}
        description={
          deletingTask === null
            ? ""
            : t("commandDeckTaskDeleteConfirm").replace("{title}", deletingTask.title)
        }
        tone="danger"
        confirmLabel={t("commandDeckTaskDelete")}
        cancelLabel={t("cancel")}
        onConfirm={() => {
          void (async () => {
            const task = deletingTask;
            if (task === null) return;
            try {
              await client.deckDeleteTask(task.id);
              setDeletingTask(null);
              await loadAll();
            } catch (caught) {
              toast.push({ message: describeError(caught), tone: "danger" });
            }
          })();
        }}
        onClose={() => setDeletingTask(null)}
      />
    </Page>
  );
}

function DeckSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="deck-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function DeckTurnView({ turn }: { turn: DeckTurn }) {
  if (turn.role === "event") {
    return (
      <div className="deck-turn deck-turn-event">
        <Icon name="info" /> <span>{turn.text}</span>
      </div>
    );
  }
  return (
    <div className={`deck-turn deck-turn-${turn.role}`}>
      <MarkdownView source={turn.text} />
    </div>
  );
}
