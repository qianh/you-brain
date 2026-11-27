import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp } from "../../src/http/server.js";
import { LlmRequestError } from "../../src/llm/errors.js";
import type { LlmBackend } from "../../src/llm/types.js";
import { createDingTalkMinutes, DingTalkMinutesError } from "../../src/tasks/dingtalk-minutes.js";
import { TaskService, type TaskServiceOptions } from "../../src/tasks/service.js";
import { TaskStore } from "../../src/tasks/store.js";
import type { MeetingImportAction, MeetingImportResult, TaskActionInput, TaskAutomationPort, TaskBoard } from "../../src/tasks/types.js";

const notes = "决定：新增导出按钮。\n决定：补齐导入回归测试。\n是否增加报表仍待讨论。\n只存在于原文的内部备忘。";
const item = (title: string, quote: string | null = null, previousId: string | null = null, projectName: string | null = null, relatedProjectNames: string[] | null = null) => ({
  title, description: `交付：${title}`, source: quote ? "meeting" : "user", quote, previousId, projectName, relatedProjectNames,
});
const answer = (items: ReturnType<typeof item>[], clarification: string | null = null) => JSON.stringify({
  items, clarification, questions: ["是否增加报表？"], message: "已整理可执行事项。",
});
const unexpected = async (): Promise<never> => { throw new Error("unexpected side effect"); };

function fixture(dataDir: string) {
  const params: Array<Parameters<LlmBackend["complete"]>[0]> = [];
  const replies: Array<string | Error | Promise<string>> = [];
  const dispatched: string[] = [];
  const launches: Array<Parameters<TaskAutomationPort["start"]>[0]> = [];
  let projectAvailable = true;
  let rejectSave = false;
  const store = new TaskStore(join(dataDir, "tasks", "board.json"));
  const llm: LlmBackend = {
    id: "fixture",
    descriptor: { kind: "openai-compatible", provider: "ollama", model: "fixture", baseUrl: "http://localhost:11434/v1", requiresApiKey: false, jsonMode: "json_schema" },
    async complete(request) {
      params.push(request);
      const reply = await replies.shift();
      if (typeof reply !== "string") throw reply ?? new Error("unexpected model call");
      return reply;
    },
    test: unexpected,
  };
  let current = llm;
  const options: TaskServiceOptions = {
    dataDir, meetingModel: () => current,
    store: { read: () => store.read(), write: async (state) => {
      if (rejectSave) throw new Error("unwritable test store");
      await store.write(state);
    } },
    automation: {
      async projects() { return projectAvailable ? [{ id: "alpha", name: "Alpha", cwd: dataDir }, { id: "beta", name: "Beta", cwd: join(dataDir, "beta") }] : []; },
      createProject: unexpected,
      async start(input) { dispatched.push(input.title); launches.push(input); return { threadId: "thread", threadUrl: "http://localhost:3773/thread" }; },
      async inspect() { return { state: "planning", summary: "" }; },
      followup: unexpected,
    },
    git: {
      async prepare(_project, taskId) { return { branch: `task/${taskId}`, worktreePath: dataDir, baseSha: "base" }; },
      isMerged: unexpected, review: unexpected, merge: unexpected, syncDevelop: unexpected, publish: unexpected, cleanup: unexpected,
    },
  };
  return {
    options, replies, params, dispatched, launches,
    rejectWrite: (value: boolean) => { rejectSave = value; },
    removeProject: () => { projectAvailable = false; },
    setModel: (descriptor: Partial<LlmBackend["descriptor"]>) => { current = { ...llm, descriptor: { ...llm.descriptor, ...descriptor } }; },
  };
}

