import type { JSX } from "react";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { Button } from "./button";
import { ErrorMessage } from "./error-message";

const COPIED_FEEDBACK_MS = 2_000;

interface CopyButtonProps {
  value: string;
  label: string;
  failureMessage: string;
}

export function CopyButton({
  value,
  label,
  failureMessage,
}: CopyButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timeout);
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await Clipboard.setStringAsync(value);
      setFailed(false);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  }

  return (
    <View className="gap-2">
      <ErrorMessage message={failed ? failureMessage : null} />
      <Button
        label={copied ? "Copied" : label}
        variant="secondary"
        onPress={() => void copy()}
      />
    </View>
  );
}
