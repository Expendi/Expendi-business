import type { JSX, ReactNode } from "react";
import { X } from "lucide-react-native";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Text } from "~/components/text";
import { colors } from "~/theme/colors";
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
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 justify-end"
      >
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          className="absolute inset-0 bg-black/40"
          disabled={busy}
          onPress={onCancel}
        />
        <SafeAreaView
          edges={["bottom"]}
          accessibilityViewIsModal
          className="max-h-[90%] rounded-t-3xl bg-white"
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-4 px-5 pb-5 pt-6"
          >
            <View className="flex-row items-start justify-between gap-3">
              <Text
                accessibilityRole="header"
                className="flex-1 pt-2 text-xl font-semibold leading-7 text-gray-900"
              >
                {title}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close confirmation"
                disabled={busy}
                onPress={onCancel}
                className={`h-11 w-11 items-center justify-center rounded-full bg-gray-100 ${busy ? "opacity-50" : "active:bg-gray-200"}`}
              >
                <X size={20} color={colors.secondary} accessible={false} />
              </Pressable>
            </View>
            <Text className="text-base leading-6 text-gray-600">{message}</Text>
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
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
