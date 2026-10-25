import type { MessageKey } from "../../i18n/messages.js";
import type { DriveState } from "../../lib/drive-state.js";

export interface AccountDriveView {
  chipTone: "success" | "danger" | "neutral";
  chipKey: MessageKey;
  /** Shown in the email slot instead of `email` when set. */
  emailKey: MessageKey | null;
  /** The signed-in email, or "-" when there is none to show. */
  email: string;
  /** The login button. Connected has none: the account is already in use. */
  loginKey: MessageKey | null;
  /** Sign-out and switch are offered while an account is signed in. */
  manage: boolean;
}

export function accountDriveView(state: DriveState, email: string): AccountDriveView {
  const shown = email === "" ? "-" : email;
  switch (state) {
    case "connected":
      return { chipTone: "success", chipKey: "driveOk", emailKey: null, email: shown, loginKey: null, manage: true };
    case "offline":
      return { chipTone: "danger", chipKey: "driveDown", emailKey: null, email: shown, loginKey: "signInAgain", manage: true };
    case "signedOut":
      return { chipTone: "neutral", chipKey: "accountSignedOut", emailKey: "notSignedIn", email: "-", loginKey: "signInGoogle", manage: false };
    case "checking":
      return { chipTone: "neutral", chipKey: "accountChecking", emailKey: null, email: "-", loginKey: null, manage: false };
  }
}
