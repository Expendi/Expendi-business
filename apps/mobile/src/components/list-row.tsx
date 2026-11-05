import type { LucideIcon } from "lucide-react-native";
import type { JSX, ReactNode } from "react";
import { ChevronRight } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Text } from "~/components/text";
import { colors } from "~/theme/colors";

interface ListRowProps {
  title: string;
  subtitle?: string;
  accessory?: ReactNode;
  onPress: () => void;
  icon?: LucideIcon;
}

export function ListRow({
  title,
  subtitle,
  accessory,
  onPress,
  icon: Icon,
}: ListRowProps): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      onPress={onPress}
      className="min-h-16 flex-row items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-4 active:bg-brand-50"
    >
      {Icon ? (
        <View className="rounded-xl bg-brand-50 p-2.5" accessible={false}>
          <Icon size={20} strokeWidth={1.75} color={colors.brandStrong} />
        </View>
      ) : null}
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base font-medium leading-6 text-gray-900">
          {title}
        </Text>
        {subtitle ? (
          <Text className="text-sm leading-5 text-gray-600">{subtitle}</Text>
        ) : null}
      </View>
      {accessory ? (
        <View className="max-w-[40%] shrink">{accessory}</View>
      ) : null}
      <ChevronRight
        size={18}
        strokeWidth={1.75}
        color={colors.muted}
        accessible={false}
      />
    </Pressable>
  );
}
