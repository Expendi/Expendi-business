"use client";

import type { JSX, ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";
import { useId } from "react";
import { useShallow } from "zustand/react/shallow";

import type {
  PreferenceKey,
  PreferenceValueMap,
} from "~/lib/preferences/preferences-config";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
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

function PreferenceRow({
  labelId,
  label,
  children,
}: {
  labelId: string;
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 max-[600px]:grid-cols-[minmax(0,1fr)]">
      <span id={labelId} className="text-muted-foreground">
        {label}
      </span>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
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
    <PreferenceRow labelId={id} label={label}>
      <ToggleGroup
        type="single"
        variant="outline"
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
            className="flex-1"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </PreferenceRow>
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
    <PreferenceRow labelId={id} label={label}>
      <Select value={value} onValueChange={set}>
        <SelectTrigger className="w-full" aria-labelledby={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => {
              const color = swatch?.(option.value);
              return (
                <SelectItem key={option.value} value={option.value}>
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
    </PreferenceRow>
  );
}

/**
 * How the admin looks for the staff member signed in: theme, colours, font,
 * and how the sidebar, header and page width behave. Each choice is saved
 * in a cookie, so ops viewers change theirs as freely as ops admins.
 */
export function AppearanceSettings(): JSX.Element {
  const { resolvedThemeMode, resetPreferences } = usePreferencesStore(
    useShallow((state) => ({
      resolvedThemeMode: state.resolvedThemeMode,
      resetPreferences: state.resetPreferences,
    })),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Appearance</h2>
        </CardTitle>
        <CardDescription>
          The theme, colours and font you see, and how the sidebar, header and
          page width behave.
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="md" onClick={resetPreferences}>
            <RotateCcwIcon aria-hidden="true" />
            Restore defaults
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ToggleRow
          label="Theme"
          preference="theme_mode"
          options={THEME_MODE_OPTIONS}
        />
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
      </CardContent>
      <CardFooter className="text-muted-foreground">
        Saved in this browser. Nobody else&apos;s view changes.
      </CardFooter>
    </Card>
  );
}
