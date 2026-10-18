export interface OfficialOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export const MISSING_BUILD_OAUTH_WARNING = "此构建未内置官方 OAuth 凭据";

export interface ResolvedBuildOAuth {
  credentials: OfficialOAuthCredentials | null;
  warning: string | null;
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

/** KEY=VALUE file. Blank lines and # comments are ignored. `export ` is optional. */
export function parseReleaseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function pick(envValue: string | undefined, fileValue: string | undefined): string | undefined {
  return nonempty(envValue) ?? nonempty(fileValue);
}

export function resolveBuildOAuthCredentials(input: {
  env: NodeJS.ProcessEnv;
  releaseEnv?: Record<string, string>;
}): ResolvedBuildOAuth {
  const file = input.releaseEnv ?? {};
  const clientId = pick(
    input.env.YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID,
    file.YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID,
  );
  const clientSecret = pick(
    input.env.YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET,
    file.YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET,
  );
  if (!clientId && !clientSecret) {
    return { credentials: null, warning: MISSING_BUILD_OAUTH_WARNING };
  }
  if (!clientId?.endsWith(".apps.googleusercontent.com") || !clientSecret) {
    throw new Error(
      "官方 OAuth 凭据无效：YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID 必须以 .apps.googleusercontent.com 结尾，且 YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET 不能为空",
    );
  }
  return {
    credentials: { clientId, clientSecret },
    warning: null,
  };
}

/** Bun.build `define` map. Values are JS string literals. Absent creds omit the map. */
export function officialOAuthDefine(
  credentials: OfficialOAuthCredentials | null,
): Record<string, string> | undefined {
  if (!credentials) return undefined;
  return {
    "process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID": JSON.stringify(credentials.clientId),
    "process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET": JSON.stringify(credentials.clientSecret),
  };
}
