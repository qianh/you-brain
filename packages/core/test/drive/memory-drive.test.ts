import { createHash } from "node:crypto";

import { describe, expect, it } from "bun:test";

import { ConflictError } from "../../src/drive/errors.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

describe("memory drive semantics", () => {
  it("keeps fileId across updates, bumps etag, and stores md5", async () => {
    let tick = 0;
    const drive = new MemoryDrive({
      now: () => new Date(Date.UTC(2026, 0, 2, 0, 0, tick++)),
    });
    const created = await drive.create({
      path: "inbox/mac/session.md",
      bytes: Buffer.from("first"),
      mimeType: "text/markdown",
    });

    const updated = await drive.update(created.id, "second", {
      ifMatch: created.etag,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.createdTime).toBe(created.createdTime);
    expect(updated.etag).not.toBe(created.etag);
    expect(updated.md5Checksum).toBe(md5("second"));
    expect(updated.modifiedTime > created.modifiedTime).toBe(true);
    const read = await drive.read(created.id);
    expect(read.bytes.toString("utf8")).toBe("second");
    expect(read.etag).toBe(updated.etag);
    expect(read.md5Checksum).toBe(updated.md5Checksum);
    expect(read.modifiedTime).toBe(updated.modifiedTime);
  });

  it("rejects a stale etag with ConflictError and leaves the file untouched", async () => {
    const drive = new MemoryDrive();
    const created = await drive.create({
      path: "inbox/mac/session.md",
      bytes: Buffer.from("kept"),
      mimeType: "text/markdown",
    });

    await expect(
      drive.update(created.id, "lost", { ifMatch: "stale-etag" }),
    ).rejects.toBeInstanceOf(ConflictError);
    const read = await drive.read(created.id);
    expect(read.bytes.toString("utf8")).toBe("kept");
    expect(read.etag).toBe(created.etag);
    expect(read.md5Checksum).toBe(created.md5Checksum);
  });

  it("renames and moves without changing fileId", async () => {
    const drive = new MemoryDrive();
    const created = await drive.create({
      path: "inbox/mac/before.md",
      bytes: Buffer.from("body"),
      mimeType: "text/markdown",
    });
    const folder = await drive.ensureFolder("inbox/mac");
    expect(await drive.ensureFolder("inbox/mac")).toBe(folder);

    const renamed = await drive.rename(created.id, "after.md");
    expect(renamed.id).toBe(created.id);
    expect(renamed.path).toBe("inbox/mac/after.md");
    expect(renamed.md5Checksum).toBe(created.md5Checksum);

    const moved = await drive.move(created.id, "inbox/other/after.md");
    expect(moved.id).toBe(created.id);
    expect(moved.path).toBe("inbox/other/after.md");
    expect((await drive.read(created.id)).bytes.toString("utf8")).toBe("body");
  });

  it("returns an incremental changes cursor after content updates", async () => {
    const drive = new MemoryDrive();
    const created = await drive.put({
      path: "inbox/mac/session.md",
      bytes: Buffer.from("one"),
      mimeType: "text/markdown",
    });
    const cursor = await drive.startPageToken();
    const initial = await drive.changes({ prefix: "inbox/" });
    expect(initial.cursor).toBe(cursor);
    expect(initial.reset).toBe(true);

    const updated = await drive.update(created.id, "two", { ifMatch: created.etag });
    const incremental = await drive.changes({ prefix: "inbox/", cursor });

    expect(incremental.reset).toBe(false);
    expect(incremental.entries.map((entry) => entry.id)).toEqual([created.id]);
    expect(incremental.entries[0]?.md5Checksum).toBe(updated.md5Checksum);
    expect(incremental.entries[0]?.etag).toBe(updated.etag);
    expect(incremental.removedIds).toEqual([]);
    expect(await drive.findByPath("inbox/mac/session.md")).toMatchObject({
      id: created.id,
    });
    expect(
      await drive.findByAppProperty("missing", "value"),
    ).toEqual([]);
  });
});
