import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../domain/atomic.js";
import { TaskStateSchema, type TaskState } from "./schema.js";

/** 调用方串行读写；损坏文件报错，绝不覆盖成空队列。 */
export class TaskStore {
  constructor(private readonly path: string) {}

  async read(): Promise<TaskState> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: [], tasks: [] };
      throw error;
    }
    return TaskStateSchema.parse(JSON.parse(text));
  }

  async write(state: TaskState): Promise<void> {
    const data = TaskStateSchema.parse(state);
    await writeFileAtomic(this.path, JSON.stringify(data, null, 2) + "\n");
  }
}
