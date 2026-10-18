import { describe, expect, it } from "bun:test";

import {
  applyGoogleConnection,
  clearGoogleConnection,
  connectGoogleAccount,
} from "../../src/auth/google-account.js";
import { createDefaultLocalConfig } from "../../src/domain/config.js";

function config() {
  return createDefaultLocalConfig({ hostname: "test-device", dataDir: "/tmp/you-brain" });
}

describe("Google account binding", () => {
  it("applies and clears an account without mutating the previous config", () => {
    const original = config();
    const connected = applyGoogleConnection(original, {
      account: {
        email: "person@example.com",
        displayName: "Person",
        permissionId: "permission-1",
      },
      rootFolderId: "root-1",
    });
    expect(connected).not.toBe(original);
    expect(connected.driveRootId).toBe("root-1");
    expect(connected.account.email).toBe("person@example.com");
    expect(original.driveRootId).toBe("");
    const cleared = clearGoogleConnection(connected);
    expect(cleared.driveRootId).toBe("");
    expect(cleared.account.permissionId).toBe("");
    expect(connected.driveRootId).toBe("root-1");
  });

  it("reads identity and reuses an existing root", async () => {
    const authClient = { marker: "new-account" };
    let received: unknown;
    const drive = {
      about: {
        get: async () => ({
          data: {
            user: {
              emailAddress: "person@example.com",
              displayName: "Person",
              permissionId: "permission-1",
            },
          },
        }),
      },
      files: {
        list: async () => ({ data: { files: [{ id: "existing-root" }] } }),
        create: async () => {
          throw new Error("must reuse existing root");
        },
      },
    };
    const connection = await connectGoogleAccount({
      authClient: authClient as never,
      drive: (auth) => {
        received = auth;
        return drive;
      },
      rootFolderName: "brain-hub",
    });
    expect(received).toBe(authClient);
    expect(connection.rootFolderId).toBe("existing-root");
  });

  it("rejects an incomplete identity before listing folders", async () => {
    let rootCalls = 0;
    await expect(
      connectGoogleAccount({
        authClient: {} as never,
        drive: () => ({
          about: {
            get: async () => ({
              data: { user: { emailAddress: "a@example.com", displayName: "A" } },
            }),
          },
          files: {
            list: async () => {
              rootCalls += 1;
              return { data: { files: [] } };
            },
            create: async () => ({ data: {} }),
          },
        }),
        rootFolderName: "brain-hub",
      }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_UNAVAILABLE" });
    expect(rootCalls).toBe(0);
  });
});
