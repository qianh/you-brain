import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isUlid } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { YouBrainError } from "../../src/domain/errors.js";
import { SqliteStore } from "../../src/store/index.js";
import { EventLog } from "../../src/sync/index.js";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";
const TS = "2026-07-01T00:00:00.000Z";

function withStore(run: (store: SqliteStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "you-brain-sync-log-"));
  const store = new SqliteStore(join(directory, "brain.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("EventLog", () => {
  it("stamps ulid, time, device, and a persistent per-device sequence", () => {
    withStore((store) => {
      const clock = new Date(TS);
      const firstLog = new EventLog(store, DEVICE_A, { now: () => clock });
      const other = new EventLog(store, DEVICE_B, { now: () => clock });
      const first = firstLog.allocate("topic.created", {
        topicId: "topic-a",
        name: "Alpha",
        aliases: [],
      });
      const foreign = other.allocate(
        "topic.created",
        { topicId: "topic-b", name: "Beta", aliases: [] },
        { ts: "2026-07-01T01:00:00.000Z" },
      );
      const restarted = new EventLog(store, DEVICE_A, { now: () => clock });
      const second = restarted.allocate("topic.created", {
        topicId: "topic-c",
        name: "Gamma",
        aliases: [],
      });

      expect(isUlid(first.id)).toBe(true);
      expect(first.id).not.toBe(second.id);
      expect(first.ts).toBe(TS);
      expect(first.device).toBe(DEVICE_A);
      expect(first.seq).toBe(1);
      expect(foreign.seq).toBe(1);
      expect(foreign.device).toBe(DEVICE_B);
      expect(foreign.ts).toBe("2026-07-01T01:00:00.000Z");
      expect(second.seq).toBe(2);
    });
  });

  it("does not advance the sequence when the event is rejected", () => {
    withStore((store) => {
      const log = new EventLog(store, DEVICE_A, { now: () => new Date(TS) });
      expect(() =>
        log.allocate("topic.created", { topicId: "topic-a", name: "", aliases: [] }),
      ).toThrow();
      expect(() =>
        log.allocate("topic.created", {
          topicId: "topic-a",
          name: "Alpha",
          aliases: [],
        }, { ts: "not-a-date" }),
      ).toThrow(YouBrainError);
      expect(
        log.allocate("topic.created", { topicId: "topic-a", name: "Alpha", aliases: [] }).seq,
      ).toBe(1);
    });
  });
});
