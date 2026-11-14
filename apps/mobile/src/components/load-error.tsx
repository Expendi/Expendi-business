import type { JSX } from "react";
import { View } from "react-native";

import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";

/** A failed request: what went wrong and a way to try again. */
export function LoadError({
  message,
  onRetry,
  retrying = false,
  retryLabel = "Try again",
}: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
  retryLabel?: string;
}): JSX.Element {
  return (
    <View className="gap-3">
      <ErrorMessage message={message} />
      <Button
        label={retryLabel}
        variant="secondary"
        loading={retrying}
        onPress={onRetry}
      />
    </View>
  );
}
