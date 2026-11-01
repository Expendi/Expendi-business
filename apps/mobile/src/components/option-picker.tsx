import type { JSX } from "react";
import { Pressable, Text, View } from "react-native";

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

interface OptionPickerProps<T extends string> {
  label: string;
  options: readonly PickerOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}

export function OptionPicker<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: OptionPickerProps<T>): JSX.Element {
  return (
    <View
      className="gap-2"
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      <Text className="text-sm font-medium text-gray-700">{label}</Text>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityHint={option.description}
            accessibilityState={{ checked: selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            className={`min-h-14 flex-row items-center gap-3 rounded-xl border px-4 py-3 active:opacity-80 ${selected ? "border-gray-900 bg-gray-50" : "border-gray-300 bg-white"} ${disabled ? "opacity-50" : ""}`}
          >
            <View
              className={`h-5 w-5 items-center justify-center rounded-full border-2 ${selected ? "border-gray-900" : "border-gray-400"}`}
            >
              {selected ? (
                <View className="h-2.5 w-2.5 rounded-full bg-gray-900" />
              ) : null}
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="text-base font-semibold text-gray-900">
                {option.label}
              </Text>
              {option.description ? (
                <Text className="text-sm text-gray-600">
                  {option.description}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
