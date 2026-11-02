import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  DeckConfig,
  DeckConversation,
  DeckExecutorView,
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

type Phase = "loading" | "ready" | "error";

interface DeckState {
  conversations: DeckConversation[];
  tasks: DeckTask[];
  executors: DeckExecutorView[];
}

export function CommandDeckPage() {
  const { client, t, detailRevision } = useDaemon();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("loading");
  const [state, setState] = useState<DeckState>({ conversations: [], tasks: [], executors: [] });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<DeckConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [deletingTask, setDeletingTask] = useState<DeckTask | null>(null);
  const [masterConfig, setMasterConfig] = useState<DeckConfig>({});
  const [masterModelDraft, setMasterModelDraft] = useState("");
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const revisionRef = useRef(0);

  const describeError = useCallback(
    (caught: unknown): string => {
      const message = caught instanceof Error ? caught.message : String(caught);
      return t("commandDeckLoadError").replace("{message}", message);
    },
    [t],
  );

  const loadAll = useCallback(async () => {
    try {
      const [conversations, tasks, executors, config] = await Promise.all([
        client.deckConversations(),
        client.deckTasks(),
        client.deckExecutors(),
        client.deckConfig(),
      ]);
      setState({
        conversations: conversations.conversations,
        tasks: tasks.tasks,
        executors: executors.executors,
      });
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

  // daemon 发 deck 变更（对话更新、任务跑完）→ 刷新列表与当前会话。
  useEffect(() => {
    if (detailRevision === revisionRef.current) return;
    revisionRef.current = detailRevision;
    void loadAll();
    if (activeIdRef.current !== null) void loadConversation(activeIdRef.current);
  }, [detailRevision, loadAll, loadConversation]);

  useEffect(() => {
    if (activeId !== null) {
      activeIdRef.current = activeId;
      void loadConversation(activeId);
    } else {
      activeIdRef.current = null;
      setActive(null);
    }
  }, [activeId, loadConversation]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [active?.turns.length, active?.updatedAt]);

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
      setDraft("");
      await loadAll();
    } catch (caught) {
      toast.push({ message: describeError(caught), tone: "danger" });
    } finally {
      setSending(false);
    }
  }, [client, describeError, draft, loadAll, sending, toast]);

  const executorSummary = useMemo(() => {
    if (state.executors.length === 0) return "";
    const available = state.executors.filter((executor) => executor.available).length;
    return `${available}/${state.executors.length}`;
  }, [state.executors]);

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
            <button
              type="button"
              className={`btn${activeId === null ? " primary" : ""}`}
              onClick={() => setActiveId(null)}
            >
              <Icon name="plus" /> {t("commandDeckNew")}
            </button>
          </div>
          <DeckSection title={t("commandDeckMaster")}>
            <Select
              label={t("commandDeckMaster")}
              value={masterConfig.masterProvider ?? ""}
              onChange={(value) => {
                void (async () => {
                  try {
                    const response = await client.writeDeckConfig({ masterProvider: value });
                    setMasterConfig(response.config);
                    toast.push({ message: t("commandDeckMasterSaved"), tone: "success" });
                  } catch (caught) {
                    toast.push({ message: describeError(caught), tone: "danger" });
                  }
                })();
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
            <input
              className="deck-master-model"
              value={masterModelDraft}
              placeholder={t("commandDeckMasterModel")}
              onChange={(event) => setMasterModelDraft(event.target.value)}
              onBlur={() => {
                void (async () => {
                  if (masterModelDraft.trim() === (masterConfig.masterModel ?? "")) return;
                  try {
                    const response = await client.writeDeckConfig({ masterModel: masterModelDraft });
                    setMasterConfig(response.config);
                    setMasterModelDraft(response.config.masterModel ?? "");
                    toast.push({ message: t("commandDeckMasterSaved"), tone: "success" });
                  } catch (caught) {
                    toast.push({ message: describeError(caught), tone: "danger" });
                  }
                })();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </DeckSection>
          <DeckSection title={t("commandDeckThreads")}>
            {state.conversations.length === 0 ? (
              <p className="deck-side-empty">{t("commandDeckThreadsEmpty")}</p>
            ) : (
              <ul className="deck-thread-list">
                {state.conversations.map((conversation) => (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={`deck-thread${conversation.id === activeId ? " is-active" : ""}`}
                      onClick={() => setActiveId(conversation.id)}
                    >
                      <span className="deck-thread-title">{conversation.title}</span>
                      <span className="deck-thread-time">
                        {new Date(conversation.updatedAt).toLocaleString()}
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
                        onClick={() => {
                          void (async () => {
                            try {
                              await client.deckRunTask(task.id);
                              toast.push({ message: t("commandDeckRunning"), tone: "info" });
                              setActiveId(`task-${task.id}`);
                            } catch (caught) {
                              toast.push({ message: describeError(caught), tone: "danger" });
                            }
                          })();
                        }}
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
                >
                  <span className="deck-executor-kind">{executor.kind}</span>
                  <span className="deck-executor-id">{executor.id}</span>
                  <span className="deck-executor-detail">{executor.detail}</span>
                </li>
              ))}
            </ul>
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
              <div className="deck-scroll" ref={scrollRef}>
                {active.turns.map((turn) => (
                  <DeckTurnView key={turn.id} turn={turn} />
                ))}
                {sending ? (
                  <div className="deck-turn deck-turn-assistant">
                    <span className="deck-thinking">
                      <Spinner /> {t("commandDeckThinking")}
                    </span>
                  </div>
                ) : null}
              </div>
              <footer className="deck-composer">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={t("commandDeckInputPlaceholder")}
                  rows={2}
                  disabled={sending}
                />
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void send()}
                  disabled={sending || draft.trim() === ""}
                >
                  {t("commandDeckSend")}
                </button>
              </footer>
            </>
          )}
        </section>
      </div>
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
