import type { JSX, ReactNode } from "react";
import { ChevronLeft } from "lucide-react-native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RoundButton } from "~/components/round-button";
import { Text } from "~/components/text";

/**
 * A pushed screen's header: round back button, centred 17px title and an
 * optional item on the right. Use with `headerShown: false`.
 */
export function DetailHeader({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack: () => void;
  right?: ReactNode;
}): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="min-h-11 flex-row items-center justify-between gap-3 bg-white px-4 pb-2"
      style={{ paddingTop: insets.top + 4 }}
    >
      <RoundButton icon={ChevronLeft} label="Back" onPress={onBack} />
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        className="flex-1 text-center text-[17px] font-semibold text-gray-900"
      >
        {title}
      </Text>
      <View className="min-w-11 items-end">{right}</View>
    </View>
  );
}
