import { describe, expect, it } from "bun:test";

import { InboxScopedDrive } from "../../src/drive/scoped-drive.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";

describe("inbox scoped drive", () => {
  it("rejects writes outside inbox and serves inbox files", async () => {
    const scoped = new InboxScopedDrive(new MemoryDrive());
    await expect(
      scoped.create({
        path: "topics/note.md",
        bytes: Buffer.from("nope"),
        mimeType: "text/markdown",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const created = await scoped.create({
      path: "inbox/mac/session.md",
      bytes: Buffer.from("yes"),
      mimeType: "text/markdown",
    });
    expect(created.path).toBe("inbox/mac/session.md");
    const read = await scoped.read(created.id);
    expect(read.bytes.toString("utf8")).toBe("yes");
    expect(await scoped.findByPath("inbox/mac/session.md")).toMatchObject({
      id: created.id,
    });
  });

  it("does not read a file stored outside inbox", async () => {
    const drive = new MemoryDrive();
    const outside = await drive.create({
      path: "topics/note.md",
      bytes: Buffer.from("secret"),
      mimeType: "text/markdown",
    });
    const scoped = new InboxScopedDrive(drive);
    await expect(scoped.read(outside.id)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
