"use client";

import type { JSX } from "react";
import { Settings2Icon } from "lucide-react";
import { useId } from "react";
import { useShallow } from "zustand/react/shallow";

import type {
  PreferenceKey,
  PreferenceValueMap,
} from "~/lib/preferences/preferences-config";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { FONT_OPTIONS } from "~/lib/fonts/options";
import {
  CONTENT_LAYOUT_OPTIONS,
  NAVBAR_STYLE_OPTIONS,
  SIDEBAR_COLLAPSIBLE_OPTIONS,
  SIDEBAR_VARIANT_OPTIONS,
} from "~/lib/preferences/layout";
import { PREFERENCE_REGISTRY } from "~/lib/preferences/preferences-config";
import {
  THEME_MODE_OPTIONS,
  THEME_PRESET_OPTIONS,
} from "~/lib/preferences/theme";
import { usePreferencesStore } from "~/stores/preferences/preferences-provider";

interface Option {
  readonly label: string;
  readonly value: string;
}

function useSetter<K extends PreferenceKey>(key: K): (value: string) => void {
  const setPreference = usePreferencesStore((state) => state.setPreference);
  return (value) => {
    const allowed: readonly string[] = PREFERENCE_REGISTRY[key].values;
    const match = allowed.find((candidate) => candidate === value);
    if (match) setPreference(key, match as PreferenceValueMap[K]);
  };
}

function ToggleRow<K extends PreferenceKey>({
  label,
  preference,
  options,
}: {
  label: string;
  preference: K;
  options: readonly Option[];
}): JSX.Element {
  const id = useId();
  const value = usePreferencesStore((state) => state.values[preference]);
  const set = useSetter(preference);
  return (
    <div className="grid gap-1.5">
      <span id={id} className="text-xs font-medium">
        {label}
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={value}
        onValueChange={(next) => {
          if (next) set(next);
        }}
        aria-labelledby={id}
        className="w-full"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="flex-1 text-xs"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function SelectRow<K extends PreferenceKey>({
  label,
  preference,
  options,
  swatch,
}: {
  label: string;
  preference: K;
  options: readonly Option[];
  swatch?: (value: string) => string | undefined;
}): JSX.Element {
  const id = useId();
  const value = usePreferencesStore((state) => state.values[preference]);
  const set = useSetter(preference);
  return (
    <div className="grid gap-1.5">
      <span id={id} className="text-xs font-medium">
        {label}
      </span>
      <Select value={value} onValueChange={set}>
        <SelectTrigger
          size="sm"
          className="w-full text-xs"
          aria-labelledby={id}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => {
              const color = swatch?.(option.value);
              return (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  className="text-xs"
                >
                  {color ? (
                    <span
                      aria-hidden="true"
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                  ) : null}
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The template's preferences popover: theme, look, font, and how the
 * sidebar, header and page width behave. Each choice is saved in a cookie.
 */
export function LayoutControls(): JSX.Element {
  const { resolvedThemeMode, resetPreferences } = usePreferencesStore(
    useShallow((state) => ({
      resolvedThemeMode: state.resolvedThemeMode,
      resetPreferences: state.resetPreferences,
    })),
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-8"
          aria-label="Layout and theme"
          title="Layout and theme"
        >
          <Settings2Icon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="grid gap-4">
          <div className="grid gap-1">
            <p className="text-sm leading-none font-medium">Layout and theme</p>
            <p className="text-xs text-muted-foreground">
              Saved in this browser.
            </p>
          </div>
          <SelectRow
            label="Colours"
            preference="theme_preset"
            options={THEME_PRESET_OPTIONS}
            swatch={(value) =>
              THEME_PRESET_OPTIONS.find((preset) => preset.value === value)
                ?.primary[resolvedThemeMode]
            }
          />
          <SelectRow label="Font" preference="font" options={FONT_OPTIONS} />
          <ToggleRow
            label="Theme"
            preference="theme_mode"
            options={THEME_MODE_OPTIONS}
          />
          <ToggleRow
            label="Page width"
            preference="content_layout"
            options={CONTENT_LAYOUT_OPTIONS}
          />
          <ToggleRow
            label="Header"
            preference="navbar_style"
            options={NAVBAR_STYLE_OPTIONS}
          />
          <ToggleRow
            label="Sidebar style"
            preference="sidebar_variant"
            options={SIDEBAR_VARIANT_OPTIONS}
          />
          <ToggleRow
            label="Collapsed sidebar"
            preference="sidebar_collapsible"
            options={SIDEBAR_COLLAPSIBLE_OPTIONS}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full text-xs"
            onClick={resetPreferences}
          >
            Restore defaults
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
