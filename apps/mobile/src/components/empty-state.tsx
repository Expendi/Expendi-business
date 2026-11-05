import type { LucideIcon } from "lucide-react-native";
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
}) {
  return (
    <View className="flex-row items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
      <View className="rounded-xl bg-gray-50 p-2.5" accessible={false}>
        <Icon size={20} strokeWidth={1.75} color={colors.muted} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base font-medium leading-6 text-gray-900">
          {title}
        </Text>
        <Text className="text-sm leading-5 text-gray-600">{message}</Text>
      </View>
    </View>
  );
}
