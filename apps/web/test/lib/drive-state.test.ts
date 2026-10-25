import { describe, expect, test } from "bun:test";

import { driveEmail, driveState, driveStillChecking, needsDriveLogin } from "../../src/lib/drive-state.js";

describe("driveState", () => {
  test("reads the four states from reachability and email", () => {
    expect(driveState({ reachable: true, accountEmail: "john@example.com" })).toBe("connected");
    expect(driveState({ reachable: false, accountEmail: "john@example.com" })).toBe("offline");
    expect(driveState({ reachable: false, accountEmail: "" })).toBe("signedOut");
    expect(driveState({ reachable: false, accountEmail: null })).toBe("signedOut");
    expect(driveState({ reachable: null, accountEmail: null })).toBe("checking");
    expect(driveState(null)).toBe("checking");
    expect(driveState(undefined)).toBe("checking");
  });

  test("treats a blank email as no account", () => {
    expect(driveState({ reachable: false, accountEmail: "   " })).toBe("signedOut");
    expect(driveState({ reachable: false, accountEmail: "  john@example.com \n" })).toBe("offline");
  });

  test("keeps a reachable drive connected even without an email", () => {
    expect(driveState({ reachable: true, accountEmail: null })).toBe("connected");
    expect(driveState({ reachable: true, accountEmail: "  " })).toBe("connected");
  });

  test("never reports reachable without an email as offline or checking", () => {
    expect(driveState({ reachable: null, accountEmail: "john@example.com" })).toBe("checking");
  });
});

describe("driveEmail", () => {
  test("trims the email and reads a missing one as empty", () => {
    expect(driveEmail({ accountEmail: " john@example.com " })).toBe("john@example.com");
    expect(driveEmail({ accountEmail: null })).toBe("");
    expect(driveEmail(null)).toBe("");
  });
});

describe("needsDriveLogin", () => {
  test("asks for a login row only when signed out and the daemon has none", () => {
    expect(needsDriveLogin("signedOut", [])).toBe(true);
    expect(needsDriveLogin("signedOut", [{ code: "LLM_NOT_CONFIGURED" }])).toBe(true);
    expect(needsDriveLogin("signedOut", [{ code: "AUTH_REQUIRED" }])).toBe(false);
    expect(needsDriveLogin("signedOut", [{ code: "drive_root_conflict" }])).toBe(false);
    expect(needsDriveLogin("offline", [])).toBe(false);
    expect(needsDriveLogin("connected", [])).toBe(false);
    expect(needsDriveLogin("checking", [])).toBe(false);
  });
});

describe("driveStillChecking", () => {
  test("is true only while a loaded status has an unknown Drive", () => {
    expect(driveStillChecking(null)).toBe(false);
    expect(driveStillChecking(undefined)).toBe(false);
    expect(driveStillChecking({ drive: { reachable: null, accountEmail: null } })).toBe(true);
    expect(driveStillChecking({ drive: { reachable: true, accountEmail: null } })).toBe(false);
    expect(driveStillChecking({ drive: { reachable: false, accountEmail: "" } })).toBe(false);
  });
});
