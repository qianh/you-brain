export const THEME_STORAGE_KEY = "you-brain-theme";

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface ThemeEnv {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  matchesDark: boolean;
  search: string;
  apply(theme: ResolvedTheme): void;
}

export function parseThemeChoice(value: string | null): ThemeChoice | null {
  if (value === "system" || value === "light" || value === "dark") return value;
  return null;
}

/** A `?theme=` query wins and is written through, so a screenshot URL and a saved choice agree. */
export function readThemeChoice(env: Pick<ThemeEnv, "getItem" | "setItem" | "search">): ThemeChoice {
  const fromQuery = parseThemeChoice(new URLSearchParams(env.search).get("theme"));
  if (fromQuery) {
    env.setItem(THEME_STORAGE_KEY, fromQuery);
    return fromQuery;
  }
  return parseThemeChoice(env.getItem(THEME_STORAGE_KEY)) ?? "system";
}

export function resolveTheme(choice: ThemeChoice, matchesDark: boolean): ResolvedTheme {
  if (choice === "light" || choice === "dark") return choice;
  return matchesDark ? "dark" : "light";
}

export function applyTheme(choice: ThemeChoice, env: ThemeEnv): ResolvedTheme {
  const resolved = resolveTheme(choice, env.matchesDark);
  env.apply(resolved);
  return resolved;
}

export function storeThemeChoice(choice: ThemeChoice, env: ThemeEnv): ResolvedTheme {
  env.setItem(THEME_STORAGE_KEY, choice);
  return applyTheme(choice, env);
}

export function browserThemeEnv(): ThemeEnv {
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    matchesDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    search: window.location.search,
    apply: (theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    },
  };
}
