import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { DevelopmentTask, TaskActionInput, TaskBoard, TaskCreateInput, TaskPriority, TaskProject, TaskReview } from "@you-brain/core/tasks/types.js";

import { Banner } from "../components/banner.js";
import { Button } from "../components/button.js";
import { ConfirmDialog, Dialog } from "../components/dialog.js";
import { EmptyState } from "../components/empty.js";
import { Icon } from "../components/icons.js";
import { Input, Textarea } from "../components/input.js";
import { Page, PageHeader } from "../components/page.js";
import { Segmented } from "../components/segmented.js";
import { Select } from "../components/select.js";
import { Skeleton } from "../components/skeleton.js";
import { Spinner } from "../components/spinner.js";
import { useToast } from "../components/toast.js";
import { useDaemon } from "../daemon-context.js";
import { usePageActive } from "../page-active.js";
import { formatRelative } from "../lib/format.js";
import { projectTask, TASK_PRIORITY_KEYS, TASK_STATUS_KEYS, taskThreadUrl, visibleTasks } from "./tasks/logic.js";

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function ThreadLink({ task }: { task: DevelopmentTask }) {
  const { t } = useDaemon();
  const href = taskThreadUrl(task.run?.threadUrl);
  return href ? <a className="tasks-thread-link" href={href} target="_blank" rel="noopener noreferrer">
    {t("tasksOpenT3")} <Icon name="external-link" size={12} />
  </a> : null;
}

