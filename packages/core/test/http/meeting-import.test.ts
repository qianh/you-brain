import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp } from "../../src/http/server.js";
import { LlmRequestError } from "../../src/llm/errors.js";
import type { LlmBackend } from "../../src/llm/types.js";
import { TaskService, type TaskServiceOptions } from "../../src/tasks/service.js";
import { TaskStore } from "../../src/tasks/store.js";
import type { MeetingImportAction, MeetingImportResult } from "../../src/tasks/types.js";

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
      async start(input) { dispatched.push(input.title); return { threadId: "thread", threadUrl: "http://localhost:3773/thread" }; },
      async inspect() { return { state: "planning", summary: "" }; },
      followup: unexpected,
    },
    git: {
      async prepare(_project, taskId) { return { branch: `task/${taskId}`, worktreePath: dataDir, baseSha: "base" }; },
      isMerged: unexpected, review: unexpected, merge: unexpected, syncDevelop: unexpected, publish: unexpected, cleanup: unexpected,
    },
  };
  return {
    options, replies, params, dispatched,
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
