import { describe, expect, it } from "bun:test";

import {
  CLIENT_ID_SUFFIX,
  canSaveOAuthClient,
  clientIdIssue,
  type OAuthClientView,
} from "../../../src/pages/settings/oauth-model.js";

const official: OAuthClientView = {
  mode: "official",
  clientId: "",
  hasClientSecret: false,
  officialAvailable: true,
};

const custom: OAuthClientView = {
  mode: "custom",
  clientId: `mine${CLIENT_ID_SUFFIX}`,
  hasClientSecret: true,
  officialAvailable: true,
};

describe("oauth client id validation", () => {
  it("rejects blank and wrong suffixes", () => {
    expect(clientIdIssue("")).toBe("required");
    expect(clientIdIssue("   ")).toBe("required");
    expect(clientIdIssue("mine@gmail.com")).toBe("suffix");
    expect(clientIdIssue("mine.apps.googleusercontent.com.evil")).toBe("suffix");
  });

  it("accepts a real client id, trimming spaces", () => {
    expect(clientIdIssue(`  mine${CLIENT_ID_SUFFIX}  `)).toBeNull();
    expect(clientIdIssue(CLIENT_ID_SUFFIX)).toBe("suffix");
  });
});

describe("oauth save gating", () => {
  it("allows only switching to custom when the secret is filled", () => {
    expect(
      canSaveOAuthClient({ mode: "custom", clientId: `mine${CLIENT_ID_SUFFIX}`, secret: "s", saved: official }),
    ).toBe(true);
    expect(
      canSaveOAuthClient({ mode: "custom", clientId: `mine${CLIENT_ID_SUFFIX}`, secret: "", saved: official }),
    ).toBe(false);
  });

  it("lets a saved custom client change its id without re-entering the secret", () => {
    expect(
      canSaveOAuthClient({ mode: "custom", clientId: `other${CLIENT_ID_SUFFIX}`, secret: "", saved: custom }),
    ).toBe(true);
  });

  it("blocks a bad id even when a secret is present", () => {
    expect(
      canSaveOAuthClient({ mode: "custom", clientId: "nope", secret: "s", saved: custom }),
    ).toBe(false);
  });

  it("treats switching back to official as a change only when custom is active", () => {
    expect(canSaveOAuthClient({ mode: "official", clientId: "", secret: "", saved: custom })).toBe(true);
    expect(canSaveOAuthClient({ mode: "official", clientId: "", secret: "", saved: official })).toBe(false);
  });
});
