import { z } from "zod";
import { DingTalkInboxSchema } from "./dingtalk-inbox.js";
import { dingTalkTaskId } from "./dingtalk-minutes.js";
import { dingTalkActionKey, dingTalkMinutesSource, MEETING_IMPORT_MAX_ITEMS, StoredMeetingImportSchema } from "./meeting-import.js";
import { projectSelectionMessage, TaskRelatedProjectsSchema, validProjectSelection } from "./project-selection.js";
import { TASK_IMAGE_MAX_BYTES, TASK_IMAGE_MAX_COUNT } from "./types.js";

const title = z.string().trim().min(1).max(200);
const description = z.string().max(20_000);
const projectId = z.string().min(1).max(200).nullable();
const priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const id = z.string().min(1).max(200);
export const TaskImageIdSchema = z.uuid();
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/iu;
const taskImage = z.object({
  id: TaskImageIdSchema,
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(128).regex(MIME_RE),
  sizeBytes: z.number().int().positive().max(TASK_IMAGE_MAX_BYTES),
  kind: z.enum(["image", "file"]).optional(),
});
const newProject = z.object({
  name: z.string().trim().min(1).max(100),
  cwd: z.string().trim().min(1).max(4096).refine((value) => value.startsWith("/"), "项目文件夹必须是绝对路径").optional(),
}).strict();
const relatedProjectIds = TaskRelatedProjectsSchema.optional();

export const TaskCreateSchema = z.object({
  title,
  description: description.optional(),
  projectId: projectId.optional(),
  relatedProjectIds,
  newProject: newProject.optional(),
  priority: priority.optional(),
}).strict().refine(validProjectSelection, projectSelectionMessage);

export const TaskUpdateSchema = z.object({
  id,
  title: title.optional(),
  description: description.optional(),
  retainImageIds: z.array(TaskImageIdSchema).max(TASK_IMAGE_MAX_COUNT).optional(),
  projectId: projectId.optional(),
  relatedProjectIds,
  newProject: newProject.optional(),
  priority: priority.optional(),
}).strict().refine(validProjectSelection, projectSelectionMessage);

const dingtalkSelection = { taskUuid: dingTalkTaskId, ids: z.array(dingTalkActionKey).min(1).max(MEETING_IMPORT_MAX_ITEMS) };
export const TaskActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("project"), projectId: id, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("dingtalk-confirm"), ...dingtalkSelection }).strict(),
  z.object({ action: z.literal("dingtalk-ignore"), ...dingtalkSelection }).strict(),
  z.object({ action: z.literal("dingtalk-sync") }).strict(),
  z.object({ action: z.literal("start"), id }).strict(),
  z.object({ action: z.literal("complete"), id }).strict(),
  z.object({ action: z.literal("retry"), id }).strict(),
  z.object({ action: z.literal("approve"), id, reviewSha: z.string().regex(/^[a-f0-9]{40,64}$/u) }).strict(),
  z.object({ action: z.literal("approveBatch"), id, reviewToken: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  z.object({ action: z.literal("reject"), id, feedback: z.string().trim().min(1).max(10_000) }).strict(),
]);

const runDetails = z.object({
  projectCwd: z.string(), requestId: z.string().optional(),
  threadId: z.string().nullable(), threadUrl: z.string().nullable(), reviewSha: z.string().nullable(),
  summary: z.string(), error: z.string().nullable(),
  pendingFeedback: z.object({ commandId: z.string(), prompt: z.string() }).optional(),
  merged: z.literal(true).optional(),
  requirementKind: z.enum(["requirement", "other", "uncertain"]).optional(),
});

const worktree = z.object({ branch: z.string(), worktreePath: z.string(), baseSha: z.string() });
const batch = z.object({
  token: z.string().nullable(), approved: z.literal(true).optional(),
  repositories: z.array(worktree.extend({
    projectId: id, projectCwd: z.string(),
    phase: z.enum(["pending", "merged", "published", "delivered", "skipping", "skipped"]),
    review: z.object({ headSha: z.string(), baseSha: z.string(), unchanged: z.boolean() }).optional(),
  })),
});

export const TaskRecordSchema = z.object({
  id, title, description, projectId, priority,
  dingtalk: dingTalkMinutesSource.optional(),
  relatedProjectIds,
  images: z.array(taskImage).max(TASK_IMAGE_MAX_COUNT).optional(),
  status: z.enum(["queued", "preparing", "planning", "running", "review", "merging", "done", "failed"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  error: z.string().nullable().optional(),
  worktreeBlock: z.object({ uncommitted: z.number().int().nonnegative(), untracked: z.number().int().nonnegative() }).optional(),
  manual: z.literal(true).optional(),
  completedManually: z.literal(true).optional(),
  run: z.union([
    runDetails.extend({ ...worktree.shape, batch: batch.optional() }),
    runDetails.extend({ branch: z.null(), worktreePath: z.null(), baseSha: z.null() }),
  ]).nullable(),
});

export const TaskStateSchema = z.object({
  version: z.literal(1),
  projects: z.array(z.object({ id, name: z.string(), cwd: z.string(), enabled: z.boolean() })),
  tasks: z.array(TaskRecordSchema),
  meetingImport: StoredMeetingImportSchema.optional(),
  importedDingTalkActions: z.array(dingTalkActionKey).optional(),
  dingtalkInbox: DingTalkInboxSchema.optional(),
  lastMeetingImport: z.object({ id: z.uuid(), revision: z.number().int().nonnegative(), count: z.number().int().positive() }).optional(),
});

export type TaskState = z.infer<typeof TaskStateSchema>;
