import { rm } from "node:fs/promises";

import { createDefaultSharedConfig, DRIVE_PATHS, parseRoles } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { startDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { localDateKey, localParts, timeZoneOffsetMinutes } from "../../src/reminders/time.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { foldEvents } from "../../src/topics/fold.js";
import { persistTopicBook } from "../../src/topics/persist.js";
import {
  CLOCK_START,
  makeDaemonDirs,
  testClock,
  throwingEmbedder,
} from "../daemon/helpers.js";
import { KEY_1, buildEvent } from "../topics/helpers.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const LAST = new Date(CLOCK_START.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();

describe("daemon reminder generation", () => {
  it("waits for Drive on startup, then generates on the main device with notifications off", async () => {
    const dirs = await makeDaemonDirs("you-brain-reminders-daemon-");
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const first = await startDaemon({
      homeDir: dirs.homeDir,
      platform: "darwin",
      env: dirs.env,
      hostname: "reminder-device",
      clock,
      drive: null,
      llm: null,
      embedder: throwingEmbedder,
      sourceRoots: {},
      watch: false,
      signals: false,
    });
    try {
      const statusResponse = await fetch(`${first.baseUrl}/api/status`, {
        headers: { authorization: `Bearer ${first.token}` },
      });
      const status = (await statusResponse.json()) as { deviceId: string };
      expect(status.deviceId.length).toBeGreaterThan(0);
      const rolesResponse = await fetch(`${first.baseUrl}/api/roles`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${first.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mainDevice: status.deviceId }),
      });
      expect(rolesResponse.status).toBe(200);
      await drive.put({
        path: DRIVE_PATHS.roles,
        bytes: Buffer.from(JSON.stringify(parseRoles({ mainDevice: status.deviceId }))),
        mimeType: "application/json",
      });
    } finally {
      await first.stop();
    }

    const shared = createDefaultSharedConfig();
    shared.reminders.notifications = false;
    await writeFile(join(dirs.dataDir, "shared.json"), `${JSON.stringify(shared)}\n`);
    await drive.put({ path: DRIVE_PATHS.sharedConfig, bytes: Buffer.from(JSON.stringify(shared)), mimeType: "application/json" });
    const store = new SqliteStore(join(dirs.dataDir, "state.sqlite"));
    try {
      store.upsertSession({
        sessionKey: KEY_1,
        source: "codex",
        device: "laptop",
        startedAt: LAST,
        updatedAt: LAST,
        topicId: "topic-stale",
        title: "跟进",
        summary: "",
      });
      persistTopicBook(
        store,
        foldEvents([
          buildEvent({
            type: "topic.created",
            data: { topicId: "topic-stale", name: "跟进事项", aliases: [] },
            device: "dev-a",
            ts: LAST,
            seq: 1,
          }),
          buildEvent({
            type: "topic.assigned",
            data: { topicId: "topic-stale", sessionKey: KEY_1 },
            device: "dev-a",
            ts: LAST,
            seq: 2,
          }),
          buildEvent({
            type: "todo.added",
            data: {
              todoId: "todo-stale",
              topicId: "topic-stale",
              text: "还没做",
              sessionKey: KEY_1,
              confidence: 0.8,
            },
            device: "dev-a",
            ts: LAST,
            seq: 3,
          }),
        ]),
      );
    } finally {
      store.close();
    }

    const second = await startDaemon({
      homeDir: dirs.homeDir,
      platform: "darwin",
      env: dirs.env,
      hostname: "reminder-device",
      clock,
      drive,
      llm: null,
      embedder: throwingEmbedder,
      sourceRoots: {},
      watch: false,
      signals: false,
    });
    try {
      await second.settled();
      const initial = await fetch(`${second.baseUrl}/api/reminders`, {
        headers: { authorization: `Bearer ${second.token}` },
      }).then((response) => response.json()) as { reminders: unknown[] };
      expect(initial.reminders).toEqual([]);
      await clock.advance(2_000);
      await second.settled();
      const config = (await (
        await fetch(`${second.baseUrl}/api/config`, {
          headers: { authorization: `Bearer ${second.token}` },
        })
      ).json()) as { reminders: { notifications: boolean } };
      expect(config.reminders.notifications).toBe(false);
      const body = (await (
        await fetch(`${second.baseUrl}/api/reminders`, {
          headers: { authorization: `Bearer ${second.token}` },
        })
      ).json()) as { reminders: Array<{ reminderId: string; kind: string }> };
      const offset = timeZoneOffsetMinutes("Asia/Shanghai", CLOCK_START);
      const staleId = `stale:topic-stale:${localDateKey(localParts(Date.parse(LAST), offset))}`;
      const morningId = `morning:${localDateKey(localParts(CLOCK_START.getTime(), offset))}`;
      expect(body.reminders.map((item) => item.reminderId)).toContain(staleId);
      expect(body.reminders.map((item) => item.reminderId)).toContain(morningId);
      expect(body.reminders.some((item) => item.kind === "weekly_review")).toBe(true);
    } finally {
      await second.stop();
      await rm(dirs.root, { recursive: true, force: true });
    }
  }, 20_000);
});
