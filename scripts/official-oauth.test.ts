import { describe, expect, it } from "bun:test";

import {
  MISSING_BUILD_OAUTH_WARNING,
  officialOAuthDefine,
  parseReleaseEnv,
  resolveBuildOAuthCredentials,
} from "./official-oauth.ts";

const CLIENT_ID = "build-sample.apps.googleusercontent.com";
const CLIENT_SECRET = 'sec"ret\\value';

describe("official OAuth build injection", () => {
  it("parses a KEY=VALUE release file", () => {
    const parsed = parseReleaseEnv(`
# comment
export YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID="${CLIENT_ID}"
YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET='${CLIENT_SECRET}'
EMPTY=
SPACED = kept
not a pair
`);
    expect(parsed.YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID).toBe(CLIENT_ID);
    expect(parsed.YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET).toBe(CLIENT_SECRET);
    expect(parsed.EMPTY).toBe("");
    expect(parsed.SPACED).toBe("kept");
    expect(parsed["not a pair"]).toBeUndefined();
  });

  it("warns when neither the environment nor the release file has credentials", () => {
    expect(resolveBuildOAuthCredentials({ env: {}, releaseEnv: {} })).toEqual({
      credentials: null,
      warning: MISSING_BUILD_OAUTH_WARNING,
    });
    expect(MISSING_BUILD_OAUTH_WARNING).toBe("此构建未内置官方 OAuth 凭据");
    expect(
      resolveBuildOAuthCredentials({
        env: {
          YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: "   ",
          YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "",
        },
        releaseEnv: { YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: "" },
      }).credentials,
    ).toBeNull();
    expect(officialOAuthDefine(null)).toBeUndefined();
  });

  it("uses the environment first and the release file as a fallback", () => {
    const fromFile = resolveBuildOAuthCredentials({
      env: {},
      releaseEnv: {
        YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
        YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      },
    });
    expect(fromFile).toEqual({
      credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      warning: null,
    });

    const mixed = resolveBuildOAuthCredentials({
      env: { YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: `  ${CLIENT_ID}  ` },
      releaseEnv: {
        YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: "file.apps.googleusercontent.com",
        YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      },
    });
    expect(mixed.credentials).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    const fromEnv = resolveBuildOAuthCredentials({
      env: {
        YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: "env.apps.googleusercontent.com",
        YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "env-secret",
      },
      releaseEnv: {
        YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
        YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      },
    });
    expect(fromEnv.credentials).toEqual({
      clientId: "env.apps.googleusercontent.com",
      clientSecret: "env-secret",
    });
    expect(officialOAuthDefine(fromEnv.credentials)).toEqual({
      "process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_ID": JSON.stringify(
        "env.apps.googleusercontent.com",
      ),
      "process.env.YOU_BRAIN_BUNDLED_OAUTH_CLIENT_SECRET": JSON.stringify("env-secret"),
    });
  });

  it("rejects a client id or secret that cannot be injected", () => {
    expect(() =>
      resolveBuildOAuthCredentials({
        env: {
          YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: "not-a-google-client",
          YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        },
      }),
    ).toThrow(/\.apps\.googleusercontent\.com/u);
    expect(() =>
      resolveBuildOAuthCredentials({
        env: { YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID },
      }),
    ).toThrow(/CLIENT_SECRET/u);
    expect(() =>
      resolveBuildOAuthCredentials({
        env: { YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      }),
    ).toThrow(/CLIENT_ID/u);
  });
});
