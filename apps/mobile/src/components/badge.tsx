import type { JSX } from "react";
import { View } from "react-native";

import { Text } from "~/components/text";

type BadgeTone = "neutral" | "success" | "warning";

const TONE_CLASSES: Record<BadgeTone, { container: string; label: string }> = {
  neutral: { container: "bg-gray-100", label: "text-gray-700" },
  success: { container: "bg-green-50", label: "text-green-800" },
  warning: { container: "bg-amber-50", label: "text-amber-800" },
};

export function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: BadgeTone;
}): JSX.Element {
  const classes = TONE_CLASSES[tone];
  return (
    <View
      className={`self-start rounded-full px-2.5 py-1 ${classes.container}`}
    >
      <Text className={`text-xs font-semibold ${classes.label}`}>{label}</Text>
    </View>
  );
}