test("confirmed meeting import survives restart, handles conversational edits, and queues only selected tasks once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yb-meeting-import-"));
  const fixtureData = fixture(dataDir);
  let service = new TaskService(fixtureData.options);
  const tasks = { board: () => service.board() };
  const meetingImport = {
    meetingImport: () => service.meetingImport(),
    meetingImportAction: (input: MeetingImportAction) => service.meetingImportAction(input),
  };
  const server = await startDaemonHttp({ dataDir, deps: { tasks, meetingImport } as unknown as HttpDeps });
  const request = (body?: MeetingImportAction | object, token = server.token, path = "/api/tasks/meeting-import") => fetch(server.baseUrl + path, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  const send = async (body: MeetingImportAction): Promise<MeetingImportResult> => {
    const response = await request(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    return await response.json() as MeetingImportResult;
  };
  const boardPath = join(dataDir, "tasks", "board.json");

  try {
    expect((await request(undefined, "invalid")).status).toBe(401);
    expect((await request({ action: "import", fileName: "empty.md", text: " " })).status).toBe(400);
    expect((await request({ action: "import", fileName: "bad.pdf", text: notes })).status).toBe(400);
    expect((await request({ action: "import", fileName: "big.txt", text: "测".repeat(22_000) })).status).toBe(400);
    expect((await request({ action: "import", fileName: "big.txt", text: "x".repeat(410_000) })).status).toBe(413);
    await service.action({ action: "project", projectId: "alpha", enabled: true });
    const imported = await send({ action: "import", fileName: "评审.md", text: notes });
    expect(imported.draft).toMatchObject({ fileName: "评审.md", analysed: false, items: [] });
    expect(imported.draft).not.toHaveProperty("text");
    expect(fixtureData.params).toHaveLength(0);
    expect(await (await request(undefined, server.token, "/api/tasks")).text()).not.toContain("内部备忘");
    expect(await readFile(boardPath, "utf8")).toContain("内部备忘");
    const modelKey = imported.model!.consentKey!;
    const { id, revision } = imported.draft!;
    expect((await request({ action: "import", fileName: "overwrite.txt", text: "new" })).status).toBe(409);
    expect((await request({ action: "confirm", id, revision })).status).toBe(400);

    fixtureData.replies.push(answer([item("导出按钮", "新增导出按钮"), item("导入回归", "补齐导入回归测试")]));
    let draft = (await send({ action: "analyse", id, revision, consentKey: modelKey })).draft!;
    expect(draft.items).toHaveLength(2);
    expect(draft.items.every((row) => row.selected && row.priority === 2 && row.projectId === null)).toBe(true);
    expect(draft.questions).toEqual(["是否增加报表？"]);
    expect(fixtureData.params[0]?.user).toContain("内部备忘");
    expect((await service.board()).tasks).toEqual([]);
    expect(fixtureData.dispatched).toEqual([]);

    const initialItems = draft.items;
    fixtureData.replies.push(new LlmRequestError("auth", notes));
    expect((await request({ action: "revise", id, revision: draft.revision, consentKey: modelKey, feedback: "整理优先级" })).status).toBe(502);
    expect((await service.meetingImport()).draft).toEqual(draft);
    fixtureData.replies.push(answer([], "要合并哪两项？"));
    draft = (await send({ action: "revise", id, revision: draft.revision, consentKey: modelKey, feedback: "合并一下，安排到 Alpha" })).draft!;
    expect(draft.items).toEqual(initialItems);
    expect(draft.clarification).toBe("要合并哪两项？");
    await service.stop();
    service = new TaskService(fixtureData.options);
    expect((await service.meetingImport()).draft).toEqual(draft);

    fixtureData.replies.push(answer([item("导出功能及回归", "新增导出按钮", initialItems[0]!.id, "Alpha", ["Beta"]), item("灰度验证")]));
    draft = (await send({ action: "revise", id, revision: draft.revision, consentKey: modelKey, feedback: "合并第 1、2 项，关联 Beta，保持 Alpha 为主项目。另加一项灰度验证。" })).draft!;
    expect(draft.items).toMatchObject([{ title: "导出功能及回归", projectId: "alpha", relatedProjectIds: ["beta"] }, { title: "灰度验证", source: "user", quote: null }]);
    expect(draft.clarification).toBeNull();
    expect(fixtureData.params.at(-1)?.user).toContain("合并一下，安排到 Alpha");

    const previousRevision = draft.revision;
    draft = (await send({ action: "select", id, revision: draft.revision,
      items: draft.items.map(({ id: itemId, projectId }, index) => ({ id: itemId, projectId, priority: 1, selected: index === 0, relatedProjectIds: index === 0 ? ["beta"] : [] })),
    })).draft!;
    expect((await request({ action: "confirm", id, revision: previousRevision })).status).toBe(409);
    expect(fixtureData.dispatched).toEqual([]);

    const confirm = { action: "confirm", id, revision: draft.revision } as const;
    fixtureData.rejectWrite(true);
    expect((await request(confirm)).status).toBe(500);
    fixtureData.rejectWrite(false);
    expect((await service.board()).tasks).toEqual([]);
    expect((await service.meetingImport()).draft).toEqual(draft);
    const result = await send(confirm);
    expect(result.draft).toBeNull();
    expect(result.created).toMatchObject({ count: 1, board: { tasks: [{ title: "导出功能及回归", priority: 1, projectId: "alpha", relatedProjectIds: ["beta"] }] } });
    await service.tick();
    expect(fixtureData.dispatched).toEqual(["导出功能及回归"]);
    expect(await readFile(boardPath, "utf8")).not.toContain("内部备忘");
    await service.stop();
    service = new TaskService(fixtureData.options);
    expect((await send(confirm)).created?.count).toBe(1);
    expect((await service.board()).tasks).toHaveLength(1);
  } finally {
    await server.stop();
    await service.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DingTalk list and link share a local draft, persist action receipts and dispatch confirmed tasks in plan mode", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yb-dingtalk-import-"));
  const fixtureData = fixture(dataDir);
  const taskUuid = "meeting-123";
  const entry = { taskUuid, title: "迭代评审", startTime: 1795750000000 };
  const argsLog: string[][] = [];
  let actions: unknown[] = [{ minutesTodoId: "a1", content: "修复导入状态" }, "补齐页面测试", "补齐页面测试"];
  let detailError: DingTalkMinutesError | null = null;
  const dingtalkMinutes = createDingTalkMinutes({ async run(args) {
    argsLog.push(args);
    if (args[1] === "+list-all") return { ok: true, data: { minutes: [entry] }, meta: { pagination: args.includes("--cursor=page-2") ? { endpoint_exhausted: true } : { endpoint_exhausted: false, next_token: "page-2" } } };
    if (detailError) throw detailError;
    return { complete: true, taskUuid, basic: { success: true, result: { taskUuid, title: entry.title } },
      todos: { success: true, result: { taskUuid, state: actions.length ? "ready" : "known_empty", items: actions, signedUrl: "private-fixture-url" } } };
  } });
  const options = { ...fixtureData.options, dingtalkMinutes };
  let service = new TaskService(options);
  const meetingImport = {
    meetingImport: () => service.meetingImport(),
    meetingImportAction: (input: MeetingImportAction) => service.meetingImportAction(input),
    listDingTalkMinutes: (input: Parameters<typeof service.listDingTalkMinutes>[0]) => service.listDingTalkMinutes(input),
  };
  const server = await startDaemonHttp({ dataDir, deps: { meetingImport } as unknown as HttpDeps });
  const base = `${server.baseUrl}/api/tasks/meeting-import`;
  const request = (body?: MeetingImportAction, status = 200) => fetch(base, {
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  }).then(async (response) => {
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    return await response.json() as MeetingImportResult;
  });
  const list = (suffix: string, token = server.token) => fetch(`${base}/dingtalk${suffix}`, { headers: { authorization: `Bearer ${token}` } });
  const boardPath = join(dataDir, "tasks", "board.json");
  const pasted = { action: "import-dingtalk", url: `https://shanji.dingtalk.com/app/transcribes/${taskUuid}?shareKey=private-fixture-url` } as const;
  const fromList = { action: "import-dingtalk", taskUuid } as const;

  try {
    expect((await list("", "invalid")).status).toBe(401);
    expect((await list(`?query=${"x".repeat(201)}`)).status).toBe(400);
    expect(argsLog).toHaveLength(0);
    const first = await list("?query=%E8%AF%84%E5%AE%A1");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ items: [entry], nextCursor: "page-2" });
    expect(await (await list("?cursor=page-2")).json()).toEqual({ items: [entry], nextCursor: null });
    expect(argsLog.slice(0, 2)).toEqual([["minutes", "+list-all", "--limit=20", "--query=评审"], ["minutes", "+list-all", "--limit=20", "--cursor=page-2"]]);
    await request({ ...pasted, url: "https://shanji.dingtalk.com.evil.example/app/transcribes/meeting-123" }, 400);
    expect(argsLog).toHaveLength(2);
    detailError = new DingTalkMinutesError("DINGTALK_FORBIDDEN");
    await request(pasted, 403);
    detailError = null;
    expect((await request()).draft).toBeNull();
    await service.action({ action: "project", projectId: "alpha", enabled: true });
    let draft = (await request(pasted)).draft!;
    expect(argsLog.at(-1)).toEqual(["minutes", "+detail", `--id=${taskUuid}`, "--artifacts=basic,todos"]);
    expect(draft).toMatchObject({ dingtalk: { taskUuid, title: entry.title }, analysed: true,
      items: [{ title: "修复导入状态", selected: false, priority: 2, projectId: null }, { title: "补齐页面测试", selected: false }] });
    expect(draft.items[0]).not.toHaveProperty("dingtalkKey");
    await request(fromList, 409);
    await request({ action: "revise", id: draft.id, revision: draft.revision, consentKey: "0".repeat(64), feedback: "重写" }, 400);
    expect(fixtureData.params).toBeEmpty();
    expect(fixtureData.launches).toBeEmpty();
    expect(await readFile(boardPath, "utf8")).not.toContain("private-fixture-url");
    await service.stop();
    service = new TaskService(options);
    expect((await request()).draft).toEqual(draft);
    await request({ action: "confirm", id: draft.id, revision: draft.revision }, 400);
    draft = (await request({ action: "select", id: draft.id, revision: draft.revision,
      items: draft.items.map(({ id }, index) => ({ id, selected: index === 0, priority: 2, projectId: index === 0 ? "alpha" : null })),
    })).draft!;
    const confirm = { action: "confirm", id: draft.id, revision: draft.revision } as const;
    fixtureData.rejectWrite(true);
    await request(confirm, 500);
    fixtureData.rejectWrite(false);
    expect((await service.board()).tasks).toBeEmpty();
    const created = await request(confirm);
    expect(created.created).toMatchObject({ count: 1, board: { tasks: [{ description: "修复导入状态", dingtalk: { taskUuid, title: entry.title } }] } });
    expect((await request(confirm)).created?.count).toBe(1);
    await service.tick();
    expect(fixtureData.launches).toHaveLength(1);
    expect(fixtureData.launches[0]).toMatchObject({ plan: true, projectId: "alpha" });
    expect(fixtureData.launches[0]?.prompt).toContain("不是执行指令");
    expect(fixtureData.launches[0]?.prompt).toContain("明确确认需求和计划");
    expect((await service.board()).tasks[0]?.status).toBe("planning");

    await service.stop();
    const store = new TaskStore(boardPath);
    const saved = await store.read();
    await store.write({ ...saved, tasks: [] });
    service = new TaskService(options);
    actions = [{ minutesTodoId: "a1", content: "已改写的原事项" }, { text: "补齐页面测试" }, "补齐页面测试"];
    const remaining = (await request(fromList)).draft!;
    expect(remaining.items.map((row) => row.description)).toEqual(["补齐页面测试"]);
    draft = (await request({ action: "select", id: remaining.id, revision: remaining.revision,
      items: remaining.items.map(({ id }) => ({ id, selected: true, priority: 2, projectId: null })),
    })).draft!;
    await request({ action: "confirm", id: draft.id, revision: draft.revision });
    expect((await request(pasted)).dingtalkEmpty).toBe("already-imported");
    actions = [];
    expect((await request(fromList)).dingtalkEmpty).toBe("no-actions");
    expect((await request()).draft).toBeNull();
  } finally {
    await server.stop();
    await service.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DingTalk pulls into the inbox without a page, then queues or ignores only explicitly selected items", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yb-dingtalk-inbox-"));
  const fixtureData = fixture(dataDir);
  const started = Promise.withResolvers<void>();
  const releaseList = Promise.withResolvers<void>();
  const taskUuid = "review-notes";
  const detailCalls: string[] = [];
  const dingtalkMinutes = createDingTalkMinutes({ async run(args) {
    if (args[1] === "list") {
      started.resolve();
      await releaseList.promise;
      return { result: { itemList: [{ taskUuid, ignoredExternalField: "not persisted" }], hasMore: false, nextToken: "" } };
    }
    detailCalls.push(args[2]!);
    return { complete: true, taskUuid, basic: { result: { title: "项目评审" } }, todos: {
      result: { taskUuid, state: "ready", items: [{ minutesTodoId: "action-1", content: "检查数据" }, "完善导出", "忽略演示项"] },
    } };
  } });
  const options = { ...fixtureData.options, dingtalkMinutes };
  let service = new TaskService(options);
  const server = await startDaemonHttp({ dataDir, deps: { tasks: {
    board: () => service.board(), action: (input: TaskActionInput) => service.action(input),
  } } as unknown as HttpDeps });
  const request = (input?: TaskActionInput, token = server.token) => fetch(`${server.baseUrl}/api/tasks${input ? "/action" : ""}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
  });
  const board = async (): Promise<TaskBoard> => {
    const response = await request();
    expect(response.status).toBe(200);
    return await response.json() as TaskBoard;
  };

  try {
    await service.action({ action: "project", projectId: "alpha", enabled: true });
    const draft = (await service.meetingImportAction({ action: "import", fileName: "notes.txt", text: notes })).draft;
    service.start();
    await started.promise;
    expect((await board()).dingtalkInbox).toMatchObject({ syncing: true, meetings: [] });
    releaseList.resolve();
    await service.syncDingTalk();
    expect(detailCalls).toEqual([`--id=${taskUuid}`]);
    expect((await request(undefined, "invalid")).status).toBe(401);
    const pulled = await board();
    expect(pulled.tasks).toEqual([]);
    expect((await service.meetingImport()).draft).toEqual(draft);
    expect(fixtureData.params).toBeEmpty();
    expect(fixtureData.launches).toBeEmpty();
    const [meeting] = pulled.dingtalkInbox!.meetings;
    expect(meeting?.source).toEqual({ taskUuid, title: "项目评审" });
    const manual = meeting!.items[0]!.id;
    const toQueue = meeting!.items[1]!.id;
    const toIgnore = meeting!.items[2]!.id;
    await service.meetingImportAction({ action: "discard", id: draft!.id, revision: draft!.revision });
    let imported = (await service.meetingImportAction({ action: "import-dingtalk", taskUuid })).draft!;
    imported = (await service.meetingImportAction({ action: "select", id: imported.id, revision: imported.revision,
      items: imported.items.map(({ id }, index) => ({ id, selected: index === 0, priority: 2, projectId: null })),
    })).draft!;
    await service.meetingImportAction({ action: "confirm", id: imported.id, revision: imported.revision });
    expect((await board()).dingtalkInbox?.meetings[0]?.items.map((row) => row.id)).toEqual([toQueue, toIgnore]);

    const confirm: TaskActionInput = { action: "dingtalk-confirm", taskUuid, ids: [toQueue] };
    expect((await request({ ...confirm, ids: [manual, toQueue] })).status).toBe(409);
    expect((await request(confirm, "invalid")).status).toBe(401);
    await expect(service.action(confirm, () => {})).rejects.toMatchObject({ status: 403 });
    fixtureData.rejectWrite(true);
    expect((await request(confirm)).status).toBe(500);
    fixtureData.rejectWrite(false);
    expect((await board()).tasks).toHaveLength(1);
    expect((await request(confirm)).status).toBe(200);
    expect((await request(confirm)).status).toBe(409);
    expect((await request({ action: "dingtalk-ignore", taskUuid, ids: [toIgnore] })).status).toBe(200);
    const completed = await board();
    expect(completed.dingtalkInbox?.meetings).toBeEmpty();
    expect(completed.tasks).toMatchObject([
      { description: "检查数据", projectId: null, status: "queued", dingtalk: { taskUuid } },
      { description: "完善导出", projectId: null, status: "queued", dingtalk: { taskUuid } },
    ]);
    await service.tick();
    expect(fixtureData.launches).toBeEmpty();
    await service.stop();
    service = new TaskService(options);
    const readsBeforeRestart = detailCalls.length;
    await service.syncDingTalk();
    expect(detailCalls).toHaveLength(readsBeforeRestart);
    expect((await board()).dingtalkInbox?.meetings).toBeEmpty();
    expect((await board()).tasks).toEqual(completed.tasks);
  } finally {
    releaseList.resolve();
    await server.stop();
    await service.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DingTalk incrementally resumes list windows and retries unfinished details after restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yb-dingtalk-checkpoint-"));
  const { options: base } = fixture(dataDir);
  const started = Date.parse("2026-11-27T01:00:00.000Z");
  let now = started;
  let ready = false;
  let authorized = false;
  const listCalls: string[][] = [];
  const details: string[] = [];
  const dingtalkMinutes = createDingTalkMinutes({ async run(args) {
    if (!authorized) throw new DingTalkMinutesError("DINGTALK_AUTH_REQUIRED");
    if (args[1] === "list") {
      listCalls.push(args);
      const shared = args[2] === "shared";
      if (shared) return { result: { itemList: [] } };
      if (args.includes("--cursor=next")) return { result: { itemList: [{ taskUuid: "newer" }], nextToken: "", hasNext: false } };
      const taskUuid = now === started ? "recent" : "delayed";
      return { result: { itemList: [{ taskUuid }], nextToken: now === started ? "old-history" : "next", hasMore: true } };
    }
    const taskUuid = args[2]!.slice("--id=".length);
    details.push(taskUuid);
    if (taskUuid === "delayed" && !ready) return { complete: false, taskUuid };
    return { complete: true, taskUuid, basic: { result: { title: taskUuid } },
      todos: { result: { taskUuid, state: "ready", items: [`行动项 ${taskUuid}`] } } };
  } });
  const options = { ...base, dingtalkMinutes, now: () => new Date(now) };
  let service = new TaskService(options);

  try {
    await service.syncDingTalk();
    expect((await service.board()).dingtalkInbox).toMatchObject({ lastSyncedAt: null, error: expect.stringContaining("dws auth login") });
    authorized = true;
    await service.syncDingTalk();
    expect(listCalls[0]).toEqual(["minutes", "list", "mine", "--limit=20", "--start=2026-11-26T01:00:00.000Z", "--end=2026-11-27T01:00:00.000Z"]);
    expect(listCalls.flat()).not.toContain("--cursor=old-history");
    expect((await service.board()).dingtalkInbox).toMatchObject({ lastSyncedAt: "2026-11-27T01:00:00.000Z", error: null });
    now += 5 * 60_000;
    await service.syncDingTalk();
    expect(listCalls[2]).toContain("--start=2026-11-27T00:30:00.000Z");
    expect((await service.board()).dingtalkInbox).toMatchObject({ lastSyncedAt: "2026-11-27T01:00:00.000Z", error: expect.any(String) });
    expect(details).toEqual(["recent", "delayed"]);
    await service.stop();

    now += 10 * 60_000;
    ready = true;
    service = new TaskService(options);
    await service.syncDingTalk();
    expect(listCalls[4]).toEqual([...listCalls[2]!, "--cursor=next"]);
    expect(listCalls).toHaveLength(5);
    expect(details).toEqual(["recent", "delayed", "delayed", "newer"]);
    const board = await service.board();
    expect(board.tasks).toBeEmpty();
    expect(board.dingtalkInbox).toMatchObject({ lastSyncedAt: "2026-11-27T01:05:00.000Z", error: null });
    expect(board.dingtalkInbox?.meetings.map((meeting) => meeting.source.taskUuid)).toEqual(["newer", "delayed", "recent"]);
  } finally {
    await service.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("DingTalk CLI maps business errors without exposing subprocess output", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yb-dingtalk-cli-"));
  const executable = join(dataDir, "dws");
  const cli = createDingTalkMinutes({ homeDir: dataDir, env: { PATH: dataDir } });
  const cases = [
    [{ category: "auth", code: 2, message: "private fixture details" }, 2, "DINGTALK_AUTH_REQUIRED"],
    [{ ok: false, error: { type: "auth", server_error_code: "CLI_ORG_NOT_AUTHORIZED", message: "private fixture details" } }, 2, "DINGTALK_FORBIDDEN"],
    [{ ok: false, error: { reason: "deadline_exceeded", message: "private fixture details" } }, 1, "DINGTALK_TIMEOUT"],
    [{ ok: true, data: { unknown: ["private fixture details"] } }, 0, "DINGTALK_BAD_RESPONSE"],
  ] as const;
  try {
    for (const [payload, exitCode, code] of cases) {
      await writeFile(executable, `#!/bin/sh\nprintf '%s' '${JSON.stringify(payload)}' ${exitCode ? ">&2" : ""}\nexit ${exitCode}\n`, { mode: 0o700 });
      await expect(cli.list({})).rejects.toMatchObject({ code, message: expect.not.stringContaining("private fixture details") });
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("meeting draft is preserved on model failure, refuses changed or tool-capable models, and can be discarded", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yb-meeting-model-"));
  const fixtureData = fixture(dataDir);
  const service = new TaskService(fixtureData.options);
  try {
    const { draft, model } = await service.meetingImportAction({ action: "import", fileName: "notes.txt", text: notes });
    const analyse = { action: "analyse", id: draft!.id, revision: draft!.revision, consentKey: model!.consentKey! } as const;
    fixtureData.setModel({ provider: "codex-cli", kind: "cli" });
    await expect(service.meetingImportAction(analyse)).rejects.toMatchObject({ status: 503 });
    fixtureData.setModel({ model: "another" });
    await expect(service.meetingImportAction(analyse)).rejects.toMatchObject({ status: 409 });
    expect(fixtureData.params).toHaveLength(0);
    fixtureData.setModel({});
    fixtureData.replies.push(new LlmRequestError("auth", notes));
    await expect(service.meetingImportAction(analyse)).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining("内部备忘") });
    expect((await service.meetingImport()).draft).toEqual(draft);

    fixtureData.replies.push(answer([]));
    const empty = (await service.meetingImportAction(analyse)).draft!;
    expect(empty).toMatchObject({ analysed: true, items: [], questions: ["是否增加报表？"] });
    await expect(service.meetingImportAction({ action: "confirm", id: empty.id, revision: empty.revision })).rejects.toMatchObject({ status: 400 });
    expect((await service.meetingImportAction({ action: "discard", id: empty.id, revision: empty.revision })).draft).toBeNull();
    expect(await readFile(join(dataDir, "tasks", "board.json"), "utf8")).not.toContain("内部备忘");
  } finally {
    await service.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("confirm rechecks projects without partially creating a mixed batch", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yb-meeting-project-"));
  const fixtureData = fixture(dataDir);
  const service = new TaskService(fixtureData.options);
  try {
    await service.board();
    const { draft, model } = await service.meetingImportAction({ action: "import", fileName: "notes.txt", text: notes });
    fixtureData.replies.push(answer([item("导入回归", "补齐导入回归测试"), item("导出按钮", "新增导出按钮")]));
    const analysed = (await service.meetingImportAction({ action: "analyse", id: draft!.id, revision: draft!.revision, consentKey: model!.consentKey! })).draft!;
    const selected = (await service.meetingImportAction({ action: "select", id: analysed.id, revision: analysed.revision,
      items: analysed.items.map(({ id, priority }, index) => ({ id, priority, selected: true, projectId: index === 0 ? "alpha" : null })),
    })).draft!;
    fixtureData.removeProject();
    await expect(service.meetingImportAction({ action: "confirm", id: selected.id, revision: selected.revision })).rejects.toMatchObject({ status: 409 });
    expect((await service.board()).tasks).toEqual([]);
    expect((await service.meetingImport()).draft).toEqual(selected);
  } finally {
    await service.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("in-flight analysis does not block the queue or resurrect a discarded draft", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yb-meeting-in-flight-"));
  const fixtureData = fixture(dataDir);
  const service = new TaskService(fixtureData.options);
  const modelReply = Promise.withResolvers<string>();
  try {
    const { draft, model } = await service.meetingImportAction({ action: "import", fileName: "notes.txt", text: notes });
    fixtureData.replies.push(modelReply.promise);
    const analysis = service.meetingImportAction({ action: "analyse", id: draft!.id, revision: draft!.revision, consentKey: model!.consentKey! });
    const result = analysis.catch((error: unknown) => error);
    expect((await service.create({ title: "手动创建的 TODO" })).tasks).toHaveLength(1);
    expect(fixtureData.params).toHaveLength(1);
    await service.meetingImportAction({ action: "discard", id: draft!.id, revision: draft!.revision });
    expect(fixtureData.params[0]?.signal?.aborted).toBe(true);
    modelReply.resolve(answer([item("导出按钮", "新增导出按钮")]));
    expect(await result).toMatchObject({ status: 409 });
    expect((await service.meetingImport()).draft).toBeNull();
    expect((await service.board()).tasks.map((task) => task.title)).toEqual(["手动创建的 TODO"]);
  } finally {
    modelReply.resolve(answer([]));
    await service.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
