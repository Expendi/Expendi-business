import type { JSX } from "react";
import { Text } from "react-native";

export function ErrorMessage({
  message,
}: {
  message: string | null;
}): JSX.Element | null {
  if (!message) return null;
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      className="text-sm text-error-700"
    >
      {message}
    </Text>
  );
}
