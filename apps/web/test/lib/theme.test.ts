import { describe, expect, test } from "bun:test";

import {
  applyTheme,
  readThemeChoice,
  resolveTheme,
  storeThemeChoice,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeEnv,
} from "../../src/lib/theme.js";

function memoryEnv(search = "", matchesDark = false): ThemeEnv & { applied: ResolvedTheme | null } {
  const store = new Map<string, string>();
  const env: ThemeEnv & { applied: ResolvedTheme | null } = {
    applied: null,
    matchesDark,
    search,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    apply: (theme) => {
      env.applied = theme;
    },
  };
  return env;
}

describe("theme", () => {
  test("follows the system when nothing is stored", () => {
    const light = memoryEnv("", false);
    expect(readThemeChoice(light)).toBe("system");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    const dark = memoryEnv("", true);
    expect(applyTheme("system", dark)).toBe("dark");
    expect(dark.applied).toBe("dark");
  });

  test("a query choice is stored and beats the previous value", () => {
    const env = memoryEnv("?theme=dark&id=1", false);
    env.setItem(THEME_STORAGE_KEY, "light");
    expect(readThemeChoice(env)).toBe("dark");
    expect(env.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(storeThemeChoice("light", env)).toBe("light");
    expect(env.applied).toBe("light");
  });

  test("ignores an unknown stored value", () => {
    const env = memoryEnv();
    env.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readThemeChoice(env)).toBe("system");
  });
});
