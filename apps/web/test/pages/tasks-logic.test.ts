import { describe, expect, test } from "bun:test";
import type { DevelopmentTask } from "../../../../packages/core/src/tasks/types.js";
import { folderName, projectPickerRows, projectTask, taskThreadUrl, visibleTasks } from "../../src/pages/tasks/logic.js";

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

  test("project picker searches by name, offers a new project for unknown names and hides paths unless names clash", () => {
    const projects = [
      { id: "a", name: "legal-ai", cwd: "/Users/me/Dzg/ai/legal-ai", enabled: false },
      { id: "b", name: "you-brain", cwd: "/Users/me/John/ai/you-brain", enabled: false },
      { id: "c", name: "you-brain", cwd: "/Users/me/Work/you-brain/", enabled: false },
      { id: "d", name: "chat-legal", cwd: "/x/chat-legal", enabled: false },
    ];
    expect(projectPickerRows(projects, "", true).map((row) => row.kind)).toEqual(["none", "project", "project", "project", "project", "folder"]);
    expect(projectPickerRows(projects, "  LEGAL", false).map((row) => row.kind === "project" ? row.project.id : row.kind)).toEqual(["a", "d", "create"]);
    expect(projectPickerRows(projects, "Legal-AI", false).some((row) => row.kind === "create")).toBe(false);
    expect(projectPickerRows(projects, "you", false).flatMap((row) => row.kind === "project" ? [row.hint] : [])).toEqual(["ai", "Work"]);
    expect(projectPickerRows(projects, "legal", false).flatMap((row) => row.kind === "project" ? [row.hint] : [])).toEqual([null, null]);
    expect(projectPickerRows([], " New App ", false)).toEqual([{ kind: "create", name: "New App" }]);
    expect(folderName("/Users/me/new-app/")).toBe("new-app");
  });
});
