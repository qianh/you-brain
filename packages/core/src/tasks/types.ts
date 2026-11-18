/** 可执行 TODO 与话题提炼出的待办分开保存；项目来自 T3。 */
export interface TaskProject {
  id: string;
  name: string;
  cwd: string;
  enabled: boolean;
}

export type TaskStatus = "queued" | "preparing" | "running" | "review" | "merging" | "done" | "failed";
export type TaskPriority = 0 | 1 | 2 | 3;

export interface TaskRun {
  /** 领取任务时的项目目录；T3 中更换目录后不得继续操作原任务。 */
  projectCwd: string;
  branch: string;
  worktreePath: string;
  baseSha: string;
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

export interface DevelopmentTask {
  id: string;
  title: string;
  description: string;
  projectId: string | null;
  /** P0 最高，同优先级按创建时间及入队顺序排序。 */
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  run: TaskRun | null;
  error?: string | null | undefined;
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
  projectId?: string | null | undefined;
  /** 与 projectId 互斥。 */
  newProject?: TaskNewProject | undefined;
  priority?: TaskPriority | undefined;
}

export type TaskActionInput =
  | { action: "project"; projectId: string; enabled: boolean }
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
  create(input: TaskCreateInput): Promise<TaskBoard>;
  update(input: TaskUpdateInput): Promise<TaskBoard>;
  action(input: TaskActionInput): Promise<TaskBoard>;
  review(id: string): Promise<TaskReview>;
}

export interface TaskGitPort {
  prepare(project: TaskProject, taskId: string): Promise<Pick<TaskRun, "branch" | "worktreePath" | "baseSha">>;
  review(project: TaskProject, run: TaskRun): Promise<Omit<TaskReview, "task">>;
  merge(project: TaskProject, run: TaskRun, approvedSha: string): Promise<void>;
}

export interface TaskAutomationPort {
  projects(): Promise<Array<Omit<TaskProject, "enabled">>>;
  createProject(input: TaskNewProject): Promise<Omit<TaskProject, "enabled">>;
  start(input: { projectId: string; title: string; prompt: string; cwd: string; branch: string; requestId: string }): Promise<{ threadId: string; threadUrl: string }>;
  inspect(threadId: string): Promise<{ state: "running" | "ready" | "failed"; summary: string; error?: string }>;
  followup(threadId: string, prompt: string, commandId: string): Promise<void>;
}
