import type { ReactNode } from "react";
import { View } from "react-native";

import { Text } from "./text";

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-3">
      <View className="gap-1">
        <Text
          accessibilityRole="header"
          className="text-lg font-semibold leading-6 text-gray-900"
        >
          {title}
        </Text>
        {description ? (
          <Text className="text-sm leading-5 text-gray-600">{description}</Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}
