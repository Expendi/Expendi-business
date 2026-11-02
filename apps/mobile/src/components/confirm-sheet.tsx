import type { JSX, ReactNode } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "./button";
import { ErrorMessage } from "./error-message";

interface ConfirmSheetProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** Shown under the message, e.g. a field for a reason. */
  children?: ReactNode;
  /** For when "Cancel" would be ambiguous, e.g. on "Cancel bill". */
  dismissLabel?: string;
}

export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
  children,
  dismissLabel = "Cancel",
}: ConfirmSheetProps): JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={busy ? undefined : onCancel}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel="Close"
          className="absolute inset-0 bg-black/40"
          disabled={busy}
          onPress={onCancel}
        />
        <SafeAreaView
          edges={["bottom"]}
          className="gap-4 rounded-t-3xl bg-white px-6 pb-4 pt-6"
        >
          <Text
            accessibilityRole="header"
            className="text-xl font-bold text-gray-900"
          >
            {title}
          </Text>
          <Text className="text-base text-gray-600">{message}</Text>
          {children}
          <ErrorMessage message={error} />
          <Button
            label={confirmLabel}
            variant="danger"
            loading={busy}
            onPress={onConfirm}
          />
          <Button
            label={dismissLabel}
            variant="ghost"
            disabled={busy}
            onPress={onCancel}
          />
        </SafeAreaView>
      </View>
    </Modal>
  );
}
