import { describe, expect, it } from "bun:test";

import {
  DRIVE_PATHS,
  INBOX_APP_PROPERTIES,
  INBOX_IMAGE_APP_PROPERTIES,
  YB_SCHEMA_VERSION,
  deviceRecordPath,
  eventLogPath,
  inboxAppProperties,
  inboxAssetPath,
  inboxDeviceDir,
  inboxSessionPath,
  inboxWebDir,
  topicDetailPath,
  topicHistoryPath,
  conversationKey,
} from "../src/index.js";

const SHA = conversationKey("codex", "abc");

describe("drive paths", () => {
  it("keeps protocol paths relative to the drive root", () => {
    expect(DRIVE_PATHS.inbox).toBe("inbox");
    expect(DRIVE_PATHS.protocolFile).toBe("you-brain/protocol.json");
    expect(DRIVE_PATHS.sharedConfig).toBe("you-brain/config/shared.json");
    expect(DRIVE_PATHS.roles).toBe("you-brain/config/roles.json");
    expect(DRIVE_PATHS.consolidateLease).toBe("you-brain/leases/consolidate.json");
    expect(DRIVE_PATHS.topicsLatest).toBe("topics/TOPICS-latest.md");
    expect(DRIVE_PATHS.digitalTwin).toBe("digital-twin");
    expect(deviceRecordPath("dev-1")).toBe("you-brain/devices/dev-1.json");
    expect(eventLogPath("dev-1", "2026-10-18")).toBe(
      "you-brain/events/dev-1/2026-10-18.jsonl",
    );
    expect(inboxDeviceDir("macbook")).toBe("inbox/macbook");
    expect(inboxWebDir("chatgpt")).toBe("inbox/web-chatgpt");
    expect(inboxSessionPath("macbook", "codex-20261018-abcd1234.md")).toBe(
      "inbox/macbook/codex-20261018-abcd1234.md",
    );
    expect(inboxAssetPath(SHA)).toBe(
      `inbox/_assets/sha256/${SHA.slice(0, 2)}/${SHA}.webp`,
    );
    expect(topicDetailPath("naming")).toBe("topics/naming.md");
    expect(topicHistoryPath("naming")).toBe("topics/history/naming.md");
  });

  it("rejects path traversal and impossible days", () => {
    expect(() => deviceRecordPath("../etc")).toThrow();
    expect(() => eventLogPath("dev-1", "2026-13-40")).toThrow();
    expect(() => eventLogPath("dev-1", "18 Oct 2026")).toThrow();
    expect(() => inboxAssetPath("abcd")).toThrow();
    expect(() => topicDetailPath("a/b")).toThrow();
  });
});

describe("inbox app properties", () => {
  it("keeps the BrainHub keys and adds ybSchema", () => {
    expect(Object.values(INBOX_APP_PROPERTIES)).toEqual([
      "brainhubKey",
      "source",
      "conversationId",
      "deviceId",
      "updatedAt",
      "contentSha256",
      "ybSchema",
    ]);
    expect(INBOX_IMAGE_APP_PROPERTIES.brainhubImageSha).toBe("brainhubImageSha");
    expect(YB_SCHEMA_VERSION).toBe("1");
    expect(
      inboxAppProperties({
        brainhubKey: SHA,
        source: "codex",
        conversationId: "abc",
        deviceId: "dev-1",
        updatedAt: "2026-10-18T03:00:00.000Z",
        contentSha256: SHA,
      }),
    ).toEqual({
      brainhubKey: SHA,
      source: "codex",
      conversationId: "abc",
      deviceId: "dev-1",
      updatedAt: "2026-10-18T03:00:00.000Z",
      contentSha256: SHA,
      ybSchema: "1",
    });
  });
});
