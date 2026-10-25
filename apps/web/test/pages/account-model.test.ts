import { describe, expect, test } from "bun:test";

import { zh } from "../../src/i18n/messages.js";
import { accountDriveView } from "../../src/pages/settings/account-model.js";

describe("accountDriveView", () => {
  test("connected shows the chip and the email, with no login button", () => {
    expect(accountDriveView("connected", "john@example.com")).toEqual({
      chipTone: "success",
      chipKey: "driveOk",
      emailKey: null,
      email: "john@example.com",
      loginKey: null,
      manage: true,
    });
  });

  test("connected without an email shows a dash, and still no login button", () => {
    const view = accountDriveView("connected", "");
    expect(view.email).toBe("-");
    expect(view.loginKey).toBeNull();
  });

  test("offline shows the email and offers a re-login", () => {
    expect(accountDriveView("offline", "john@example.com")).toEqual({
      chipTone: "danger",
      chipKey: "driveDown",
      emailKey: null,
      email: "john@example.com",
      loginKey: "signInAgain",
      manage: true,
    });
  });

  test("signed out says not signed in, and offers a login", () => {
    expect(accountDriveView("signedOut", "")).toEqual({
      chipTone: "neutral",
      chipKey: "accountSignedOut",
      emailKey: "notSignedIn",
      email: "-",
      loginKey: "signInGoogle",
      manage: false,
    });
  });

  test("checking shows a dash and no button", () => {
    expect(accountDriveView("checking", "")).toEqual({
      chipTone: "neutral",
      chipKey: "accountChecking",
      emailKey: null,
      email: "-",
      loginKey: null,
      manage: false,
    });
  });

  test("every key it returns has Chinese copy", () => {
    for (const state of ["connected", "offline", "signedOut", "checking"] as const) {
      const view = accountDriveView(state, "john@example.com");
      expect(zh[view.chipKey]).toBeString();
      if (view.emailKey) expect(zh[view.emailKey]).toBeString();
      if (view.loginKey) expect(zh[view.loginKey]).toBeString();
    }
  });
});
