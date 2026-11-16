import type { DevelopmentTask, TaskStatus } from "@you-brain/core/tasks/types.js";
import type { MessageKey } from "../../i18n/messages.js";

export const TASK_STATUS_KEYS: Record<TaskStatus, MessageKey> = {
  queued: "tasksQueued",
  preparing: "tasksPreparing",
  running: "tasksRunning",
  review: "tasksReview",
  merging: "tasksMerging",
  done: "tasksDone",
  failed: "tasksFailed",
};

export const TASK_PRIORITY_KEYS = ["tasksPriority0", "tasksPriority1", "tasksPriority2", "tasksPriority3"] as const;

export function visibleTasks(tasks: DevelopmentTask[], project: string, status: string): DevelopmentTask[] {
  return tasks.filter((task) =>
    (project === "all" || (project === "unassigned" ? task.projectId === null : task.projectId === project)) &&
    (status === "all" || (status === "active" ? ["preparing", "running", "merging"].includes(task.status) : task.status === status)),
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
