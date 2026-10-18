import { createHash } from "node:crypto";

import { describe, expect, it } from "bun:test";

import { inboxAppProperties, conversationKey } from "@you-brain/protocol";

import { ConflictError } from "../../src/drive/errors.js";
import type { DrivePort, DrivePutInput, DriveUpdateOptions } from "../../src/drive/drive-port.js";
import type { DriveEntry, DriveListQuery } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { ChecksumMismatchError } from "../../src/upload/checksum.js";
import { UploadService } from "../../src/upload/upload-service.js";
import type {
  UploadIndex,
  UploadRecordMeta,
  UploadableSession,
} from "../../src/upload/types.js";

class MemoryIndex implements UploadIndex {
  readonly records = new Map<string, { fileId: string; meta: UploadRecordMeta }>();

  fileIdOf(key: string): string | null {
    return this.records.get(key)?.fileId ?? null;
  }

  record(key: string, fileId: string, meta: UploadRecordMeta): void {
    this.records.set(key, { fileId, meta });
  }
}

function markdown(turnCount: number, body: string): string {
  return `---\nturn_count: ${turnCount}\n---\n\n${body}\n`;
}

function session(overrides: Partial<UploadableSession> = {}): UploadableSession {
  return {
    source: "claude-code",
    conversationId: "conv-1",
    device: "mac",
    title: "Hello",
    startedAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T04:00:00.000Z",
    messageCount: 1,
    markdown: markdown(1, "hello"),
    ...overrides,
  };
}

function keyOf(value: UploadableSession = session()): string {
  return conversationKey(value.source, value.conversationId);
}

