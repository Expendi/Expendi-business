import type { JSX } from "react";
import { ActivityIndicator, View } from "react-native";

import { colors } from "~/theme/colors";
import { BrandMark } from "./brand-mark";
import { Text } from "./text";

export function LoadingScreen({ label }: { label: string }): JSX.Element {
  return (
    <View className="flex-1 items-center justify-center gap-5 bg-gray-50 px-6">
      <BrandMark size={48} />
      <ActivityIndicator
        accessibilityLabel={label}
        color={colors.brandStrong}
      />
      <Text className="text-center text-sm text-gray-600">{label}</Text>
    </View>
  );
}
