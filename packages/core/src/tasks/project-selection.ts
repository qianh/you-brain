import { z } from "zod";
import { TASK_PROJECT_MAX_COUNT } from "./types.js";

export const TaskRelatedProjectsSchema = z.array(z.string().min(1).max(200)).max(TASK_PROJECT_MAX_COUNT - 1)
  .refine((ids) => new Set(ids).size === ids.length, "不能重复关联项目");

export function validProjectSelection(body: { projectId?: string | null | undefined; relatedProjectIds?: string[] | undefined; newProject?: unknown }): boolean {
  return !(body.newProject !== undefined && body.projectId) &&
    (!body.relatedProjectIds?.length || (!!body.projectId && !body.newProject && !body.relatedProjectIds.includes(body.projectId)));
}

export const projectSelectionMessage = { message: "已有项目与新建项目只能二选一；关联多个项目时须指定一个主项目，且不能重复" };
