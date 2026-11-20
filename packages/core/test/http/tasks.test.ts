import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp } from "../../src/http/server.js";
import type { TaskHttpPort } from "../../src/tasks/types.js";

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
