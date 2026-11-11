import type { JSX } from "react";
import { Pressable, ScrollView } from "react-native";

import { Text } from "~/components/text";

export interface FilterPillOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/**
 * Single-choice pills that scroll sideways. The selected one takes the
 * primary-button pairing: coral-500 fill, gray-900 label.
 */
export function FilterPills<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** What the group filters, for screen readers. */
  label: string;
  options: readonly FilterPillOption<T>[];
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <ScrollView
      horizontal
      accessibilityLabel={label}
      accessibilityRole="tablist"
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              option.count === undefined
                ? option.label
                : `${option.label}, ${String(option.count)}`
            }
            onPress={() => onChange(option.value)}
            className={`min-h-9 flex-row items-center gap-1.5 rounded-full px-4 py-1.5 ${selected ? "bg-brand-500" : "bg-gray-100 active:bg-gray-200"}`}
          >
            <Text
              className={`text-[14px] ${selected ? "font-semibold text-gray-900" : "font-medium text-gray-700"}`}
            >
              {option.label}
            </Text>
            {option.count === undefined ? null : (
              <Text
                className={`text-[13px] font-semibold ${selected ? "text-gray-900/70" : "text-gray-500"}`}
              >
                {String(option.count)}
              </Text>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
