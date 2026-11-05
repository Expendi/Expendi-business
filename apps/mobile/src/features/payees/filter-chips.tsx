import type { JSX } from "react";
import { Pressable, View } from "react-native";

import { Text } from "~/components/text";

export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

/** A compact single choice that wraps onto as many lines as it needs. */
export function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly ChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <View
      className="gap-2"
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      <Text className="text-sm font-medium text-gray-700">{label}</Text>
      <View className="flex-row flex-wrap gap-2">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: selected }}
              onPress={() => onChange(option.value)}
              className={`min-h-11 justify-center rounded-full border px-4 active:opacity-80 ${selected ? "border-gray-900 bg-gray-900" : "border-gray-300 bg-white"}`}
            >
              <Text
                className={`text-sm font-semibold ${selected ? "text-white" : "text-gray-900"}`}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