export function TasksPage() {
  const { client, t, language, timeZone } = useDaemon();
  const pageActive = usePageActive();
  const { push } = useToast();
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [project, setProject] = useState("all");
  const [status, setStatus] = useState("all");
  const [tab, setTab] = useState<"tasks" | "projects">("tasks");
  const [editor, setEditor] = useState<{ task: DevelopmentTask | null } | null>(null);
  const [reviewing, setReviewing] = useState<DevelopmentTask | null>(null);
  const [starting, setStarting] = useState<TaskProject | null>(null);
  const version = useRef(0);
  const mounted = useRef(false);
  const polling = useRef(false);
  const mutating = useRef(false);

  const acceptBoard = useCallback((next: TaskBoard): void => {
    version.current += 1;
    setBoard(next);
    setError(null);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (polling.current || mutating.current) return;
    polling.current = true;
    const current = ++version.current;
    try {
      const next = await client.taskBoard();
      if (mounted.current && version.current === current) {
        setBoard(next);
        setError(null);
      }
    } catch (error) {
      if (mounted.current && version.current === current) setError(errorMessage(error));
    } finally {
      polling.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current += 1;
    };
  }, []);

  // 页面切走（常驻但隐藏）时不轮询；切回或首次进入时立即拉一次。
  useEffect(() => {
    if (!pageActive) return;
    void load();
    const visible = (): void => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(visible, 5_000);
    window.addEventListener("you-brain-refresh", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("you-brain-refresh", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load, pageActive]);

  const mutate = async (work: () => Promise<TaskBoard>, success?: string): Promise<boolean> => {
    if (mutating.current) return false;
    mutating.current = true;
    version.current += 1;
    setBusy(true);
    try {
      const next = await work();
      if (mounted.current) {
        acceptBoard(next);
        if (success) push({ message: success, tone: "success" });
      }
      return true;
    } catch (error) {
      if (mounted.current) push({ message: errorMessage(error), tone: "danger" });
      return false;
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const act = (input: TaskActionInput): Promise<boolean> => mutate(() => client.taskAction(input));
  const tasks = board?.tasks ?? [];
  const projects = board?.projects ?? [];
  const filtered = visibleTasks(tasks, project, status);
  const counts = {
    queued: tasks.filter((task) => task.status === "queued").length,
    active: tasks.filter((task) => ["preparing", "running", "merging"].includes(task.status)).length,
    review: tasks.filter((task) => task.status === "review").length,
    done: tasks.filter((task) => task.status === "done").length,
  };
  // 还没拿到数据时数字显示「—」：0 会被读成「没有任务」。
  const pendingBoard = board === null;
  const shown = (value: number): string => (pendingBoard ? "—" : String(value));

  return <Page>
    <div className="tasks-page">
      <PageHeader title={t("navTasks")} description={t("tasksLead")} actions={<>
        <Segmented label={t("tasksProjects")} value={tab} options={[{ value: "tasks", label: t("tasksTabTasks") }, { value: "projects", label: t("tasksTabProjects") }]} onChange={(value) => setTab(value === "projects" ? "projects" : "tasks")} />
        <Button variant="ghost" onClick={() => void load()} disabled={busy} aria-label={t("tasksRefresh")} icon={<Icon name="refresh" />}>{t("reload")}</Button>
        <Button variant="primary" onClick={() => setEditor({ task: null })} icon={<Icon name="plus" />}>{t("tasksNew")}</Button>
      </>} />
      {error && <Banner tone="danger" action={<Button size="sm" onClick={() => void load()}>{t("retry")}</Button>}>{t("tasksLoadFailed")}: {error}</Banner>}
      {board?.connectionError && <Banner tone="warn">{t("tasksConnection", { detail: board.connectionError })}</Banner>}
      {tab === "projects" ? <div className="tasks-projects-grid" aria-label={t("tasksProjects")}>
        {projects.map((item) => {
          const current = projectTask(tasks, item.id);
          const queued = tasks.filter((task) => task.projectId === item.id && task.status === "queued").length;
          return <section className={`tasks-project${project === item.id ? " is-selected" : ""}`} key={item.id}>
            <button type="button" className="tasks-project-name" aria-pressed={project === item.id} onClick={() => { setProject(item.id); setTab("tasks"); }}>
              <span><Icon name="folder" /><strong>{item.name}</strong><span className="tasks-project-queue">{queued}</span></span>
              <small title={item.cwd}>{item.cwd}</small>
            </button>
            <div className="tasks-project-state"><span className={`tasks-indicator${item.enabled ? " is-enabled" : ""}`} />{t(item.enabled ? "tasksEnabled" : "tasksPaused")}</div>
            {current && <p className={`tasks-project-current is-${current.status}`}>{t(current.status === "review" ? "tasksProjectReview" : current.status === "failed" ? "tasksProjectFailed" : TASK_STATUS_KEYS[current.status])}<span>{current.title}</span></p>}
            {!current && queued === 0 && <p className="tasks-project-idle">{t("tasksProjectIdle")}</p>}
            <Button size="sm" variant={item.enabled ? "ghost" : "secondary"} disabled={busy || (!item.enabled && !!board?.connectionError)} title={item.enabled ? t("tasksPauseHint") : undefined} onClick={() => {
              if (item.enabled) void act({ action: "project", projectId: item.id, enabled: false });
              else setStarting(item);
            }} icon={<Icon name={item.enabled ? "minus" : "play"} size={13} />}>{t(item.enabled ? "tasksPause" : "tasksStart")}</Button>
          </section>;
        })}
        {pendingBoard && loading && <>
          {[0, 1, 2, 3].map((index) => <div className="tasks-project is-skeleton" key={index} aria-hidden="true"><Skeleton width="55%" height={14} /><Skeleton width="80%" height={10} /><Skeleton width="40%" height={10} /></div>)}
        </>}
        {!loading && projects.length === 0 && <div className="tasks-no-projects" style={{ gridColumn: "1 / -1" }}><strong>{t("tasksNoProjects")}</strong><p>{t("tasksNoProjectsHint")}</p></div>}
      </div> : <>
        <div className="tasks-flow"><span className="tasks-flow-label">T3 → develop</span><span>{t("tasksWorkflow")}</span></div>
        <div className="tasks-metrics">
          {(["queued", "active", "review", "done"] as const).map((key) => <button type="button" className={`tasks-metric is-${key}${status === key ? " is-selected" : ""}`} key={key} onClick={() => setStatus(status === key ? "all" : key)} aria-pressed={status === key}>
            <span>{t(key === "active" ? "tasksActive" : key === "review" ? "tasksReview" : key === "done" ? "tasksDone" : "tasksQueued")}</span><strong className={pendingBoard ? "is-pending" : undefined}>{shown(counts[key])}</strong>
          </button>)}
        </div>
        <section className="tasks-queue" aria-label={t("navTasks")}>
          <div className="tasks-toolbar">
            <span>{t("tasksCount", { count: filtered.length })}</span>
            <div className="tasks-toolbar-filters">
              <Select label={t("tasksProjectFilter")} value={project} onChange={setProject} options={[
                { value: "all", label: t("tasksAllProjects") },
                { value: "unassigned", label: t("tasksUnassigned") },
                ...projects.map((item) => ({ value: item.id, label: item.name })),
              ]} />
              <Select label={t("tasksStatusFilter")} value={status} onChange={setStatus} options={[
                { value: "all", label: t("tasksAllStates") },
                { value: "active", label: t("tasksActive") },
                ...Object.entries(TASK_STATUS_KEYS).map(([value, key]) => ({ value, label: t(key) })),
              ]} />
            </div>
          </div>
          {loading && !board ? <div className="tasks-loading" role="status"><Spinner /><span>{t("tasksLoadingBoard")}</span></div> : filtered.length === 0 ? <EmptyState title={t(tasks.length === 0 ? "tasksNoTasks" : "tasksNoMatches")} {...(tasks.length === 0 ? { description: t("tasksNoTasksHint"), action: <Button onClick={() => setEditor({ task: null })}>{t("tasksNew")}</Button> } : {})} /> : <ul className="tasks-list">
            {filtered.map((task) => {
              const linked = projects.find((item) => item.id === task.projectId);
              return <li className={`tasks-item is-${task.status}`} key={task.id}>
                <span className={`tasks-priority is-p${task.priority}`} title={t(TASK_PRIORITY_KEYS[task.priority])}>P{task.priority}</span>
                <div className="tasks-item-body">
                  <div className="tasks-item-title"><h3>{task.title}</h3><span className={`tasks-status is-${task.status}`}>{t(TASK_STATUS_KEYS[task.status])}</span></div>
                  {task.description && <p className="tasks-description">{task.description}</p>}
                  <div className="tasks-item-meta"><span><Icon name="folder" size={12} />{linked?.name ?? t(task.projectId ? "tasksUnknownProject" : "tasksUnassigned")}</span>{task.run?.branch && <code>{task.run.branch}</code>}<span>{t("tasksUpdated", { when: formatRelative(task.updatedAt, language, timeZone) })}</span></div>
                  {(task.error ?? task.run?.error) && <p className="tasks-item-error" role="alert">{task.error ?? task.run?.error}</p>}
                </div>
                <div className="tasks-item-actions">
                  {task.status === "queued" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditor({ task })} icon={<Icon name="pencil" size={13} />}>{t("tasksEdit")}</Button>}
                  {task.status === "review" && <Button size="sm" variant="primary" disabled={busy} onClick={() => setReviewing(task)}>{t("tasksInspect")}</Button>}
                  {task.status === "failed" && <Button size="sm" disabled={busy} onClick={() => void act({ action: "retry", id: task.id })}>{t("tasksRetry")}</Button>}
                  <ThreadLink task={task} />
                </div>
              </li>;
            })}
          </ul>}
          <p className="tasks-queue-note"><Icon name="info" size={13} />{t("tasksQueueHint")}</p>
        </section>
      </>}
    </div>
    {editor && <TaskEditor key={editor.task?.id ?? "new"} task={editor.task} projects={projects} initialProject={project} busy={busy} onClose={() => { if (!busy) setEditor(null); }} onSave={async (input) => {
      const ok = await mutate(() => editor.task ? client.updateTask({ id: editor.task.id, ...input }) : client.createTask(input), t(editor.task ? "tasksSaved" : "tasksCreated"));
      if (ok) setEditor(null);
    }} />}
    {reviewing && <TaskReviewDialog key={reviewing.id} task={reviewing} onClose={() => setReviewing(null)} onChanged={acceptBoard} />}
    <ConfirmDialog open={starting !== null} title={starting ? `${t("tasksStart")} · ${starting.name}` : t("tasksStart")} description={t("tasksStartHint")} confirmLabel={t("tasksStart")} cancelLabel={t("cancel")} loading={busy} onClose={() => { if (!busy) setStarting(null); }} onConfirm={() => {
      if (starting) void act({ action: "project", projectId: starting.id, enabled: true }).then((ok) => { if (ok) setStarting(null); });
    }} />
  </Page>;
}

function TaskEditor({ task, projects, initialProject, busy, onClose, onSave }: {
  task: DevelopmentTask | null;
  projects: TaskProject[];
  initialProject: string;
  busy: boolean;
  onClose: () => void;
  onSave: (input: TaskCreateInput) => Promise<void>;
}) {
  const { t } = useDaemon();
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [projectId, setProjectId] = useState(task?.projectId ?? (projects.some((item) => item.id === initialProject) ? initialProject : ""));
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 2);
  const missingProject = projectId !== "" && !projects.some((item) => item.id === projectId);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!busy && title.trim()) void onSave({ title: title.trim(), description: description.trim(), projectId: projectId || null, priority });
  };
  return <Dialog open className="tasks-editor-dialog" onClose={onClose} title={t(task ? "tasksEdit" : "tasksNew")} footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{t("cancel")}</Button><Button variant="primary" type="submit" form="task-editor" loading={busy} disabled={!title.trim()}>{t(task ? "tasksSave" : "tasksCreate")}</Button></>}>
    <form id="task-editor" className="tasks-form" onSubmit={submit}>
      <label><span>{t("tasksTitle")}</span><Input label={t("tasksTitle")} value={title} maxLength={200} required onChange={(event) => setTitle(event.target.value)} placeholder={t("tasksTitlePlaceholder")} disabled={busy} /></label>
      <label><span>{t("tasksDescription")}</span><Textarea label={t("tasksDescription")} value={description} maxLength={20_000} rows={5} onChange={(event) => setDescription(event.target.value)} placeholder={t("tasksDescriptionPlaceholder")} disabled={busy} /></label>
      <div className="tasks-form-pair"><div><label>{t("tasksProject")}</label><Select label={t("tasksProject")} value={projectId} onChange={setProjectId} disabled={busy} options={[
        { value: "", label: t("tasksUnassigned") },
        ...projects.map((item) => ({ value: item.id, label: `${item.name} · ${item.cwd}` })),
        ...(missingProject ? [{ value: projectId, label: t("tasksUnknownProject"), disabled: true }] : []),
      ]} /></div><div><label>{t("tasksPriority")}</label><Select label={t("tasksPriority")} value={String(priority)} onChange={(value) => setPriority(Number(value) as TaskPriority)} disabled={busy} options={TASK_PRIORITY_KEYS.map((key, index) => ({ value: String(index), label: t(key) }))} /></div></div>
    </form>
  </Dialog>;
}

