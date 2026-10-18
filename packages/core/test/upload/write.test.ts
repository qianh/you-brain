import { describe, expect, it } from "bun:test";

import { ConflictError } from "../../src/drive/errors.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { DrivePort, DriveUpdateOptions } from "../../src/drive/drive-port.js";
import { updateJsonWithMerge, upsertByPath } from "../../src/upload/write.js";

function wrap(
  drive: MemoryDrive,
  overrides: Partial<DrivePort>,
): DrivePort {
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

describe("path upsert and json merge", () => {
  it("updates a path in place", async () => {
    const drive = new MemoryDrive();
    const path = "you-brain/events/device/2026-01-02.jsonl";
    const first = await upsertByPath(drive, path, "one\n", {
      mimeType: "application/jsonl",
    });
    const second = await upsertByPath(drive, path, "one\ntwo\n", {
      mimeType: "application/jsonl",
    });

    expect(second.id).toBe(first.id);
    expect((await drive.read(first.id)).bytes.toString("utf8")).toBe("one\ntwo\n");
    expect(await drive.findByPath(path)).toMatchObject({ id: first.id });
  });

  it("re-reads and merges JSON after a 412", async () => {
    const drive = new MemoryDrive();
    const path = "you-brain/config/shared.json";
    const created = await updateJsonWithMerge(drive, path, () => ({ a: 1, b: 1 }));
    let merges = 0;
    let thrown = false;
    const wrapped = wrap(drive, {
      async update(
        fileId: string,
        content: Buffer | string,
        options?: DriveUpdateOptions,
      ) {
        if (!thrown) {
          thrown = true;
          await drive.update(
            fileId,
            `${JSON.stringify({ a: 1, b: 9 }, null, 2)}\n`,
            {
              ifMatch: options?.ifMatch ?? "",
              mimeType: "application/json",
            },
          );
          throw new ConflictError();
        }
        return drive.update(fileId, content, options);
      },
    });

    const merged = await updateJsonWithMerge(wrapped, path, (current) => {
      merges += 1;
      return { ...(current ?? { a: 0, b: 0 }), a: 2 };
    });

    expect(merges).toBe(2);
    expect(merged.file.id).toBe(created.file.id);
    expect(merged.value).toEqual({ a: 2, b: 9 });
    expect(JSON.parse((await drive.read(created.file.id)).bytes.toString("utf8"))).toEqual({
      a: 2,
      b: 9,
    });
  });
});
