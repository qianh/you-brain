import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp } from "../../src/http/server.js";
import { TaskService } from "../../src/tasks/service.js";
import type { TaskAutomationPort, TaskHttpPort } from "../../src/tasks/types.js";

test("TODO routes require auth, validate mutations and retain manual approval boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yb-tasks-http-"));
  const calls: string[] = [];
  const board = { projects: [], tasks: [], connectionError: null };
  const tasks: TaskHttpPort = {
    async board() { calls.push("board"); return board; },
    async create() { calls.push("create"); return board; },
    async update() { calls.push("update"); return board; },
    async action(input) { calls.push(input.action); return board; },
    async review() { throw new Error("not reached"); },
    async image() { throw new Error("not reached"); },
  };
  const server = await startDaemonHttp({ dataDir: dir, deps: { tasks } as unknown as HttpDeps });
  const request = (path: string, method: string, body?: unknown, token = server.token) => fetch(server.baseUrl + path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    expect((await request("/api/tasks", "GET", undefined, "wrong")).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await request("/api/tasks", "DELETE")).status).toBe(405);
    expect((await request("/api/tasks", "POST", { title: "" })).status).toBe(400);
    expect((await request("/api/tasks", "POST", { title: "x", priority: -1 })).status).toBe(400);
    expect((await request("/api/tasks", "PUT", { id: "x", status: "done" })).status).toBe(400);
    expect((await request("/api/tasks/action", "GET")).status).toBe(405);
    expect((await request("/api/tasks/action", "POST", { action: "start", id: "x", cwd: "/override" })).status).toBe(400);
    expect((await request("/api/tasks/action", "POST", { action: "complete" })).status).toBe(400);
    expect((await request("/api/tasks/action", "POST", { action: "approve", id: "x" })).status).toBe(400);
    expect((await request("/api/tasks/action", "POST", { action: "reject", id: "x", feedback: " " })).status).toBe(400);
    expect((await request("/api/tasks/review", "GET")).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await request("/api/tasks", "GET")).status).toBe(200);
    expect((await request("/api/tasks", "POST", { title: "new", projectId: null, priority: 1 })).status).toBe(200);
    expect((await request("/api/tasks/action", "POST", { action: "start", id: "x" })).status).toBe(200);
    expect((await request("/api/tasks/action", "POST", { action: "approve", id: "x", reviewSha: "a".repeat(40) })).status).toBe(200);
    expect((await request("/api/tasks/action", "POST", { action: "complete", id: "x" })).status).toBe(200);
    expect(calls).toEqual(["board", "create", "start", "approve", "complete"]);
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("pasted TODO images survive restart, can be edited, and reach the first T3 message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yb-task-images-"));
  const starts: Array<Parameters<TaskAutomationPort["start"]>[0]> = [];
  const options = {
    dataDir: dir, homeDir: dir,
    automation: {
      async projects() { return []; },
      async createProject() { throw new Error("unexpected project"); },
      async start(input: Parameters<TaskAutomationPort["start"]>[0]) {
        starts.push(input);
        return { threadId: "thread", threadUrl: "http://127.0.0.1:3773/thread" };
      },
      async inspect() { return { state: "planning" as const, summary: "" }; },
      async followup() { throw new Error("unexpected followup"); },
    },
    git: {
      async prepare() { throw new Error("unexpected Git"); },
      async review() { throw new Error("unexpected Git"); },
      async merge() { throw new Error("unexpected Git"); },
      async isMerged() { throw new Error("unexpected Git"); },
      async syncDevelop() { throw new Error("unexpected Git"); },
    },
  };
  const service = new TaskService(options);
  const restarted = new TaskService(options);
  const server = await startDaemonHttp({ dataDir: dir, deps: { tasks: service } as unknown as HttpDeps });
  const auth = { authorization: `Bearer ${server.token}` };
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4wAAAABJRU5ErkJggg==", "base64"));
  const create = (payload: Blob, name = "截图.png") => {
    const body = new FormData();
    body.set("task", JSON.stringify({ title: "贴图", description: "对照截图" }));
    body.append("images", payload, name);
    return fetch(`${server.baseUrl}/api/tasks`, { method: "POST", headers: auth, body });
  };
  try {
    expect((await create(new Blob(["not an image"], { type: "image/png" }))).status).toBe(400);
    const response = await create(new Blob([png], { type: "image/png" }));
    expect(response.status).toBe(200);
    const original = (await service.board()).tasks[0]!;
    const replacedId = original.images![0]!.id;
    const edit = new FormData();
    edit.set("task", JSON.stringify({ id: original.id, retainImageIds: [] }));
    edit.append("images", new Blob([png], { type: "image/png" }), "截图.png");
    expect((await fetch(`${server.baseUrl}/api/tasks`, { method: "PUT", headers: auth, body: edit })).status).toBe(200);
    await expect(stat(join(dir, "tasks", "images", replacedId))).rejects.toMatchObject({ code: "ENOENT" });
    const task = (await restarted.board()).tasks[0]!;
    const image = task.images![0]!;
    expect(task.images).toHaveLength(1);
    expect(image.id).not.toBe(replacedId);
    expect(task.description).toBe("对照截图");
    expect(image).toMatchObject({ name: "截图.png", mimeType: "image/png", sizeBytes: png.length });
    expect(JSON.stringify(await response.json())).not.toContain(Buffer.from(png).toString("base64"));
    const imageUrl = `${server.baseUrl}/api/tasks/image?task=${task.id}&id=${image.id}`;
    expect((await fetch(imageUrl)).status).toBe(401);
    const downloaded = await fetch(imageUrl, { headers: auth });
    expect(downloaded.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(png);
    const updated = await restarted.update({ id: task.id, title: "更新标题" });
    expect(updated.tasks[0]?.images).toEqual([image]);
    await restarted.action({ action: "start", id: task.id });
    expect(starts[0]?.prompt).toContain("对照截图");
    expect(starts[0]?.images?.[0]).toMatchObject({ ...image, bytes: png });
  } finally {
    await server.stop();
    await service.stop();
    await restarted.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
