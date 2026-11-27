import { createSignal } from "solid-js";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "takos-theme";

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

export function detectInitialTheme(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function applyThemeToDocument(
  preference: ThemePreference,
  doc: Pick<Document, "documentElement"> | undefined = globalThis.document,
): void {
  const root = doc?.documentElement;
  if (!root) return;
  if (preference === "light" || preference === "dark") {
    root.dataset.theme = preference;
  } else {
    delete root.dataset.theme;
  }
}

const [theme, setThemeSignal] =
  createSignal<ThemePreference>(detectInitialTheme());

export function setTheme(next: ThemePreference): void {
  const normalized = parseThemePreference(next);
  setThemeSignal(normalized);
  try {
    if (normalized === "system") {
      globalThis.localStorage?.removeItem(THEME_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(THEME_STORAGE_KEY, normalized);
    }
  } catch {
    // Ignore storage access failures.
  }
  applyThemeToDocument(normalized);
}

export function useTheme() {
  return {
    theme,
    setTheme,
  };
}

applyThemeToDocument(theme());
