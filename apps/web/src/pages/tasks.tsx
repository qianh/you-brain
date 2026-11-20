import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { TASK_IMAGE_MAX_BYTES, TASK_IMAGE_MAX_COUNT, TASK_IMAGE_TYPES, type DevelopmentTask, type TaskActionInput, type TaskBoard, type TaskCreateInput, type TaskImage, type TaskPriority, type TaskProject, type TaskReview } from "@you-brain/core/tasks/types.js";

import { Banner } from "../components/banner.js";
import { Button, IconButton } from "../components/button.js";
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
import { useRoute } from "../router.js";
import { projectTasks, TASK_PRIORITY_KEYS, TASK_STATUS_KEYS, taskCounts, taskStatusKey, taskThreadHref, taskWorktreeHint, visibleTasks } from "./tasks/logic.js";
import { ProjectPicker, type ProjectChoice } from "./tasks/project-picker.js";
import { clipboardTaskImages, TaskImagePreview } from "./tasks/images.js";

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const TASK_METRICS = [
  ["all", "tasksAll"], ["queued", "tasksQueued"], ["active", "tasksActive"], ["review", "tasksReview"], ["done", "tasksDone"],
] as const;

function ThreadLink({ task, onOpen }: { task: DevelopmentTask; onOpen?: () => void }) {
  const { t } = useDaemon();
  const { navigate } = useRoute();
  const href = taskThreadHref(task.run?.threadUrl);
  return href ? <a className="tasks-thread-link" href={href} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen?.();
    navigate(href);
  }}>
    {t("tasksOpenT3")} <Icon name="chevron-right" size={12} />
  </a> : null;
}

