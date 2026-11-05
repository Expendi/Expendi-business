import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";

import { Text } from "./text";

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      className="flex-row gap-1 rounded-2xl bg-gray-100 p-1"
    >
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: option.value === value }}
          onPress={() => {
            if (option.value === value) return;
            void Haptics.selectionAsync().catch(() => undefined);
            onChange(option.value);
          }}
          className={`min-h-12 min-w-0 flex-1 items-center justify-center rounded-xl px-3 py-2 ${option.value === value ? "bg-white" : "bg-transparent"}`}
        >
          <Text
            className={`text-center text-sm font-semibold ${option.value === value ? "text-gray-900" : "text-gray-600"}`}
          >
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