function TaskReviewDialog({ task, onClose, onChanged }: { task: DevelopmentTask; onClose: () => void; onChanged: (board: TaskBoard) => void }) {
  const { client, t } = useDaemon();
  const { push } = useToast();
  const [review, setReview] = useState<TaskReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    setAcknowledged(false);
    void client.taskReview(task.id).then((next) => { if (!cancelled) setReview(next); }, (error) => { if (!cancelled) setError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [client, task.id, revision]);

  const act = async (action: "approve" | "reject"): Promise<void> => {
    if (busy || !review || (action === "approve" && !acknowledged) || (action === "reject" && !feedback.trim())) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.taskAction(action === "approve"
        ? { action, id: task.id, reviewSha: review.headSha }
        : { action, id: task.id, feedback: feedback.trim() });
      onChanged(next);
      push({ message: t(action === "approve" ? "tasksApproved" : "tasksRejected"), tone: "success" });
      onClose();
    } catch (error) {
      setError(errorMessage(error));
      setAcknowledged(false);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open size="lg" className="tasks-review-dialog" title={t("tasksReviewTitle")} description={t("tasksReviewHint")} onClose={() => { if (!busy) onClose(); }} footer={<>
    <Button variant="ghost" disabled={busy} onClick={onClose}>{t("closeForm")}</Button>
    <Button disabled={busy || !review || !feedback.trim()} onClick={() => void act("reject")}>{t("tasksReject")}</Button>
    <Button variant="primary" loading={busy} disabled={!review || !acknowledged} onClick={() => void act("approve")}>{t("tasksApprove")}</Button>
  </>}>
    {error && <Banner tone="danger" action={<Button size="sm" disabled={busy} onClick={() => setRevision((value) => value + 1)}>{t("retry")}</Button>}>{error}</Banner>}
    {!review && !error && <div className="tasks-loading" role="status"><Spinner />{t("tasksLoadingReview")}</div>}
    {review && <div className="tasks-review-content">
      <header className="tasks-review-task"><h3>{review.task.title}</h3><ThreadLink task={review.task} /></header>
      <dl className="tasks-review-meta"><div><dt>{t("tasksBranch")}</dt><dd><code>{review.task.run?.branch}</code></dd></div><div><dt>{t("tasksCommit")}</dt><dd><code>{review.headSha}</code></dd></div><div><dt>{t("tasksBaseCommit")}</dt><dd><code>{review.baseSha}</code></dd></div><div><dt>{t("tasksWorktree")}</dt><dd><code>{review.task.run?.worktreePath}</code></dd></div></dl>
      <section><h4>{t("tasksSummary")}</h4><p className="tasks-review-summary">{review.task.run?.summary || t("tasksNoSummary")}</p></section>
      <section><h4>{t("tasksChanges")}</h4><pre className="tasks-review-stat">{review.stat}</pre></section>
      <section><h4>{t("tasksDiff")}</h4>{review.truncated && <Banner tone="warn">{t("tasksTruncated")}</Banner>}<pre className="tasks-review-diff" tabIndex={0} aria-label={t("tasksDiff")}>{review.diff}</pre></section>
      <label className="tasks-review-ack"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} /><span>{t("tasksAcknowledged")}</span></label>
      <label className="tasks-review-feedback"><span>{t("tasksFeedback")}</span><Textarea label={t("tasksFeedback")} value={feedback} maxLength={10_000} rows={3} disabled={busy} onChange={(event) => setFeedback(event.target.value)} placeholder={t("tasksFeedbackPlaceholder")} /></label>
    </div>}
  </Dialog>;
}
