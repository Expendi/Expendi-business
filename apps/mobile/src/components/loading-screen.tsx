import type { JSX } from "react";
import { ActivityIndicator, View } from "react-native";

export function LoadingScreen({ label }: { label: string }): JSX.Element {
  return (
    <View className="flex-1 items-center justify-center bg-white">
      <ActivityIndicator accessibilityLabel={label} color="#111827" />
    </View>
  );
}
