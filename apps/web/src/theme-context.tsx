import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  applyTheme,
  browserThemeEnv,
  parseThemeChoice,
  readThemeChoice,
  storeThemeChoice,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeChoice,
} from "./lib/theme.js";

export type { ThemeChoice };

interface ThemeValue {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readThemeChoice(browserThemeEnv()));
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    applyTheme(readThemeChoice(browserThemeEnv()), browserThemeEnv()),
  );

  useEffect(() => {
    setResolved(applyTheme(choice, browserThemeEnv()));
  }, [choice]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = (): void => {
      const stored = parseThemeChoice(localStorage.getItem(THEME_STORAGE_KEY)) ?? "system";
      if (stored !== "system") return;
      setResolved(applyTheme("system", browserThemeEnv()));
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    setResolved(storeThemeChoice(next, browserThemeEnv()));
  }, []);

  const value = useMemo(() => ({ choice, resolved, setChoice }), [choice, resolved, setChoice]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
