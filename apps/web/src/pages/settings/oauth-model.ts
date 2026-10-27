export const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

export type OAuthMode = "official" | "custom";

export type ClientIdIssue = "required" | "suffix";

export interface OAuthClientView {
  mode: OAuthMode;
  clientId: string;
  hasClientSecret: boolean;
  officialAvailable: boolean;
}

/**
 * client id 在提交前就该拦下来：Google 的授权页只会给一句含糊的报错，
 * 用户很难看出是自己粘贴错了。
 */
export function clientIdIssue(value: string): ClientIdIssue | null {
  const trimmed = value.trim();
  if (trimmed === "") return "required";
  if (!trimmed.endsWith(CLIENT_ID_SUFFIX)) return "suffix";
  if (trimmed.length <= CLIENT_ID_SUFFIX.length) return "suffix";
  return null;
}

/**
 * 保存按钮能不能点。
 *
 * 已经存过 secret 且仍是 custom 时，只改 client id 不必重贴 secret；
 * 从 official 切到 custom，或者本来就没有 secret，就必须一起填。
 */
export function canSaveOAuthClient(input: {
  mode: OAuthMode;
  clientId: string;
  secret: string;
  saved: OAuthClientView | null;
}): boolean {
  if (input.mode === "official") {
    // 已经就是 official，没有要改的东西。
    return input.saved?.mode !== "official";
  }
  if (clientIdIssue(input.clientId) !== null) return false;
  if (input.secret.trim() !== "") return true;
  return input.saved?.mode === "custom" && input.saved.hasClientSecret;
}
