"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

const THEME_STORAGE_KEY = "hack-theme";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
  readonly resolvedTheme: ResolvedTheme;
  readonly setTheme: (theme: Theme) => void;
  readonly theme: Theme;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const nextTheme = readStoredTheme();
    setThemeState(nextTheme);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia(SYSTEM_THEME_QUERY);

    const syncTheme = () => {
      const nextResolvedTheme = resolveTheme({ theme });
      applyTheme({ resolvedTheme: nextResolvedTheme });
      setResolvedTheme(nextResolvedTheme);
    };

    syncTheme();
    mediaQuery.addEventListener("change", syncTheme);

    return () => {
      mediaQuery.removeEventListener("change", syncTheme);
    };
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      resolvedTheme,
      setTheme: (nextTheme) => {
        setThemeState(nextTheme);
        window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      },
      theme,
    }),
    [resolvedTheme, theme]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }
  return value;
}

function readStoredTheme(): Theme {
  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (
    storedTheme === "light" ||
    storedTheme === "dark" ||
    storedTheme === "system"
  ) {
    return storedTheme;
  }
  return "system";
}

function resolveTheme(input: { readonly theme: Theme }): ResolvedTheme {
  if (input.theme === "system") {
    return window.matchMedia(SYSTEM_THEME_QUERY).matches ? "dark" : "light";
  }
  return input.theme;
}

function applyTheme(input: { readonly resolvedTheme: ResolvedTheme }) {
  const root = document.documentElement;
  root.classList.toggle("dark", input.resolvedTheme === "dark");
  root.style.colorScheme = input.resolvedTheme;
}
