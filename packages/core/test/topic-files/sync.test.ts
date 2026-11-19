import { posix } from "node:path";

import { DRIVE_PATHS, topicDetailPath, topicHistoryPath } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { topicFilesStep, type ConsolidationContext } from "../../src/consolidate/index.js";
import type { DriveEntry, DriveObject, DrivePort, DrivePutInput, DriveUpdateOptions } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { driveFileUrl } from "../../src/output/render.js";
import {
  assignTopicFileStems,
  sanitizeTopicFileName,
  topicIdDigest8,
  topicManifestKey,
  topicZonePath,
} from "../../src/topic-files/names.js";
import {
  TOPIC_FILES_MANIFEST,
  TOPIC_FILES_SWEPT_AT,
  syncTopicFiles,
  type TopicFilesManifestStore,
  type TopicFilesResult,
  type TopicFilesSyncInput,
} from "../../src/topic-files/sync.js";
import type { TopicBook } from "../../src/topics/types.js";
import { assigned, created, ev, fold, key, SHANGHAI } from "../consolidate/fixture.js";

const NOW = "2026-10-23T02:00:00.000Z";
const RECENT = "2026-10-22T02:00:00.000Z";

class MemManifest implements TopicFilesManifestStore {
  raw: string | null = null;

  get(): string | null {
    return this.raw;
  }

  set(value: string): void {
    this.raw = value;
  }
}

class RecordingDrive extends MemoryDrive {
  readonly calls = { create: 0, update: 0, move: 0, upsert: 0, trash: 0, findByPath: 0, list: 0 };
  failCreatePath: string | null = null;
  failTrash = false;
  failRead = false;
  failList = false;

  resetCalls(): void {
    this.calls.create = 0;
    this.calls.update = 0;
    this.calls.move = 0;
    this.calls.upsert = 0;
    this.calls.trash = 0;
    this.calls.findByPath = 0;
    this.calls.list = 0;
  }

  override async list(query: Parameters<DrivePort["list"]>[0]): Promise<DriveEntry[]> {
    this.calls.list += 1;
    if (this.failList) throw new Error("list down");
    return super.list(query);
  }

  override async findByPath(path: string): Promise<DriveEntry | null> {
    this.calls.findByPath += 1;
    return super.findByPath(path);
  }

  override async create(input: DrivePutInput): Promise<DriveEntry> {
    this.calls.create += 1;
    if (this.failCreatePath !== null && input.path === this.failCreatePath) {
      throw new Error("drive down");
    }
    return super.create(input);
  }

  override async update(
    fileId: string,
    content: Buffer | string,
    options?: DriveUpdateOptions,
  ): Promise<DriveEntry> {
    this.calls.update += 1;
    if (options) return super.update(fileId, content, options);
    return super.update(fileId, content);
  }

  override async upsert(input: DrivePutInput): Promise<DriveEntry> {
    this.calls.upsert += 1;
    return super.upsert(input);
  }

  override async move(id: string, path: string): Promise<DriveEntry> {
    this.calls.move += 1;
    return super.move(id, path);
  }

  override async trash(id: string): Promise<void> {
    this.calls.trash += 1;
    if (this.failTrash) throw new Error("trash down");
    return super.trash(id);
  }

  override async read(id: string): Promise<DriveObject> {
    if (this.failRead) throw new Error("missing file");
    return super.read(id);
  }
}

function zeroWrites(drive: RecordingDrive): void {
  expect({
    create: drive.calls.create,
    update: drive.calls.update,
    move: drive.calls.move,
    upsert: drive.calls.upsert,
    trash: drive.calls.trash,
  }).toEqual({ create: 0, update: 0, move: 0, upsert: 0, trash: 0 });
}

async function publish(
  drive: DrivePort,
  book: TopicBook,
  manifest: MemManifest,
  options?: {
    language?: TopicFilesSyncInput["language"];
    sessionUpdatedAt?: Readonly<Record<string, string>>;
    timeZone?: string;
    now?: string;
    sweptAt?: TopicFilesManifestStore;
  },
): Promise<TopicFilesResult> {
  return syncTopicFiles({
    drive,
    book,
    language: options?.language ?? "zh",
    timeZone: options?.timeZone ?? SHANGHAI,
    zone: {
      now: options?.now ?? NOW,
      activeLimit: 10,
      historyDays: 30,
      ...(options?.sessionUpdatedAt ? { sessionUpdatedAt: options.sessionUpdatedAt } : {}),
    },
    manifest,
    ...(options?.sweptAt ? { sweptAt: options.sweptAt } : {}),
  });
}

