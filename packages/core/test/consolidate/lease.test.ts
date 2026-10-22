import { DRIVE_PATHS } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { DrivePort } from "../../src/drive/drive-port.js";
import {
  mergeConsolidateLease,
  readConsolidateLease,
  writeConsolidateLease,
  type ConsolidateLease,
} from "../../src/consolidate/lease.js";

const PATH = DRIVE_PATHS.consolidateLease;

function lease(date: string, deviceId: string, finishedAt: string): ConsolidateLease {
  return { date, deviceId, finishedAt };
}

describe("consolidate lease", () => {
  it("treats a missing file as no lease", async () => {
    const warnings: string[] = [];
    const drive = new MemoryDrive();
    expect(await readConsolidateLease(drive, (message) => warnings.push(message))).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("warns and continues when the file is corrupt or the shape is wrong", async () => {
    const drive = new MemoryDrive();
    await drive.put({ path: PATH, bytes: Buffer.from("{"), mimeType: "application/json" });
    const warnings: string[] = [];
    expect(await readConsolidateLease(drive, (message) => warnings.push(message))).toBeNull();

    await drive.put({
      path: PATH,
      bytes: Buffer.from(JSON.stringify({ date: "yesterday" })),
      mimeType: "application/json",
    });
    expect(await readConsolidateLease(drive, (message) => warnings.push(message))).toBeNull();
    expect(warnings).toEqual([
      "沉淀租约无法解析，按未沉淀处理",
      "沉淀租约无法解析，按未沉淀处理",
    ]);
  });

  it("warns instead of throwing when the drive read fails", async () => {
    const warnings: string[] = [];
    const drive = {
      readPath() {
        return Promise.reject(new Error("offline"));
      },
    } as unknown as DrivePort;
    expect(await readConsolidateLease(drive, (message) => warnings.push(message))).toBeNull();
    expect(warnings).toEqual(["读取沉淀租约失败，按未沉淀处理"]);
  });

  it("keeps the later calendar day, and the whole record of that writer", () => {
    const older = lease("2026-10-20", "device-a", "2026-10-20T18:00:00.000Z");
    const newer = lease("2026-10-21", "device-b", "2026-10-21T01:00:00.000Z");
    expect(mergeConsolidateLease(older, newer)).toEqual(newer);
    expect(mergeConsolidateLease(newer, older)).toEqual(newer);
  });

  it("keeps the later finishedAt when the date is the same", () => {
    const early = lease("2026-10-23", "early", "2026-10-23T01:00:00.000Z");
    const late = lease("2026-10-23", "late", "2026-10-23T09:00:00.000Z");
    expect(mergeConsolidateLease(early, late)).toEqual(late);
    expect(mergeConsolidateLease(late, early)).toEqual(late);
  });

  it("lets a concurrent writer with the larger date win", async () => {
    const drive = new MemoryDrive();
    await writeConsolidateLease(drive, lease("2026-10-20", "seed", "2026-10-20T00:00:00.000Z"));
    await Promise.all([
      writeConsolidateLease(drive, lease("2026-10-21", "device-a", "2026-10-21T01:00:00.000Z")),
      writeConsolidateLease(drive, lease("2026-10-22", "device-b", "2026-10-22T01:00:00.000Z")),
    ]);
    const object = await drive.readPath(PATH);
    const stored = JSON.parse(object?.bytes.toString("utf8") ?? "") as ConsolidateLease;
    expect(stored).toMatchObject({ date: "2026-10-22", deviceId: "device-b" });
  });

  it("overwrites a corrupt file instead of failing the write", async () => {
    const drive = new MemoryDrive();
    await drive.put({ path: PATH, bytes: Buffer.from("not-json"), mimeType: "application/json" });
    const next = lease("2026-10-23", "device-a", "2026-10-23T03:00:00.000Z");
    await writeConsolidateLease(drive, next);
    const object = await drive.readPath(PATH);
    expect(JSON.parse(object?.bytes.toString("utf8") ?? "")).toEqual(next);
  });
});
