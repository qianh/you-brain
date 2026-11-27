import type { DevelopmentTask, TaskProject, TaskStatus, TaskWorktreeBlock } from "@you-brain/core/tasks/types.js";
import { deckT3ThreadHref } from "../../lib/route.js";
import { translate, type MessageKey } from "../../i18n/messages.js";
import type { Language } from "../../lib/format.js";

export const TASK_STATUS_KEYS: Record<TaskStatus, MessageKey> = {
  queued: "tasksQueued",
  preparing: "tasksPreparing",
  planning: "tasksPlanning",
  running: "tasksRunning",
  review: "tasksReview",
  merging: "tasksMerging",
  done: "tasksDone",
  failed: "tasksFailed",
};

export const TASK_PRIORITY_KEYS = ["tasksPriority0", "tasksPriority1", "tasksPriority2", "tasksPriority3"] as const;

export function isTaskActive(status: TaskStatus): status is "preparing" | "planning" | "running" | "merging" {
  return status === "preparing" || status === "planning" || status === "running" || status === "merging";
}

function matchesProject(task: DevelopmentTask, project: string): boolean {
  return project === "all" || task.projectId === (project === "unassigned" ? null : project);
}

export function taskCounts(tasks: readonly DevelopmentTask[], project: string) {
  const counts = { all: 0, queued: 0, active: 0, review: 0, done: 0 };
  for (const task of tasks) {
    if (!matchesProject(task, project)) continue;
    counts.all += 1;
    if (isTaskActive(task.status)) counts.active += 1;
    else if (task.status !== "failed") counts[task.status] += 1;
  }
  return counts;
}

export function taskStatusKey(task: DevelopmentTask): MessageKey {
  if (task.status === "failed" && task.worktreeBlock) return "tasksWorktreeBlocked";
  return TASK_STATUS_KEYS[task.status];
}

export function taskWorktreeHint({ uncommitted, untracked }: TaskWorktreeBlock, language: Language): string {
  const key = uncommitted > 0 ? (untracked > 0 ? "tasksWorktreeMixed" : "tasksWorktreeUncommitted") : "tasksWorktreeUntracked";
  const detail = translate(language, key, { uncommitted, untracked });
  return `${detail}${language === "en" ? " " : ""}${translate(language, "tasksWorktreeRecheck")}`;
}

export function visibleTasks(tasks: DevelopmentTask[], project: string, status: string): DevelopmentTask[] {
  return tasks.filter((task) =>
    matchesProject(task, project) &&
    (status === "all" || (status === "active" ? isTaskActive(task.status) : task.status === status)),
  ).sort((left, right) => left.priority - right.priority || left.createdAt.localeCompare(right.createdAt));
}

/** 任务链接来自本机 T3；不能将任意协议当成可点击链接。 */
export function taskThreadUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password
      ? url.href : null;
  } catch {
    return null;
  }
}

export function taskThreadHref(value: string | null | undefined, deviceId?: string | null): string | null {
  const url = taskThreadUrl(value);
  return url ? deckT3ThreadHref(url, deviceId) : null;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 项目内未结束的任务：执行中优先，其次待核对，最后受阻。同一项目可并行多项。 */
export function projectTasks(tasks: DevelopmentTask[], projectId: string): DevelopmentTask[] {
  const rank = (task: DevelopmentTask): number => task.status === "review" ? 1 : task.status === "failed" ? 2 : 0;
  return tasks.filter((task) => task.projectId === projectId && task.status !== "queued" && task.status !== "done")
    .sort((a, b) => rank(a) - rank(b));
}

export function projectTask(tasks: DevelopmentTask[], projectId: string): DevelopmentTask | undefined {
  return projectTasks(tasks, projectId)[0];
}

export type ProjectPickerRow =
  | { kind: "none" }
  | { kind: "project"; project: TaskProject; hint: string | null }
  | { kind: "create"; name: string }
  | { kind: "folder" };

/** 路径的最后一段，作为文件夹项目的默认名称。 */
export function folderName(path: string): string {
  const parts = path.replace(/\/+$/u, "").split("/");
  return parts[parts.length - 1] || path;
}

const normalized = (value: string): string => value.trim().toLocaleLowerCase();

/**
 * 项目选择器的候选行：只按名称搜索，不展示完整路径；同名项目才用上级目录名区分。
 * 输入了列表里没有的名称时给出「新建项目」，本机可选文件夹时始终保留「添加文件夹」。
 */
export function projectPickerRows(projects: readonly TaskProject[], query: string, canPickFolder: boolean): ProjectPickerRow[] {
  const needle = normalized(query);
  const counts = new Map<string, number>();
  for (const project of projects) counts.set(normalized(project.name), (counts.get(normalized(project.name)) ?? 0) + 1);
  const matches = projects
    .filter((project) => needle === "" || normalized(project.name).includes(needle))
    .sort((left, right) => Number(normalized(right.name).startsWith(needle)) - Number(normalized(left.name).startsWith(needle)));
  const rows: ProjectPickerRow[] = needle === "" ? [{ kind: "none" }] : [];
  for (const project of matches) {
    const parent = project.cwd.replace(/\/+$/u, "").split("/").slice(0, -1);
    rows.push({ kind: "project", project, hint: (counts.get(normalized(project.name)) ?? 0) > 1 ? folderName(parent.join("/")) || null : null });
  }
  if (needle !== "" && !projects.some((project) => normalized(project.name) === needle)) rows.push({ kind: "create", name: query.trim() });
  if (canPickFolder) rows.push({ kind: "folder" });
  return rows;
}
