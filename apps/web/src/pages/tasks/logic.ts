import type { DevelopmentTask, TaskProject, TaskStatus } from "@you-brain/core/tasks/types.js";
import type { MessageKey } from "../../i18n/messages.js";

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

export function isTaskActive(status: TaskStatus): boolean {
  return status === "preparing" || status === "planning" || status === "running" || status === "merging";
}

export function visibleTasks(tasks: DevelopmentTask[], project: string, status: string): DevelopmentTask[] {
  return tasks.filter((task) =>
    (project === "all" || (project === "unassigned" ? task.projectId === null : task.projectId === project)) &&
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

export function projectTask(tasks: DevelopmentTask[], projectId: string): DevelopmentTask | undefined {
  return tasks.find((task) => task.projectId === projectId && task.status !== "queued" && task.status !== "done");
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
