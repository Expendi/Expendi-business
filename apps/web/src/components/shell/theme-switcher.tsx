"use client";

import type { JSX } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import type { ThemeMode } from "~/lib/preferences/theme";
import { Button } from "~/components/ui/button";
import { usePreferencesStore } from "~/stores/preferences/preferences-provider";

const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const ICONS = { light: SunIcon, dark: MoonIcon, system: MonitorIcon };

const LABELS: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/** Cycles light, dark and system; the icon shows the current mode. */
export function ThemeSwitcher(): JSX.Element {
  const { mode, setPreference } = usePreferencesStore(
    useShallow((state) => ({
      mode: state.values.theme_mode,
      setPreference: state.setPreference,
    })),
  );
  const Icon = ICONS[mode];
  const next = NEXT_MODE[mode];
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="size-8"
      onClick={() => setPreference("theme_mode", next)}
      aria-label={`Theme: ${LABELS[mode]}. Switch to ${LABELS[next]}`}
      title={`Theme: ${LABELS[mode]}`}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}
