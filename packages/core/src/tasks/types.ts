/** 可执行 TODO 与话题提炼出的待办分开保存；项目来自 T3。 */
export interface TaskProject {
  id: string;
  name: string;
  cwd: string;
  enabled: boolean;
}

export type TaskStatus = "queued" | "preparing" | "planning" | "running" | "review" | "merging" | "done" | "failed";
export type TaskPriority = 0 | 1 | 2 | 3;

export const TASK_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const TASK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const TASK_IMAGE_MAX_COUNT = 4;

export interface TaskImage {
  id: string;
  name: string;
  mimeType: typeof TASK_IMAGE_TYPES[number];
  sizeBytes: number;
}

export type TaskImageData = TaskImage & { bytes: Uint8Array<ArrayBuffer> };

export interface TaskWorktreeBlock {
  uncommitted: number;
  untracked: number;
}

interface TaskRunDetails {
  /** 领取任务时的项目目录；T3 中更换目录后不得继续操作原任务。 */
  projectCwd: string;
  /** 派发编号：T3 用它对同一次派发去重。会话编号由 T3 分配，派发成功后才写入 threadId。 */
  requestId?: string | undefined;
  threadId: string | null;
  threadUrl: string | null;
  reviewSha: string | null;
  summary: string;
  error: string | null;
  /** 返工投递失败时以同一命令重试，避免重复 turn 或把旧结果当作返工完成。 */
  pendingFeedback?: { commandId: string; prompt: string } | undefined;
}

export interface TaskWorktreeRun extends TaskRunDetails {
  branch: string;
  worktreePath: string;
  baseSha: string;
}

export type TaskRun = TaskWorktreeRun | (TaskRunDetails & {
  branch: null;
  worktreePath: null;
  baseSha: null;
});

export interface DevelopmentTask {
  id: string;
  title: string;
  description: string;
  images?: TaskImage[] | undefined;
  projectId: string | null;
  /** P0 最高，同优先级按创建时间及入队顺序排序。 */
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  run: TaskRun | null;
  manual?: true | undefined;
  completedManually?: true | undefined;
  error?: string | null | undefined;
  worktreeBlock?: TaskWorktreeBlock | undefined;
}

export interface TaskBoard {
  projects: TaskProject[];
  tasks: DevelopmentTask[];
  connectionError: string | null;
}

/** 保存 TODO 时顺带在 T3 登记的新项目：有 cwd 时登记本机已有文件夹，否则由 T3 新建空仓库。 */
export interface TaskNewProject {
  name: string;
  cwd?: string | undefined;
}

export interface TaskCreateInput {
  title: string;
  description?: string | undefined;
  projectId?: string | null | undefined;
  /** 与 projectId 互斥。 */
  newProject?: TaskNewProject | undefined;
  priority?: TaskPriority | undefined;
}

export interface TaskUpdateInput {
  id: string;
  title?: string | undefined;
  description?: string | undefined;
  retainImageIds?: string[] | undefined;
  projectId?: string | null | undefined;
  /** 与 projectId 互斥。 */
  newProject?: TaskNewProject | undefined;
  priority?: TaskPriority | undefined;
}

export type TaskActionInput =
  | { action: "project"; projectId: string; enabled: boolean }
  | { action: "start"; id: string }
  | { action: "complete"; id: string }
  | { action: "retry"; id: string }
  | { action: "approve"; id: string; reviewSha: string }
  | { action: "reject"; id: string; feedback: string };

export interface TaskReview {
  task: DevelopmentTask;
  headSha: string;
  baseSha: string;
  stat: string;
  diff: string;
  truncated: boolean;
}

export interface TaskHttpPort {
  board(): Promise<TaskBoard>;
  create(input: TaskCreateInput, images?: readonly File[]): Promise<TaskBoard>;
  update(input: TaskUpdateInput, images?: readonly File[]): Promise<TaskBoard>;
  image(taskId: string, imageId: string): Promise<TaskImageData>;
  action(input: TaskActionInput): Promise<TaskBoard>;
  review(id: string): Promise<TaskReview>;
}

export interface TaskGitPort {
  prepare(project: TaskProject, taskId: string): Promise<Pick<TaskWorktreeRun, "branch" | "worktreePath" | "baseSha">>;
  isMerged(project: TaskProject, run: TaskWorktreeRun): Promise<boolean>;
  review(project: TaskProject, run: TaskWorktreeRun): Promise<Omit<TaskReview, "task">>;
  merge(project: TaskProject, run: TaskWorktreeRun, approvedSha: string): Promise<void>;
  /** 合并被分叉阻止时，把本地 develop 合入任务分支；冲突时还原并返回 conflict。 */
  syncDevelop(project: TaskProject, run: TaskWorktreeRun, approvedSha: string): Promise<"merged" | "conflict" | "current">;
}

type TaskLaunchInput = { title: string; prompt: string; cwd: string; requestId: string; images?: TaskImageData[] } & (
  | { projectId: string; branch: string; plan?: true | undefined }
  | { projectId: null; branch: null; plan: true }
);

export interface TaskAutomationPort {
  projects(): Promise<Array<Omit<TaskProject, "enabled">>>;
  createProject(input: TaskNewProject): Promise<Omit<TaskProject, "enabled">>;
  start(input: TaskLaunchInput): Promise<{ threadId: string; threadUrl: string }>;
  inspect(threadId: string, requirementsFirst?: boolean): Promise<{ state: "planning" | "running" | "ready" | "failed"; summary: string; error?: string }>;
  followup(threadId: string, prompt: string, commandId: string): Promise<void>;
}
