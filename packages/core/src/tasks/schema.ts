import { z } from "zod";

const title = z.string().trim().min(1).max(200);
const description = z.string().max(20_000);
const projectId = z.string().min(1).max(200).nullable();
const priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const id = z.string().min(1).max(200);
const newProject = z.object({
  name: z.string().trim().min(1).max(100),
  cwd: z.string().trim().min(1).max(4096).refine((value) => value.startsWith("/"), "项目文件夹必须是绝对路径").optional(),
}).strict();
const oneProject = (body: { projectId?: string | null | undefined; newProject?: unknown }): boolean =>
  !(body.newProject !== undefined && body.projectId);
const oneProjectMessage = { message: "projectId 与 newProject 只能二选一" };

export const TaskCreateSchema = z.object({
  title,
  description: description.optional(),
  projectId: projectId.optional(),
  newProject: newProject.optional(),
  priority: priority.optional(),
}).strict().refine(oneProject, oneProjectMessage);

export const TaskUpdateSchema = z.object({
  id,
  title: title.optional(),
  description: description.optional(),
  projectId: projectId.optional(),
  newProject: newProject.optional(),
  priority: priority.optional(),
}).strict().refine(oneProject, oneProjectMessage);

export const TaskActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("project"), projectId: id, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("start"), id }).strict(),
  z.object({ action: z.literal("complete"), id }).strict(),
  z.object({ action: z.literal("retry"), id }).strict(),
  z.object({ action: z.literal("approve"), id, reviewSha: z.string().regex(/^[a-f0-9]{40,64}$/u) }).strict(),
  z.object({ action: z.literal("reject"), id, feedback: z.string().trim().min(1).max(10_000) }).strict(),
]);

const runDetails = z.object({
  projectCwd: z.string(), requestId: z.string().optional(),
  threadId: z.string().nullable(), threadUrl: z.string().nullable(), reviewSha: z.string().nullable(),
  summary: z.string(), error: z.string().nullable(),
  pendingFeedback: z.object({ commandId: z.string(), prompt: z.string() }).optional(),
});

export const TaskRecordSchema = z.object({
  id, title, description, projectId, priority,
  status: z.enum(["queued", "preparing", "planning", "running", "review", "merging", "done", "failed"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  error: z.string().nullable().optional(),
  worktreeBlock: z.object({ uncommitted: z.number().int().nonnegative(), untracked: z.number().int().nonnegative() }).optional(),
  manual: z.literal(true).optional(),
  completedManually: z.literal(true).optional(),
  run: z.union([
    runDetails.extend({ branch: z.string(), worktreePath: z.string(), baseSha: z.string() }),
    runDetails.extend({ branch: z.null(), worktreePath: z.null(), baseSha: z.null() }),
  ]).nullable(),
});

export const TaskStateSchema = z.object({
  version: z.literal(1),
  projects: z.array(z.object({ id, name: z.string(), cwd: z.string(), enabled: z.boolean() })),
  tasks: z.array(TaskRecordSchema),
});

export type TaskState = z.infer<typeof TaskStateSchema>;
