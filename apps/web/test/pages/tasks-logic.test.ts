import { describe, expect, test } from "bun:test";
import type { DevelopmentTask } from "../../../../packages/core/src/tasks/types.js";
import { folderName, formatAttachmentSize, projectPickerRows, projectTask, projectTasks, taskCounts, taskStatusKey, taskThreadHref, taskThreadUrl, taskWorktreeHint, visibleTasks } from "../../src/pages/tasks/logic.js";
import { t3FrameSrc } from "../../src/lib/t3-frame.js";
import { clipboardTaskImages } from "../../src/pages/tasks/images.js";

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

  test("planning counts as active, unlike review and failures", () => {
    const tasks = [task("waiting", { status: "review" }), task("running", { status: "running", projectId: "two" }), task("preparing", { status: "preparing", projectId: "three" }), task("planning", { status: "planning", projectId: null }), task("failed", { status: "failed" }), task("done", { status: "done" })];
    expect(projectTask(tasks, "one")?.id).toBe("waiting");
    expect(visibleTasks(tasks, "all", "active").map((item) => item.id)).toEqual(["running", "preparing", "planning"]);
    expect(visibleTasks(tasks, "one", "review").map((item) => item.id)).toEqual(["waiting"]);
  });

  test("project card lists unfinished tasks with running ones first", () => {
    const tasks = [task("failed", { status: "failed" }), task("waiting", { status: "review" }), task("queued"), task("planning", { status: "planning" }), task("running", { status: "running" }), task("done", { status: "done" })];
    expect(projectTasks(tasks, "one").map((item) => item.id)).toEqual(["planning", "running", "waiting", "failed"]);
  });

  test("all counts every status within the selected project", () => {
    const tasks = [task("queued"), task("failed", { status: "failed" }), task("review", { status: "review" }), task("merging", { status: "merging" }), task("done", { status: "done", projectId: "two" }), task("unassigned", { projectId: null })];
    expect(taskCounts(tasks, "all")).toEqual({ all: 6, queued: 2, active: 1, review: 1, done: 1 });
    expect(taskCounts(tasks, "one")).toEqual({ all: 4, queued: 1, active: 1, review: 1, done: 0 });
    expect(taskCounts(tasks, "unassigned")).toEqual({ all: 1, queued: 1, active: 0, review: 0, done: 0 });
    expect(visibleTasks(tasks, "one", "all").map((item) => item.id)).toContain("failed");
  });

  test("the completed view shows task status regardless of how it was completed", () => {
    const tasks = [task("manual", { status: "done", completedManually: true }), task("merged", { status: "done", manual: true }), task("no-project", { status: "done", projectId: null }), task("queued")];
    expect(taskCounts(tasks, "all").done).toBe(3);
    const completed = visibleTasks(tasks, "all", "done");
    expect(completed.map((item) => item.id)).toEqual(["manual", "merged", "no-project"]);
    expect(completed.map(taskStatusKey)).toEqual(["tasksDone", "tasksDone", "tasksDone"]);
  });

  test("worktree blockers show the ended run and exact counts, unlike T3 failures", () => {
    const onlyUntracked = { uncommitted: 0, untracked: 1 };
    expect(taskStatusKey(task("blocked", { status: "failed", worktreeBlock: onlyUntracked }))).toBe("tasksWorktreeBlocked");
    expect(taskStatusKey(task("failed", { status: "failed" }))).toBe("tasksFailed");
    expect(taskWorktreeHint(onlyUntracked, "zh")).toBe("等待处理 1 个未跟踪文件。请在 T3 中确认后重新检查。");
    expect(taskWorktreeHint({ uncommitted: 2, untracked: 0 }, "zh")).toContain("等待处理 2 个有未提交改动的文件");
    expect(taskWorktreeHint({ uncommitted: 2, untracked: 3 }, "zh")).toContain("2 个有未提交改动的文件和 3 个未跟踪文件");
    expect(taskWorktreeHint(onlyUntracked, "en")).toBe("Resolve untracked files (1). Check these files in T3, then recheck.");
  });

  test("only offers local HTTP T3 links without embedded credentials", () => {
    expect(taskThreadUrl("http://127.0.0.1:3773/thread/task-id")).toBe("http://127.0.0.1:3773/thread/task-id");
    expect(taskThreadUrl("https://[::1]:3773/thread/task-id")).toBe("https://[::1]:3773/thread/task-id");
    for (const url of ["javascript:alert(1)", "file:///tmp/task", "https://example.com/thread", "http://user:pass@localhost:3773/thread", "not-a-url", null]) expect(taskThreadUrl(url)).toBeNull();
  });

  test("routes a saved TODO conversation to the matching thread in the deck iframe", () => {
    const url = "http://127.0.0.1:3773/desk/thread-123";
    const route = new URL(taskThreadHref(url)!, "http://localhost:3921");
    expect(route.pathname).toBe("/deck");
    expect(t3FrameSrc({ url: "http://127.0.0.1:3773", frameUrl: "http://127.0.0.1:3922" }, route.searchParams.get("t3Thread")))
      .toBe("http://127.0.0.1:3922/desk/thread-123");
    const remoteRoute = new URL(taskThreadHref(url, "dev-vps")!, "http://localhost:3921");
    expect(remoteRoute.searchParams.get("device")).toBe("dev-vps");
    expect(t3FrameSrc({ url: "http://127.0.0.1:19888", frameUrl: "http://127.0.0.1:19888" }, remoteRoute.searchParams.get("t3Thread"), true))
      .toBe("http://127.0.0.1:19888/desk/thread-123");
    expect(taskThreadHref("https://example.com/thread")).toBeNull();
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(2048)).toBe("2.0 KB");
    expect(formatAttachmentSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  test("accepts pasted screenshots from both clipboard layouts and leaves text alone", () => {
    const screenshot = new File(["png"], "clipboard.png", { type: "image/png" });
    const image = { kind: "file", type: "image/png", getAsFile: () => screenshot };
    const text = { kind: "string", type: "text/plain", getAsFile: () => null };
    const clipboard = (files: File[], items: Array<typeof image | typeof text>) => ({ files, items }) as unknown as DataTransfer;
    expect(clipboardTaskImages(clipboard([screenshot], [image, text]))).toEqual([screenshot]);
    expect(clipboardTaskImages(clipboard([], [image, text]))).toEqual([screenshot]);
    expect(clipboardTaskImages(clipboard([], [text]))).toEqual([]);
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
