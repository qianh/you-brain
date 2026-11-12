import { describe, expect, it } from "bun:test";

import { describeDriveUploadFailure, fitDriveAppProperties } from "../../src/drive/google-drive.js";

describe("describeDriveUploadFailure", () => {
  it("keeps the status when the body is not JSON", () => {
    expect(describeDriveUploadFailure(403, "<html>nope</html>")).toBe(
      "Google Drive upload failed: 403",
    );
  });

  it("drops a property whose key and value exceed 124 bytes", () => {
    const conversationId = "x".repeat(120);
    const fitted = fitDriveAppProperties({
      conversationId,
      source: "codex",
      brainhubKey: "a".repeat(64),
    });
    expect(fitted.conversationId).toBeUndefined();
    expect(fitted.source).toBe("codex");
    expect(fitted.brainhubKey).toBe("a".repeat(64));
  });

  it("includes the reason and message", () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "The user has exceeded their storage quota.",
        errors: [{ reason: "storageQuotaExceeded", message: "ignored" }],
      },
    });
    expect(describeDriveUploadFailure(403, body)).toBe(
      "Google Drive upload failed: 403 (storageQuotaExceeded: The user has exceeded their storage quota.)",
    );
  });
});