function service(
  drive: DrivePort,
  index: UploadIndex = new MemoryIndex(),
  options: { deviceId?: string; maxAttempts?: number; clock?: { now(): number } } = {},
): UploadService {
  return new UploadService({
    drive,
    index,
    deviceId: options.deviceId ?? "device-a",
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
}

function wrap(drive: MemoryDrive, overrides: Partial<DrivePort>): DrivePort {
  return new Proxy(drive, {
    get(target, property, receiver) {
      if (typeof property === "string" && Object.hasOwn(overrides, property)) {
        return overrides[property as keyof DrivePort];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DrivePort;
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("in-place session upload", () => {
  it("creates a session once and keeps the fileId across later updates", async () => {
    const drive = new MemoryDrive();
    const index = new MemoryIndex();
    const uploader = service(drive, index);
    const key = keyOf();
    const first = await uploader.upload(session());
    const secondBody = markdown(2, "hello again");
    const second = await uploader.upload(
      session({
        markdown: secondBody,
        messageCount: 2,
        updatedAt: "2026-01-02T05:00:00.000Z",
      }),
    );
    const thirdBody = markdown(3, "still going");
    const third = await uploader.upload(
      session({
        markdown: thirdBody,
        messageCount: 3,
        updatedAt: "2026-01-02T06:00:00.000Z",
      }),
    );

    expect(second.fileId).toBe(first.fileId);
    expect(third.fileId).toBe(first.fileId);
    expect(index.fileIdOf(key)).toBe(first.fileId);
    const stored = await drive.read(first.fileId);
    expect(stored.bytes.toString("utf8")).toBe(thirdBody);
    expect(stored.md5Checksum).toBe(
      createHash("md5").update(thirdBody).digest("hex"),
    );
    expect(stored.appProperties).toMatchObject({
      brainhubKey: key,
      source: "claude-code",
      conversationId: "conv-1",
      deviceId: "device-a",
      updatedAt: "2026-01-02T06:00:00.000Z",
      ybSchema: "1",
    });
    expect(stored.appProperties.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await drive.findByAppProperty("brainhubKey", key)).toHaveLength(1);
  });

  it("renames when the title changes and keeps the fileId", async () => {
    const drive = new MemoryDrive();
    const uploader = service(drive);
    const first = await uploader.upload(session({ title: "Alpha" }));
    const second = await uploader.upload(
      session({
        title: "Beta Notes",
        markdown: markdown(2, "renamed"),
        messageCount: 2,
        updatedAt: "2026-01-02T05:00:00.000Z",
      }),
    );

    expect(second.fileId).toBe(first.fileId);
    expect(second.renamed).toBe(true);
    expect(second.path.endsWith("-beta-notes.md")).toBe(true);
    expect(second.path).not.toBe(first.path);
    expect((await drive.read(first.fileId)).id).toBe(first.fileId);
    expect(await drive.findByAppProperty("brainhubKey", keyOf())).toHaveLength(1);
  });

  it("converges duplicate creates onto the earliest file and the newer body", async () => {
    let tick = 0;
    const drive = new MemoryDrive({
      now: () => new Date(Date.UTC(2026, 0, 2, 0, 0, tick++)),
    });
    const key = keyOf();
    const olderBody = markdown(1, "old");
    const newerBody = markdown(4, "new");
    const older = await drive.create({
      path: "inbox/mac/claude-code-20260102-conv1-hello.md",
      bytes: Buffer.from(olderBody),
      mimeType: "text/markdown",
      appProperties: inboxAppProperties({
        brainhubKey: key,
        source: "claude-code",
        conversationId: "conv-1",
        deviceId: "device-a",
        updatedAt: "2026-01-02T04:00:00.000Z",
        contentSha256: createHash("sha256").update(olderBody).digest("hex"),
      }),
    });
    await drive.create({
      path: "inbox/mac/duplicate.md",
      bytes: Buffer.from(newerBody),
      mimeType: "text/markdown",
      appProperties: inboxAppProperties({
        brainhubKey: key,
        source: "claude-code",
        conversationId: "conv-1",
        deviceId: "device-b",
        updatedAt: "2026-01-02T08:00:00.000Z",
        contentSha256: createHash("sha256").update(newerBody).digest("hex"),
      }),
    });

    const result = await service(drive, new MemoryIndex(), {
      deviceId: "device-a",
    }).upload(
      session({
        markdown: olderBody,
        messageCount: 1,
        updatedAt: "2026-01-02T04:00:00.000Z",
      }),
    );

    expect(result.fileId).toBe(older.id);
    expect(result.trashedIds).toHaveLength(1);
    const files = await drive.findByAppProperty("brainhubKey", key);
    expect(files.map((file) => file.id)).toEqual([older.id]);
    expect((await drive.read(older.id)).bytes.toString("utf8")).toBe(newerBody);
  });

  it("converges two devices that both create the same session", async () => {
    const drive = new MemoryDrive();
    const findGate = defer();
    const createGate = defer();
    let emptyLists = 0;
    let creates = 0;
    let armList = true;
    let armCreate = true;
    const wrapped = wrap(drive, {
      async list(query: DriveListQuery): Promise<DriveEntry[]> {
        const entries = await drive.list(query);
        if (!armList || query.appProperty?.key !== "brainhubKey" || entries.length > 0) {
          return entries;
        }
        emptyLists += 1;
        if (emptyLists >= 2) {
          armList = false;
          findGate.resolve();
        } else {
          await findGate.promise;
        }
        return entries;
      },
      async put(input: DrivePutInput): Promise<DriveEntry> {
        const entry = await drive.put(input);
        if (!armCreate) return entry;
        creates += 1;
        if (creates >= 2) {
          armCreate = false;
          createGate.resolve();
        } else {
          await createGate.promise;
        }
        return entry;
      },
    });
    const older = session({
      markdown: markdown(1, "from-a"),
      messageCount: 1,
      updatedAt: "2026-01-02T04:00:00.000Z",
    });
    const newer = session({
      markdown: markdown(3, "from-b"),
      messageCount: 3,
      updatedAt: "2026-01-02T07:00:00.000Z",
    });
    const indexA = new MemoryIndex();
    const indexB = new MemoryIndex();
    const [left, right] = await Promise.all([
      service(wrapped, indexA, { deviceId: "device-a" }).upload(older),
      service(wrapped, indexB, { deviceId: "device-b" }).upload(newer),
    ]);

    expect(left.fileId).toBe(right.fileId);
    expect(indexA.fileIdOf(keyOf())).toBe(left.fileId);
    expect(indexB.fileIdOf(keyOf())).toBe(left.fileId);
    const files = await drive.findByAppProperty("brainhubKey", keyOf());
    expect(files).toHaveLength(1);
    expect(files[0]?.id).toBe(left.fileId);
    expect((await drive.read(left.fileId)).bytes.toString("utf8")).toBe(newer.markdown);
  });

  it("retries a 412 after re-reading and does not overwrite a newer remote", async () => {
    const drive = new MemoryDrive();
    const uploader = service(drive);
    const first = await uploader.upload(
      session({
        markdown: markdown(1, "base"),
        messageCount: 1,
        updatedAt: "2026-01-02T04:00:00.000Z",
      }),
    );
    const newest = markdown(9, "remote-newer");
    let once = true;
    const wrapped = wrap(drive, {
      async update(
        fileId: string,
        content: Buffer | string,
        options?: DriveUpdateOptions,
      ) {
        if (once) {
          once = false;
          await drive.update(fileId, newest, {
            ifMatch: options?.ifMatch ?? "",
            mimeType: "text/markdown",
            appProperties: inboxAppProperties({
              brainhubKey: keyOf(),
              source: "claude-code",
              conversationId: "conv-1",
              deviceId: "device-b",
              updatedAt: "2026-01-02T09:00:00.000Z",
              contentSha256: createHash("sha256").update(newest).digest("hex"),
            }),
          });
          throw new ConflictError();
        }
        return drive.update(fileId, content, options);
      },
    });
    const result = await service(wrapped).upload(
      session({
        markdown: markdown(2, "local-middle"),
        messageCount: 2,
        updatedAt: "2026-01-02T05:00:00.000Z",
      }),
    );

    expect(result.fileId).toBe(first.fileId);
    expect((await drive.read(first.fileId)).bytes.toString("utf8")).toBe(newest);
  });

  it("retries a transient 412 and then keeps the same file", async () => {
    const drive = new MemoryDrive();
    let failures = 2;
    const wrapped = wrap(drive, {
      async update(
        fileId: string,
        content: Buffer | string,
        options?: DriveUpdateOptions,
      ) {
        if (failures > 0) {
          failures -= 1;
          throw new ConflictError();
        }
        return drive.update(fileId, content, options);
      },
    });
    const uploader = service(wrapped);
    const first = await uploader.upload(session());
    const body = markdown(2, "after-retry");
    const second = await uploader.upload(
      session({
        markdown: body,
        messageCount: 2,
        updatedAt: "2026-01-02T05:00:00.000Z",
      }),
    );

    expect(failures).toBe(0);
    expect(second.fileId).toBe(first.fileId);
    expect((await drive.read(first.fileId)).bytes.toString("utf8")).toBe(body);
  });

  it("fails the upload when Drive reports a different md5", async () => {
    const drive = new MemoryDrive();
    const index = new MemoryIndex();
    const wrapped = wrap(drive, {
      async put(input: DrivePutInput) {
        const entry = await drive.put(input);
        return { ...entry, md5Checksum: "bad" };
      },
    });

    await expect(service(wrapped, index).upload(session())).rejects.toBeInstanceOf(
      ChecksumMismatchError,
    );
    expect(index.fileIdOf(keyOf())).toBeNull();
  });

  it("gives up after the retry limit", async () => {
    const drive = new MemoryDrive();
    const wrapped = wrap(drive, {
      async update() {
        throw new ConflictError();
      },
    });
    const uploader = service(wrapped, new MemoryIndex(), { maxAttempts: 2 });
    await uploader.upload(session());
    await expect(
      uploader.upload(
        session({
          markdown: markdown(2, "never"),
          messageCount: 2,
          updatedAt: "2026-01-02T05:00:00.000Z",
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("uploads an active session at most once per five minutes", async () => {
    const drive = new MemoryDrive();
    let now = 0;
    const uploader = service(drive, new MemoryIndex(), {
      clock: { now: () => now },
    });
    const current = session();
    uploader.noteActivity(current, 0);
    expect((await uploader.uploadIfDue(current)).status).toBe("waiting");

    now = 5 * 60_000;
    uploader.noteActivity(current, now);
    const uploaded = await uploader.uploadIfDue(current);
    expect(uploaded.status).toBe("uploaded");
    if (uploaded.status !== "uploaded") return;
    uploader.noteActivity(current, now);
    expect((await uploader.uploadIfDue(current)).status).toBe("waiting");

    now = 10 * 60_000;
    uploader.noteActivity(current, now);
    const again = await uploader.uploadIfDue(
      session({
        markdown: markdown(2, "later"),
        messageCount: 2,
        updatedAt: "2026-01-02T05:00:00.000Z",
      }),
    );
    expect(again.status).toBe("uploaded");
    if (again.status === "uploaded") {
      expect(again.result.fileId).toBe(uploaded.result.fileId);
    }
  });
});
