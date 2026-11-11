import type { JSX } from "react";

/**
 * Runs in `<head>` before the page paints. The server already put the saved
 * preferences on `<html>`; this resolves "System" to light or dark, which
 * only the browser knows, so the page never flashes the wrong theme.
 */
const BOOT = `(function () {
  var root = document.documentElement;
  if (root.getAttribute("data-theme-mode") !== "system") return;
  var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
})();`;

export function ThemeBootScript(): JSX.Element {
  return <script dangerouslySetInnerHTML={{ __html: BOOT }} />;
}
