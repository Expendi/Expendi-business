import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";

/** Keep the dashboard's shape stable while its first request is pending. */
export function OverviewSkeleton() {
  return (
    <Animated.View
      entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
      accessible
      accessibilityLabel="Loading spending overview"
      accessibilityState={{ busy: true }}
      className="gap-6"
    >
      <View
        className="gap-4 rounded-2xl border border-gray-200 bg-white p-5"
        importantForAccessibility="no-hide-descendants"
      >
        <View className="h-4 w-28 rounded bg-gray-100" />
        <View className="h-9 w-48 rounded bg-gray-100" />
        <View className="h-4 w-full rounded bg-gray-100" />
        <View className="h-4 w-2/3 rounded bg-gray-100" />
      </View>
      {[0, 1, 2].map((row) => (
        <View
          key={row}
          className="gap-3 rounded-xl border border-gray-200 bg-white p-4"
          importantForAccessibility="no-hide-descendants"
        >
          <View className="h-4 w-1/2 rounded bg-gray-100" />
          <View className="h-4 w-3/4 rounded bg-gray-100" />
        </View>
      ))}
    </Animated.View>
  );
}
