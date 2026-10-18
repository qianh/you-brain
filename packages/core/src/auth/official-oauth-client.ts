export const OFFICIAL_OAUTH_CLIENT_ID_PLACEHOLDER = "__YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID__";
export const OFFICIAL_OAUTH_CLIENT_SECRET_PLACEHOLDER = "__YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET__";

export const MISSING_OFFICIAL_OAUTH_MESSAGE =
  "此版本未内置官方 OAuth 凭据，请选择 2 自带凭据，或使用正式构建";

export interface OfficialOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

/** Source placeholders. Release builds replace the BUNDLED env reads via --define. */
export const BUNDLED_GOOGLE_OAUTH_CLIENT: OfficialOAuthClient = {
  clientId: OFFICIAL_OAUTH_CLIENT_ID_PLACEHOLDER,
  clientSecret: OFFICIAL_OAUTH_CLIENT_SECRET_PLACEHOLDER,
  redirectUris: ["http://127.0.0.1"],
};

function configured(value: string | undefined, placeholder: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === placeholder) return undefined;
  return trimmed;
}

/**
 * Injected builds read YOU_BRAIN_BUNDLED_* (replaced at compile time).
 * `bun packages/cli/src/index.ts` reads YOU_BRAIN_GOOGLE_* from the environment.
 */
export function resolveOfficialOAuthClient(
  env: NodeJS.ProcessEnv = process.env,
): OfficialOAuthClient {
  const clientId =
    configured(
      process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID,
      OFFICIAL_OAUTH_CLIENT_ID_PLACEHOLDER,
    ) ??
    configured(env.YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID, OFFICIAL_OAUTH_CLIENT_ID_PLACEHOLDER) ??
    OFFICIAL_OAUTH_CLIENT_ID_PLACEHOLDER;
  const clientSecret =
    configured(
      process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET,
      OFFICIAL_OAUTH_CLIENT_SECRET_PLACEHOLDER,
    ) ??
    configured(
      env.YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET,
      OFFICIAL_OAUTH_CLIENT_SECRET_PLACEHOLDER,
    ) ??
    OFFICIAL_OAUTH_CLIENT_SECRET_PLACEHOLDER;
  return {
    clientId,
    clientSecret,
    redirectUris: ["http://127.0.0.1"],
  };
}

export function isUsableOfficialOAuthClient(client: {
  clientId: string;
  clientSecret: string;
}): boolean {
  return (
    client.clientId.endsWith(".apps.googleusercontent.com") &&
    !client.clientId.startsWith("__") &&
    client.clientSecret.length > 0 &&
    !client.clientSecret.startsWith("__")
  );
}
