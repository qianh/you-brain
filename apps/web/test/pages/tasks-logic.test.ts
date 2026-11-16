import { describe, expect, test } from "bun:test";
import type { DevelopmentTask } from "../../../../packages/core/src/tasks/types.js";
import { projectTask, taskThreadUrl, visibleTasks } from "../../src/pages/tasks/logic.js";

function task(id: string, patch: Partial<DevelopmentTask> = {}): DevelopmentTask {
  return { id, title: id, description: "", priority: 2, projectId: "one", status: "queued", createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z", run: null, ...patch };
}

describe("TODO queue presentation", () => {
  test("keeps priority then creation order, and filters projects by exact id", () => {
    const tasks = [task("p3", { priority: 3 }), task("p0-new", { priority: 0, createdAt: "2026-11-16T01:00:00Z" }), task("p0-old", { priority: 0 }), task("other", { priority: 0, projectId: "two" }), task("no-project", { projectId: null })];
    expect(visibleTasks(tasks, "one", "all").map((item) => item.id)).toEqual(["p0-old", "p0-new", "p3"]);
    expect(visibleTasks(tasks, "unassigned", "all").map((item) => item.id)).toEqual(["no-project"]);
    expect(tasks[0]?.id).toBe("p3");
  });

  test("review and failures are blockers rather than active execution", () => {
    const tasks = [task("waiting", { status: "review" }), task("running", { status: "running", projectId: "two" }), task("preparing", { status: "preparing", projectId: "three" }), task("done", { status: "done" })];
    expect(projectTask(tasks, "one")?.id).toBe("waiting");
    expect(visibleTasks(tasks, "all", "active").map((item) => item.id)).toEqual(["running", "preparing"]);
    expect(visibleTasks(tasks, "one", "review").map((item) => item.id)).toEqual(["waiting"]);
  });

  test("only offers local HTTP T3 links without embedded credentials", () => {
    expect(taskThreadUrl("http://127.0.0.1:3773/thread/task-id")).toBe("http://127.0.0.1:3773/thread/task-id");
    expect(taskThreadUrl("https://[::1]:3773/thread/task-id")).toBe("https://[::1]:3773/thread/task-id");
    for (const url of ["javascript:alert(1)", "file:///tmp/task", "https://example.com/thread", "http://user:pass@localhost:3773/thread", "not-a-url", null]) expect(taskThreadUrl(url)).toBeNull();
  });
});