async function markdown(drive: DrivePort, path: string): Promise<string> {
  const object = await drive.readPath(path);
  if (!object) throw new Error(`missing ${path}`);
  return object.bytes.toString("utf8");
}

function refinedFile(session: string, title: string, fileId: string, ts: string) {
  return ev(
    "session.refined",
    {
      sessionKey: session,
      fileId,
      source: "claude-code",
      title,
      summary: "",
      refinedUpTo: 1,
    },
    ts,
  );
}

function richBook(): { book: TopicBook; sessionUpdatedAt: Record<string, string> } {
  const alpha = key(1);
  const bare = key(2);
  const events = [
    created("alpha", "甲", "2026-10-01T00:00:00.000Z", ["别名甲", "别名乙"]),
    created("beta", "乙", "2026-10-01T00:00:01.000Z"),
    refinedFile(alpha, "标题甲", "file-alpha", "2026-10-01T00:00:02.000Z"),
    refinedFile(bare, "只有标题", "file-beta", "2026-10-01T00:00:03.000Z"),
    assigned("alpha", alpha, "2026-10-01T00:00:04.000Z"),
    assigned("alpha", bare, "2026-10-01T00:00:05.000Z"),
    ev(
      "topic.summary_rewritten",
      { topicId: "alpha", summary: "这一行概要", nextStep: "去写文件" },
      "2026-10-01T00:00:06.000Z",
    ),
    ev(
      "conclusion.added",
      { conclusionId: "c-old", topicId: "alpha", text: "旧结论", sessionKey: alpha },
      "2020-01-01T03:04:00.000Z",
    ),
    ev(
      "conclusion.added",
      { conclusionId: "c-new", topicId: "alpha", text: "新结论", sessionKey: alpha },
      "2020-01-02T03:04:00.000Z",
    ),
    ev(
      "todo.added",
      { todoId: "todo-open", topicId: "alpha", text: "还没做", sessionKey: alpha, confidence: 1 },
      "2026-10-02T00:00:00.000Z",
    ),
    ev(
      "todo.added",
      { todoId: "todo-done", topicId: "alpha", text: "做完了", sessionKey: alpha, confidence: 1 },
      "2026-10-02T00:00:01.000Z",
    ),
    ev(
      "todo.status_changed",
      { todoId: "todo-done", status: "done", by: "auto" },
      "2026-10-02T00:00:02.000Z",
    ),
    ev(
      "topic.status_changed",
      { topicId: "beta", status: "done", by: "user" },
      "2026-09-01T00:00:00.000Z",
    ),
  ];
  const book = fold(events);
  const untitled = book.sessions.find((session) => session.title === "只有标题");
  if (!untitled) throw new Error("missing untitled session");
  untitled.fileId = "";
  return { book, sessionUpdatedAt: { [alpha]: RECENT } };
}

