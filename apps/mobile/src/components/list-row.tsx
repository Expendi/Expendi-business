import type { JSX, ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

interface ListRowProps {
  title: string;
  subtitle?: string;
  accessory?: ReactNode;
  onPress: () => void;
}

export function ListRow({
  title,
  subtitle,
  accessory,
  onPress,
}: ListRowProps): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      onPress={onPress}
      className="min-h-14 flex-row items-center gap-3 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-base font-semibold text-gray-900">{title}</Text>
        {subtitle ? (
          <Text className="text-sm text-gray-600">{subtitle}</Text>
        ) : null}
      </View>
      {accessory}
      <Text className="text-xl text-gray-400" importantForAccessibility="no">
        ›
      </Text>
    </Pressable>
  );
}
