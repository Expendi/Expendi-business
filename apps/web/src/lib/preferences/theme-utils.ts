import type { ResolvedThemeMode, ThemeMode } from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveThemeMode(mode: ThemeMode): ResolvedThemeMode {
  if (mode === "system") {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  }
  return mode;
}

/** Puts the mode on `<html>` without animating every colour change. */
export function applyThemeMode(mode: ThemeMode): ResolvedThemeMode {
  const resolved = resolveThemeMode(mode);
  const root = document.documentElement;
  root.setAttribute("data-theme-mode", mode);
  root.classList.add("disable-transitions");
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  requestAnimationFrame(() => {
    root.classList.remove("disable-transitions");
  });
  return resolved;
}

export function subscribeToSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