describe("topic files", () => {
  it("creates detail files and an overview whose links are those file ids", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const { book, sessionUpdatedAt } = richBook();
    expect(book.topics.find((topic) => topic.topicId === "beta")?.userLocked).toBe(true);

    const first = await publish(drive, book, manifest, { sessionUpdatedAt });
    expect(first.failed).toBe(0);
    expect(first.written).toBeGreaterThan(0);

    const alpha = await drive.findByPath(topicDetailPath("alpha"));
    const beta = await drive.findByPath(topicHistoryPath("beta"));
    expect(alpha).not.toBeNull();
    expect(beta).not.toBeNull();
    const alphaUrl = driveFileUrl(alpha!.id);
    const betaUrl = driveFileUrl(beta!.id);
    const alphaText = await markdown(drive, topicDetailPath("alpha"));
    const betaText = await markdown(drive, topicHistoryPath("beta"));
    const overview = await markdown(drive, DRIVE_PATHS.topicsLatest);
    expect(alphaText).toBe(
      [
        "# 甲",
        "",
        "- 别名：别名甲、别名乙",
        "- 状态：进行中",
        "- 概要：这一行概要",
        "- 下一步：去写文件",
        "- 未完成待办：",
        "  - 还没做",
        "- 全部结论：",
        "  - 新结论（2020-01-02 11:04）",
        "  - 旧结论（2020-01-01 11:04）",
        "- 相关会话：",
        `  - [标题甲](${driveFileUrl("file-alpha")})`,
        "  - 只有标题",
        "",
      ].join("\n"),
    );
    expect(betaText).toBe(
      [
        "# 乙",
        "",
        "- 别名：无",
        "- 状态：已完结",
        "- 概要：无",
        "- 下一步：无",
        "- 未完成待办：无",
        "- 全部结论：无",
        "- 相关会话：无",
        "",
      ].join("\n"),
    );
    expect(overview).toBe(
      [
        "# 话题",
        "",
        "## 活跃",
        "",
        `### [甲](${alphaUrl})`,
        "- 状态：进行中",
        "- 概要：这一行概要",
        "- 下一步：去写文件",
        "",
        "## 历史",
        "",
        `- [乙](${betaUrl})`,
        "",
      ].join("\n"),
    );
    expect(alphaText.includes(NOW)).toBe(false);
    expect(betaText.includes(NOW)).toBe(false);
    expect(overview.includes(NOW)).toBe(false);
    expect(alphaText.includes("做完了")).toBe(false);
    expect(alpha?.mimeType).toBe("text/markdown");

    drive.resetCalls();
    const again = await publish(drive, book, manifest, { sessionUpdatedAt });
    expect(again).toMatchObject({ written: 0, moved: 0, trashed: 0, failed: 0 });
    expect(again.unchanged).toBeGreaterThan(0);
    zeroWrites(drive);
    expect(await markdown(drive, DRIVE_PATHS.topicsLatest)).toBe(overview);
  });

  it("updates the same file when the name or summary changes", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const session = key(3);
    const events = [
      created("alpha", "甲", "2026-10-01T00:00:00.000Z"),
      refinedFile(session, "标题", "file-a", "2026-10-01T00:00:01.000Z"),
      assigned("alpha", session, "2026-10-01T00:00:02.000Z"),
      ev(
        "topic.summary_rewritten",
        { topicId: "alpha", summary: "旧概要", nextStep: "下一步" },
        "2026-10-01T00:00:03.000Z",
      ),
    ];
    const sessionUpdatedAt = { [session]: RECENT };
    await publish(drive, fold(events), manifest, { sessionUpdatedAt });
    const before = await drive.findByPath(topicDetailPath("alpha"));
    expect(before).not.toBeNull();
    drive.resetCalls();

    const renamed = fold([
      ...events,
      ev(
        "topic.renamed",
        { topicId: "alpha", name: "甲改", aliases: ["别名甲"] },
        "2026-10-20T00:00:00.000Z",
      ),
      ev(
        "topic.summary_rewritten",
        { topicId: "alpha", summary: "新概要", nextStep: "下一步" },
        "2026-10-20T00:00:01.000Z",
      ),
    ]);
    const result = await publish(drive, renamed, manifest, { sessionUpdatedAt });
    expect(result.failed).toBe(0);
    expect(result.moved).toBe(0);
    const after = await drive.findByPath(topicDetailPath("alpha"));
    expect(after?.id).toBe(before?.id);
    expect(drive.calls.create).toBe(0);
    expect(drive.calls.move).toBe(0);
    expect(drive.calls.update).toBeGreaterThan(0);
    const text = await markdown(drive, topicDetailPath("alpha"));
    expect(text.startsWith("# 甲改\n")).toBe(true);
    expect(text.includes("新概要")).toBe(true);
    expect(text.includes(NOW)).toBe(false);
  });

  it("moves a topic into history and back without changing the file id", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const session = key(4);
    const book = fold([
      created("move-me", "搬家", "2026-01-01T00:00:00.000Z"),
      refinedFile(session, "会话", "file-m", "2026-01-01T00:00:01.000Z"),
      assigned("move-me", session, "2026-01-01T00:00:02.000Z"),
    ]);
    await publish(drive, book, manifest, { sessionUpdatedAt: { [session]: RECENT } });
    const active = await drive.findByPath(topicDetailPath("move-me"));
    expect(active).not.toBeNull();
    expect(await drive.findByPath(topicHistoryPath("move-me"))).toBeNull();

    drive.resetCalls();
    const toHistory = await publish(drive, book, manifest);
    expect(toHistory.moved).toBe(1);
    expect(toHistory.failed).toBe(0);
    const history = await drive.findByPath(topicHistoryPath("move-me"));
    expect(history?.id).toBe(active?.id);
    expect(await drive.findByPath(topicDetailPath("move-me"))).toBeNull();
    expect(drive.calls.move).toBe(1);
    expect(drive.calls.create).toBe(0);

    drive.resetCalls();
    const back = await publish(drive, book, manifest, { sessionUpdatedAt: { [session]: RECENT } });
    expect(back.moved).toBe(1);
    const returned = await drive.findByPath(topicDetailPath("move-me"));
    expect(returned?.id).toBe(active?.id);
    expect(await drive.findByPath(topicHistoryPath("move-me"))).toBeNull();
    expect(drive.calls.move).toBe(1);
    expect(drive.calls.create).toBe(0);
  });

  it("trashes a merged topic and drops it from the overview", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const events = [
      created("keep-id", "留下", "2026-01-01T00:00:00.000Z"),
      created("drop-id", "去掉", "2026-01-01T00:00:01.000Z"),
    ];
    await publish(drive, fold(events), manifest);
    expect(await drive.findByPath(topicHistoryPath("drop-id"))).not.toBeNull();
    expect(await drive.findByPath(topicHistoryPath("keep-id"))).not.toBeNull();

    const merged = fold([
      ...events,
      ev(
        "topic.merged",
        { fromTopicId: "drop-id", intoTopicId: "keep-id" },
        "2026-01-02T00:00:00.000Z",
      ),
    ]);
    drive.resetCalls();
    const result = await publish(drive, merged, manifest);
    expect(result.failed).toBe(0);
    expect(result.trashed).toBeGreaterThan(0);
    expect(await drive.findByPath(topicHistoryPath("drop-id"))).toBeNull();
    expect(await drive.findByPath(topicDetailPath("drop-id"))).toBeNull();
    expect(await drive.findByPath(topicHistoryPath("keep-id"))).not.toBeNull();
    const overview = await markdown(drive, DRIVE_PATHS.topicsLatest);
    expect(overview.includes("去掉")).toBe(false);
    expect(overview.includes("留下")).toBe(true);
    const saved = JSON.parse(manifest.raw ?? "{}") as Record<string, unknown>;
    expect(saved["drop-id"]).toBeUndefined();
  });

  it("adopts existing files when the manifest is missing or corrupt", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const book = fold([created("alpha", "甲", "2026-01-01T00:00:00.000Z")]);
    await publish(drive, book, manifest);
    const fileId = (await drive.findByPath(topicHistoryPath("alpha")))?.id;
    const overviewId = (await drive.findByPath(DRIVE_PATHS.topicsLatest))?.id;
    const before = (await drive.list({ prefix: "topics/" })).length;

    manifest.raw = null;
    drive.resetCalls();
    const lost = await publish(drive, book, manifest);
    expect(lost.failed).toBe(0);
    expect(drive.calls.create).toBe(0);
    expect(drive.calls.update).toBeGreaterThan(0);
    expect((await drive.findByPath(topicHistoryPath("alpha")))?.id).toBe(fileId);
    expect((await drive.findByPath(DRIVE_PATHS.topicsLatest))?.id).toBe(overviewId);
    expect((await drive.list({ prefix: "topics/" })).length).toBe(before);

    manifest.raw = "{";
    drive.resetCalls();
    const corrupt = await publish(drive, book, manifest);
    expect(corrupt.failed).toBe(0);
    expect(drive.calls.create).toBe(0);
    expect((await drive.findByPath(topicHistoryPath("alpha")))?.id).toBe(fileId);
    expect((await drive.list({ prefix: "topics/" })).length).toBe(before);
    expect(manifest.raw?.includes(fileId ?? "")).toBe(true);
  });

  it("keeps going when one topic write throws, and the step throws", async () => {
    const drive = new RecordingDrive();
    drive.failCreatePath = topicHistoryPath("bad-id");
    const manifest = new MemManifest();
    const book = fold([
      created("good-id", "好", "2026-01-01T00:00:00.000Z"),
      created("bad-id", "坏", "2026-01-01T00:00:01.000Z"),
      created("later-id", "后", "2026-01-01T00:00:02.000Z"),
    ]);
    const result = await publish(drive, book, manifest);
    expect(result.failed).toBe(1);
    expect(await drive.findByPath(topicHistoryPath("good-id"))).not.toBeNull();
    expect(await drive.findByPath(topicHistoryPath("later-id"))).not.toBeNull();
    expect(await drive.findByPath(topicHistoryPath("bad-id"))).toBeNull();
    expect(await drive.findByPath(DRIVE_PATHS.topicsLatest)).not.toBeNull();
    const saved = JSON.parse(manifest.raw ?? "{}") as Record<string, { fileId?: string }>;
    expect(saved[topicManifestKey("good-id")]?.fileId).toBeTruthy();
    expect(saved[topicManifestKey("later-id")]?.fileId).toBeTruthy();
    expect(saved[topicManifestKey("bad-id")]).toBeUndefined();
    const overview = await markdown(drive, DRIVE_PATHS.topicsLatest);
    expect(overview.includes("好")).toBe(true);
    expect(overview.includes("后")).toBe(true);

    const warnings: string[] = [];
    const ctx = {
      warnings,
      topicFiles: () => publish(drive, book, manifest),
    } as ConsolidationContext;
    await expect(topicFilesStep.run(ctx)).rejects.toThrow("部分话题文件没有写完");
    expect(warnings.some((warning) => warning.includes("bad-id"))).toBe(true);
    expect(warnings.includes("话题文件有 1 个没有写上")).toBe(true);
    const kept = JSON.parse(manifest.raw ?? "{}") as Record<string, { fileId?: string }>;
    expect(kept[topicManifestKey("good-id")]?.fileId).toBe(saved[topicManifestKey("good-id")]?.fileId);
    expect(kept[topicManifestKey("bad-id")]).toBeUndefined();

    const quiet: string[] = [];
    await topicFilesStep.run({ warnings: quiet } as ConsolidationContext);
    expect(quiet).toEqual([]);
  });

  it("records a trash failure and still finishes the other files", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    manifest.raw = JSON.stringify({
      ghost: { fileId: "file-ghost", zone: "history", hash: "abc123" },
    });
    drive.failTrash = true;
    drive.failRead = true;
    const book = fold([created("alpha", "甲", "2026-01-01T00:00:00.000Z")]);
    const result = await publish(drive, book, manifest);
    expect(result.failed).toBe(0);
    expect(result.warnings.some((warning) => warning.includes("没有删掉"))).toBe(true);
    expect(await drive.findByPath(topicHistoryPath("alpha"))).not.toBeNull();
    const saved = JSON.parse(manifest.raw ?? "{}") as Record<string, unknown>;
    expect(saved.ghost).toBeUndefined();

    const warnings: string[] = [];
    await topicFilesStep.run({
      warnings,
      topicFiles: async () => result,
    } as ConsolidationContext);
    expect(warnings.some((warning) => warning.includes("没有删掉"))).toBe(true);
  });

  it("keeps the manifest entry when trash fails and the file is still there", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const book = fold([created("alpha", "甲", "2026-01-01T00:00:00.000Z")]);
    await publish(drive, book, manifest);
    const fileId = (await drive.findByPath(topicHistoryPath("alpha")))?.id;
    drive.failTrash = true;
    drive.resetCalls();
    const result = await publish(drive, fold([]), manifest);
    expect(result.failed).toBe(0);
    expect(result.warnings.some((warning) => warning.includes("没有删掉"))).toBe(true);
    expect((await drive.findByPath(topicHistoryPath("alpha")))?.id).toBe(fileId);
    const saved = JSON.parse(manifest.raw ?? "{}") as Record<string, { fileId?: string }>;
    expect(saved[topicManifestKey("alpha")]?.fileId).toBe(fileId);
  });

  it("sanitizes topic ids and keeps every path inside topics/", async () => {
    const ids = ["a/b", "a b", "..", ".", "TOPICS-latest", "../etc", "中文", "ok", " ", "/"];
    expect(sanitizeTopicFileName("a/b c")).toBe("a_b_c");
    expect(sanitizeTopicFileName("中文")).toBe("__");
    expect(sanitizeTopicFileName("../etc")).toBe(".._etc");
    const stems = assignTopicFileStems(ids);
    expect(stems.get("a/b")).toBe(`a_b-${topicIdDigest8("a/b")}`);
    expect(stems.get("a b")).toBe(`a_b-${topicIdDigest8("a b")}`);
    expect(stems.get("a/b")).not.toBe(stems.get("a b"));
    expect(stems.get("..")).toBe(`..-${topicIdDigest8("..")}`);
    expect(stems.get(".")).toBe(`.-${topicIdDigest8(".")}`);
    expect(stems.get("TOPICS-latest")).toBe(`TOPICS-latest-${topicIdDigest8("TOPICS-latest")}`);
    expect(stems.get("../etc")).toBe(".._etc");
    expect(stems.get("中文")).toBe("__");
    expect(stems.get("ok")).toBe("ok");
    expect(stems.get(" ")).toBe(`_-${topicIdDigest8(" ")}`);
    expect(stems.get("/")).toBe(`_-${topicIdDigest8("/")}`);

    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const book = fold(
      ids.map((id, index) =>
        created(id, `话题${index + 1}`, `2026-01-01T00:00:0${Math.min(index, 9)}.000Z`),
      ),
    );
    const result = await publish(drive, book, manifest);
    expect(result.failed).toBe(0);
    const files = await drive.list({ prefix: "topics/" });
    expect(files.filter((file) => file.path !== DRIVE_PATHS.topicsLatest)).toHaveLength(ids.length);
    expect(await drive.findByPath("topics/TOPICS-latest.md")).not.toBeNull();
    expect(await drive.findByPath(topicHistoryPath("TOPICS-latest"))).toBeNull();
    for (const file of files) {
      const normal = posix.normalize(file.path);
      expect(normal).toBe(file.path);
      expect(normal.startsWith("topics/")).toBe(true);
      expect(normal.split("/").includes("..")).toBe(false);
    }
    const left = await drive.findByPath(topicZonePath("history", stems.get("a/b") ?? ""));
    const right = await drive.findByPath(topicZonePath("history", stems.get("a b") ?? ""));
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left?.id).not.toBe(right?.id);
  });

  it("uses the english labels", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const book = fold([
      created("alpha", "Alpha", "2026-01-01T00:00:00.000Z", ["One", "Two"]),
      ev(
        "conclusion.added",
        { conclusionId: "c1", topicId: "alpha", text: "Done it", sessionKey: key(9) },
        "2020-01-02T03:04:00.000Z",
      ),
    ]);
    await publish(drive, book, manifest, { language: "en" });
    const text = await markdown(drive, topicHistoryPath("alpha"));
    expect(text.includes("- Aliases: One, Two")).toBe(true);
    expect(text.includes("- Status: Active")).toBe(true);
    expect(text.includes("- All conclusions:")).toBe(true);
    expect(text.includes("Done it (2020-01-02 11:04)")).toBe(true);
    const overview = await markdown(drive, DRIVE_PATHS.topicsLatest);
    expect(overview.includes("## Active")).toBe(true);
    expect(overview.includes("## History")).toBe(true);
  });

  it("stores the manifest under the cursor key name", () => {
    expect(TOPIC_FILES_MANIFEST).toBe("topicfiles.manifest");
    expect(TOPIC_FILES_SWEPT_AT).toBe("topicfiles.swept_at");
  });

  it("does not call findByPath or list for historical merged topics when manifest is intact and recently swept", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const sweptAt = new MemManifest();
    const events = [created("keep", "主话题", "2026-01-01T00:00:00.000Z")];
    for (let i = 0; i < 100; i += 1) {
      events.push(
        created(`old-${i}`, `旧话题${i}`, "2026-01-01T00:00:01.000Z"),
        ev("topic.merged", { fromTopicId: `old-${i}`, intoTopicId: "keep" }, "2026-01-02T00:00:00.000Z"),
      );
    }
    const book = fold(events);
    await publish(drive, book, manifest, { sweptAt });
    expect(sweptAt.raw).toBe(NOW);

    drive.resetCalls();
    const again = await publish(drive, book, manifest, {
      sweptAt,
      now: "2026-10-23T12:00:00.000Z",
    });
    expect(again.failed).toBe(0);
    expect(drive.calls.findByPath).toBe(0);
    expect(drive.calls.list).toBe(0);
    zeroWrites(drive);
  });

  it("adopts existing files and sweeps merged residuals in a single list when manifest is lost or corrupt", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const sweptAt = new MemManifest();
    const events = [
      created("keep", "留下", "2026-01-01T00:00:00.000Z"),
      created("drop", "去掉", "2026-01-01T00:00:01.000Z"),
    ];
    await publish(drive, fold(events), manifest, { sweptAt });
    const keepId = (await drive.findByPath(topicHistoryPath("keep")))?.id;
    expect(await drive.findByPath(topicHistoryPath("drop"))).not.toBeNull();

    const merged = fold([
      ...events,
      ev("topic.merged", { fromTopicId: "drop", intoTopicId: "keep" }, "2026-01-02T00:00:00.000Z"),
    ]);

    manifest.raw = null;
    drive.resetCalls();
    const recovered = await publish(drive, merged, manifest, { sweptAt });
    expect(recovered.failed).toBe(0);
    expect(recovered.trashed).toBe(1);
    expect(drive.calls.list).toBe(1);
    expect(drive.calls.findByPath).toBe(0);
    expect((await drive.findByPath(topicHistoryPath("keep")))?.id).toBe(keepId);
    expect(await drive.findByPath(topicHistoryPath("drop"))).toBeNull();
  });

  it("sweeps orphan merged files via a single list when sweptAt is older than 24 hours", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const sweptAt = new MemManifest();
    const events = [
      created("keep", "留下", "2026-01-01T00:00:00.000Z"),
      created("orphan", "另一设备合并", "2026-01-01T00:00:01.000Z"),
      ev("topic.merged", { fromTopicId: "orphan", intoTopicId: "keep" }, "2026-01-02T00:00:00.000Z"),
    ];
    const book = fold(events);
    await publish(drive, book, manifest, { sweptAt });

    // Simulate an orphan file left behind on Drive by another main device, absent from local manifest.
    await drive.create({
      path: topicHistoryPath("orphan"),
      bytes: Buffer.from("# orphan\n", "utf8"),
      mimeType: "text/markdown",
    });

    sweptAt.raw = "2026-10-22T01:59:59.000Z";
    drive.resetCalls();
    const result = await publish(drive, book, manifest, { sweptAt, now: NOW });
    expect(result.failed).toBe(0);
    expect(result.trashed).toBe(1);
    expect(drive.calls.list).toBe(1);
    expect(drive.calls.findByPath).toBe(0);
    expect(sweptAt.raw).toBe(NOW);
    expect(await drive.findByPath(topicHistoryPath("orphan"))).toBeNull();
  });

  it("records a warning without failing or advancing sweptAt when list throws during sweep", async () => {
    const drive = new RecordingDrive();
    const manifest = new MemManifest();
    const sweptAt = new MemManifest();
    const events = [
      created("keep", "留下", "2026-01-01T00:00:00.000Z"),
      created("old", "旧", "2026-01-01T00:00:01.000Z"),
      ev("topic.merged", { fromTopicId: "old", intoTopicId: "keep" }, "2026-01-02T00:00:00.000Z"),
    ];
    const book = fold(events);
    await publish(drive, book, manifest, { sweptAt });

    const staleSweep = "2026-10-20T00:00:00.000Z";
    sweptAt.raw = staleSweep;
    drive.failList = true;
    drive.resetCalls();
    const result = await publish(drive, book, manifest, { sweptAt, now: NOW });
    expect(result.failed).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(sweptAt.raw).toBe(staleSweep);
  });
});
