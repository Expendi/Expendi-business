import type { JSX } from "react";
import { View } from "react-native";

import { Text } from "~/components/text";

export function RejectionNotice({ reason }: { reason: string }): JSX.Element {
  return (
    <View
      accessibilityRole="summary"
      className="gap-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
    >
      <Text className="text-sm font-semibold text-amber-800">
        Why it was rejected
      </Text>
      <Text className="text-base text-gray-900">{reason}</Text>
      <Text className="text-sm text-gray-600">
        Fix what’s needed and resubmit it for approval.
      </Text>
    </View>
  );
}
