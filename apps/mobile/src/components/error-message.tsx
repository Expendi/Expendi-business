import type { JSX } from "react";
import { CircleAlert } from "lucide-react-native";
import { View } from "react-native";

import { Text } from "~/components/text";
import { colors } from "~/theme/colors";

export function ErrorMessage({
  message,
}: {
  message: string | null;
}): JSX.Element | null {
  if (!message) return null;
  return (
    <View className="flex-row items-start gap-2 rounded-xl border border-error-700/15 bg-error-50 p-3">
      <CircleAlert size={18} color={colors.error} accessible={false} />
      <Text
        selectable
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        className="flex-1 text-sm leading-5 text-error-700"
      >
        {message}
      </Text>
    </View>
  );
}
