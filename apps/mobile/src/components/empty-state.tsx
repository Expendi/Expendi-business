import type { LucideIcon } from "lucide-react-native";
import type { JSX } from "react";
import { View } from "react-native";

import { colors } from "~/theme/colors";
import { Text } from "./text";

export function EmptyState({
  title,
  message,
  icon: Icon,
}: {
  title: string;
  message: string;
  icon: LucideIcon;
}): JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={`${title}. ${message}`}
      className="flex-row items-center gap-3 rounded-3xl bg-gray-50 px-4 py-4"
    >
      <View className="h-11 w-11 items-center justify-center rounded-full bg-white">
        <Icon size={20} strokeWidth={1.75} color={colors.muted} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[16px] font-semibold leading-[22px] text-gray-900">
          {title}
        </Text>
        <Text className="text-[14px] leading-5 text-gray-600">{message}</Text>
      </View>
    </View>
  );
}