export function TasksPage() {
  const { client, t, language, timeZone } = useDaemon();
  const { navigate } = useRoute();
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
  const [viewingImages, setViewingImages] = useState<DevelopmentTask | null>(null);
  const [completing, setCompleting] = useState<DevelopmentTask | null>(null);
  const [starting, setStarting] = useState<TaskProject | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
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

  const mutate = async (work: () => Promise<TaskBoard>, success?: string, after?: (board: TaskBoard) => void): Promise<boolean> => {
    if (mutating.current) return false;
    mutating.current = true;
    version.current += 1;
    setBusy(true);
    try {
      const next = await work();
      if (mounted.current) {
        acceptBoard(next);
        if (success) push({ message: success, tone: "success" });
        after?.(next);
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
  const startTask = async (id: string): Promise<void> => {
    if (mutating.current) return;
    setLaunchingId(id);
    try {
      await mutate(() => client.taskAction({ action: "start", id }), undefined, (next) => {
        const href = taskThreadHref(next.tasks.find((task) => task.id === id)?.run?.threadUrl);
        if (href && document.visibilityState !== "hidden" && window.location.pathname.replace(/\/$/u, "") === "/todos") navigate(href);
      });
    } finally {
      if (mounted.current) setLaunchingId(null);
    }
  };
  const tasks = board?.tasks ?? [];
  const projects = board?.projects ?? [];
  const filtered = visibleTasks(tasks, project, status);
  const counts = taskCounts(tasks, project);
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
          const unfinished = projectTasks(tasks, item.id);
          const current = unfinished[0];
          const queued = tasks.filter((task) => task.projectId === item.id && task.status === "queued").length;
          // 卡片固定三段:头部(名称+路径+排队数)、正文(当前任务/待领取/空闲,固定两行高)、底栏(状态+按钮),高度一致。
          return <section className={`tasks-project${project === item.id ? " is-selected" : ""}${item.enabled ? " is-enabled" : ""}`} key={item.id}>
            <button type="button" className="tasks-project-name" aria-pressed={project === item.id} title={item.cwd} onClick={() => { setProject(item.id); setTab("tasks"); }}>
              <span className="tasks-project-icon"><Icon name="folder" /></span>
              <span className="tasks-project-title">
                <strong>{item.name}</strong>
                <small>{item.cwd}</small>
              </span>
              <span className={`tasks-project-queue${queued > 0 ? " has-items" : ""}`} title={t("tasksProjectQueued", { count: queued })}>{queued}</span>
            </button>
            <div className="tasks-project-body">
              {current
                ? <p className={`tasks-project-current is-${current.status}`}><span className="tasks-project-current-label">{t(current.status === "review" ? "tasksProjectReview" : current.status === "failed" ? "tasksProjectFailed" : TASK_STATUS_KEYS[current.status])}</span><span className="tasks-project-current-title" title={current.title}>{current.title}{unfinished.length > 1 ? ` +${unfinished.length - 1}` : ""}</span></p>
                : queued > 0
                  ? <p className="tasks-project-waiting">{t("tasksProjectQueued", { count: queued })}</p>
                  : <p className="tasks-project-idle">{t("tasksProjectIdle")}</p>}
            </div>
            <div className="tasks-project-foot">
              <span className="tasks-project-state"><span className={`tasks-indicator${item.enabled ? " is-enabled" : ""}`} />{t(item.enabled ? "tasksEnabled" : "tasksPaused")}</span>
              <Button size="sm" variant={item.enabled ? "ghost" : "secondary"} disabled={busy || (!item.enabled && !!board?.connectionError)} title={item.enabled ? t("tasksPauseHint") : undefined} onClick={() => {
                if (item.enabled) void act({ action: "project", projectId: item.id, enabled: false });
                else setStarting(item);
              }} icon={<Icon name={item.enabled ? "minus" : "play"} size={13} />}>{t(item.enabled ? "tasksPause" : "tasksStart")}</Button>
            </div>
          </section>;
        })}
        {pendingBoard && loading && <>
          {[0, 1, 2, 3].map((index) => <div className="tasks-project is-skeleton" key={index} aria-hidden="true"><Skeleton width="55%" height={14} /><Skeleton width="80%" height={10} /><Skeleton width="40%" height={10} /></div>)}
        </>}
        {!loading && projects.length === 0 && <div className="tasks-no-projects" style={{ gridColumn: "1 / -1" }}><strong>{t("tasksNoProjects")}</strong><p>{t("tasksNoProjectsHint")}</p></div>}
      </div> : <>
        <div className="tasks-flow"><span className="tasks-flow-label">T3 → develop</span><span>{t("tasksWorkflow")}</span></div>
        <div className="tasks-metrics">
          {TASK_METRICS.map(([key, label]) => <button type="button" className={`tasks-metric is-${key}${status === key ? " is-selected" : ""}`} key={key} onClick={() => setStatus(status === key ? "all" : key)} aria-pressed={status === key}>
            <span>{t(label)}</span><strong className={pendingBoard ? "is-pending" : undefined}>{shown(counts[key])}</strong>
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
              const worktreeBlock = task.status === "failed" ? task.worktreeBlock : undefined;
              const taskError = task.error ?? task.run?.error;
              return <li className={`tasks-item is-${task.status}`} key={task.id}>
                <span className={`tasks-priority is-p${task.priority}`} title={t(TASK_PRIORITY_KEYS[task.priority])}>P{task.priority}</span>
                <div className="tasks-item-body">
                  <div className="tasks-item-title"><h3>{task.title}</h3><span className={`tasks-status is-${worktreeBlock ? "worktree-blocked" : task.status}`}>{t(taskStatusKey(task))}</span></div>
                  {task.description && <p className="tasks-description">{task.description}</p>}
                  <div className="tasks-item-meta"><span><Icon name="folder" size={12} />{linked?.name ?? t(task.projectId ? "tasksUnknownProject" : "tasksUnassigned")}</span>{task.run?.branch && <code>{task.run.branch}</code>}<span>{t("tasksUpdated", { when: formatRelative(task.updatedAt, language, timeZone) })}</span></div>
                  {!!task.images?.length && <Button size="sm" variant="ghost" onClick={() => setViewingImages(task)}>{t("tasksImages", { count: task.images.length })}</Button>}
                  {worktreeBlock ? <p className="tasks-item-error is-worktree-blocked" role="status">{taskWorktreeHint(worktreeBlock, language)}</p>
                    : taskError && <p className="tasks-item-error" role="alert">{taskError}</p>}
                </div>
                <div className="tasks-item-actions">
                  {task.status === "queued" && <Button size="sm" disabled={busy || !!board?.connectionError} loading={launchingId === task.id} onClick={() => void startTask(task.id)} icon={<Icon name="play" size={13} />}>{t("tasksStartOne")}</Button>}
                  {task.status === "queued" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditor({ task })} icon={<Icon name="pencil" size={13} />}>{t("tasksEdit")}</Button>}
                  {task.status === "review" && <Button size="sm" variant="primary" disabled={busy} onClick={() => setReviewing(task)}>{t("tasksInspect")}</Button>}
                  {task.status === "failed" && <Button size="sm" disabled={busy} onClick={() => void act({ action: "retry", id: task.id })}>{t("tasksRetry")}</Button>}
                  {task.status !== "done" && task.status !== "merging" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCompleting(task)} icon={<Icon name="check" size={13} />}>{t("tasksComplete")}</Button>}
                  <ThreadLink task={task} />
                </div>
              </li>;
            })}
          </ul>}
          <p className="tasks-queue-note"><Icon name="info" size={13} />{t("tasksQueueHint")}</p>
        </section>
      </>}
    </div>
    {editor && <TaskEditor key={editor.task?.id ?? "new"} task={editor.task} projects={projects} initialProject={project} busy={busy} onClose={() => { if (!busy) setEditor(null); }} onSave={async (input, files, retainImageIds) => {
      const ok = await mutate(() => editor.task ? client.updateTask({ id: editor.task.id, ...input, retainImageIds }, files) : client.createTask(input, files), t(editor.task ? "tasksSaved" : "tasksCreated"));
      if (ok) setEditor(null);
    }} />}
    {viewingImages && <Dialog open size="lg" title={viewingImages.title} onClose={() => setViewingImages(null)}>
      <div className="tasks-image-gallery">{viewingImages.images?.map((image) => <figure key={image.id}><TaskImagePreview image={image} taskId={viewingImages.id} /><figcaption>{image.name}</figcaption></figure>)}</div>
    </Dialog>}
    {reviewing && <TaskReviewDialog key={reviewing.id} task={reviewing} onClose={() => setReviewing(null)} onChanged={acceptBoard} />}
    <ConfirmDialog open={completing !== null} title={completing ? `${t("tasksComplete")} · ${completing.title}` : t("tasksComplete")} description={t("tasksCompleteHint")} confirmLabel={t("tasksComplete")} cancelLabel={t("cancel")} loading={busy} onClose={() => { if (!busy) setCompleting(null); }} onConfirm={() => {
      if (completing) void mutate(() => client.taskAction({ action: "complete", id: completing.id }), t("tasksCompleted")).then((ok) => { if (ok) setCompleting(null); });
    }} />
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
  onSave: (input: TaskCreateInput, images: File[], retainImageIds: string[]) => Promise<void>;
}) {
  const { t } = useDaemon();
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [project, setProject] = useState<ProjectChoice>({ projectId: task?.projectId ?? (projects.some((item) => item.id === initialProject) ? initialProject : "") });
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 2);
  const [savedImages, setSavedImages] = useState<TaskImage[]>(task?.images ?? []);
  const [newImages, setNewImages] = useState<Array<{ id: number; file: File }>>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageSequence = useRef(0);
  const imageCount = savedImages.length + newImages.length;
  const addImages = (files: File[]): void => {
    if (busy || !files.length) return;
    if (imageCount + files.length > TASK_IMAGE_MAX_COUNT) { setImageError(t("tasksImageCountLimit")); return; }
    if (files.some((file) => !TASK_IMAGE_TYPES.some((type) => type === file.type) || file.size === 0 || file.size > TASK_IMAGE_MAX_BYTES)) {
      setImageError(t("tasksImageTypeLimit"));
      return;
    }
    setImageError(null);
    const added = files.map((file) => ({ id: ++imageSequence.current, file }));
    setNewImages((previous) => [...previous, ...added]);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !title.trim()) return;
    const linked = "newProject" in project ? { newProject: project.newProject } : { projectId: project.projectId || null };
    void onSave({ title: title.trim(), description: description.trim(), ...linked, priority }, newImages.map(({ file }) => file), savedImages.map(({ id }) => id));
  };
  return <Dialog open className="tasks-editor-dialog" onClose={onClose} title={t(task ? "tasksEdit" : "tasksNew")} footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{t("cancel")}</Button><Button variant="primary" type="submit" form="task-editor" loading={busy} disabled={!title.trim()}>{t(task ? "tasksSave" : "tasksCreate")}</Button></>}>
    <form id="task-editor" className="tasks-form" onSubmit={submit}>
      <label><span>{t("tasksTitle")}</span><Input label={t("tasksTitle")} value={title} maxLength={200} required onChange={(event) => setTitle(event.target.value)} placeholder={t("tasksTitlePlaceholder")} disabled={busy} /></label>
      <div className="tasks-description-field">
        <label><span>{t("tasksDescription")}</span><Textarea label={t("tasksDescription")} value={description} maxLength={20_000} rows={5} onChange={(event) => setDescription(event.target.value)} placeholder={t("tasksDescriptionPlaceholder")} disabled={busy} onPaste={(event) => {
          const images = clipboardTaskImages(event.clipboardData);
          if (images.length) { event.preventDefault(); addImages(images); }
        }} /></label>
        {!!imageCount && <ul className="tasks-image-previews">
          {savedImages.map((image) => <li key={image.id}><TaskImagePreview image={image} {...(task ? { taskId: task.id } : {})} /><IconButton label={t("tasksRemoveImage", { name: image.name })} disabled={busy} onClick={() => { setSavedImages((items) => items.filter(({ id }) => id !== image.id)); setImageError(null); }}><Icon name="x" size={13} /></IconButton></li>)}
          {newImages.map(({ id, file }) => <li key={id}><TaskImagePreview image={file} /><IconButton label={t("tasksRemoveImage", { name: file.name })} disabled={busy} onClick={() => { setNewImages((items) => items.filter((item) => item.id !== id)); setImageError(null); }}><Icon name="x" size={13} /></IconButton></li>)}
        </ul>}
        <div className="tasks-image-toolbar">
          <input ref={fileInput} type="file" hidden multiple accept={TASK_IMAGE_TYPES.join(",")} onChange={(event) => { addImages([...event.currentTarget.files ?? []]); event.currentTarget.value = ""; }} />
          <Button size="sm" variant="ghost" disabled={busy || imageCount >= TASK_IMAGE_MAX_COUNT} icon={<Icon name="plus" size={13} />} onClick={() => fileInput.current?.click()}>{t("tasksAddImage")}</Button>
          {imageError && <small role="alert">{imageError}</small>}
        </div>
      </div>
      <div className="tasks-form-pair"><div><label>{t("tasksProject")}</label><ProjectPicker projects={projects} value={project} onChange={setProject} disabled={busy} /></div><div><label>{t("tasksPriority")}</label><Select label={t("tasksPriority")} value={String(priority)} onChange={(value) => setPriority(Number(value) as TaskPriority)} disabled={busy} options={TASK_PRIORITY_KEYS.map((key, index) => ({ value: String(index), label: t(key) }))} /></div></div>
      {"newProject" in project && <p className="tasks-form-hint" role="status"><Icon name="info" size={13} />{t(project.newProject.cwd ? "tasksProjectWillAdd" : "tasksProjectWillCreate", { name: project.newProject.name })}</p>}
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
      // 确认合并时若 develop 已前进，任务被合入 develop 后交回 T3，而不是直接完成。
      const synced = action === "approve" && next.tasks.find((item) => item.id === task.id)?.status !== "done";
      push({ message: t(action === "approve" ? (synced ? "tasksApproveSynced" : "tasksApproved") : "tasksRejected"), tone: synced ? "info" : "success" });
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
    {error && <Banner tone="danger" action={<Button size="sm" disabled={busy} onClick={() => setRevision((value) => value + 1)}>{t(review ? "reload" : "retry")}</Button>}>{error}</Banner>}
    {!review && !error && <div className="tasks-loading" role="status"><Spinner />{t("tasksLoadingReview")}</div>}
    {review && <div className="tasks-review-content">
      <header className="tasks-review-task"><h3>{review.task.title}</h3><ThreadLink task={review.task} onOpen={onClose} /></header>
      <dl className="tasks-review-meta"><div><dt>{t("tasksBranch")}</dt><dd><code>{review.task.run?.branch}</code></dd></div><div><dt>{t("tasksCommit")}</dt><dd><code>{review.headSha}</code></dd></div><div><dt>{t("tasksBaseCommit")}</dt><dd><code>{review.baseSha}</code></dd></div><div><dt>{t("tasksWorktree")}</dt><dd><code>{review.task.run?.worktreePath}</code></dd></div></dl>
      <section><h4>{t("tasksSummary")}</h4><p className="tasks-review-summary">{review.task.run?.summary || t("tasksNoSummary")}</p></section>
      <section><h4>{t("tasksChanges")}</h4><pre className="tasks-review-stat">{review.stat}</pre></section>
      <section><h4>{t("tasksDiff")}</h4>{review.truncated && <Banner tone="warn">{t("tasksTruncated")}</Banner>}<pre className="tasks-review-diff" tabIndex={0} aria-label={t("tasksDiff")}>{review.diff}</pre></section>
      <label className="tasks-review-ack"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} /><span>{t("tasksAcknowledged")}</span></label>
      <label className="tasks-review-feedback"><span>{t("tasksFeedback")}</span><Textarea label={t("tasksFeedback")} value={feedback} maxLength={10_000} rows={3} disabled={busy} onChange={(event) => setFeedback(event.target.value)} placeholder={t("tasksFeedbackPlaceholder")} /></label>
    </div>}
  </Dialog>;
}
