import { z } from "zod";

const title = z.string().trim().min(1).max(200);
const description = z.string().max(20_000);
const projectId = z.string().min(1).max(200).nullable();
const priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const id = z.string().min(1).max(200);

export const TaskCreateSchema = z.object({
  title,
  description: description.optional(),
  projectId: projectId.optional(),
  priority: priority.optional(),
}).strict();

export const TaskUpdateSchema = z.object({
  id,
  title: title.optional(),
  description: description.optional(),
  projectId: projectId.optional(),
  priority: priority.optional(),
}).strict();

export const TaskActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("project"), projectId: id, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("retry"), id }).strict(),
  z.object({ action: z.literal("approve"), id, reviewSha: z.string().regex(/^[a-f0-9]{40,64}$/u) }).strict(),
  z.object({ action: z.literal("reject"), id, feedback: z.string().trim().min(1).max(10_000) }).strict(),
]);

export const TaskRecordSchema = z.object({
  id, title, description, projectId, priority,
  status: z.enum(["queued", "preparing", "running", "review", "merging", "done", "failed"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  error: z.string().nullable().optional(),
  run: z.object({
    projectCwd: z.string(), branch: z.string(), worktreePath: z.string(), baseSha: z.string(),
    requestId: z.string().optional(),
    threadId: z.string().nullable(), threadUrl: z.string().nullable(), reviewSha: z.string().nullable(),
    summary: z.string(), error: z.string().nullable(),
    pendingFeedback: z.object({ commandId: z.string(), prompt: z.string() }).optional(),
  }).nullable(),
});

export const TaskStateSchema = z.object({
  version: z.literal(1),
  projects: z.array(z.object({ id, name: z.string(), cwd: z.string(), enabled: z.boolean() })),
  tasks: z.array(TaskRecordSchema),
});

export type TaskState = z.infer<typeof TaskStateSchema>;
