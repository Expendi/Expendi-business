import type { JSX } from "react";
import { Modal, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "~/components/button";

/**
 * Explains notifications before the system asks, once: a "Don't allow" on
 * the system prompt can't be asked again, so it shouldn't come unexplained.
 */
export function PushPrePrompt({
  visible,
  busy,
  onAllow,
  onNotNow,
}: {
  visible: boolean;
  busy: boolean;
  onAllow: () => void;
  onNotNow: () => void;
}): JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={busy ? undefined : onNotNow}
    >
      <View className="flex-1 justify-end bg-black/40">
        <SafeAreaView
          edges={["bottom"]}
          className="gap-4 rounded-t-3xl bg-white px-6 pb-4 pt-6"
        >
          <Text
            accessibilityRole="header"
            className="text-xl font-bold text-gray-900"
          >
            Know when your claims move
          </Text>
          <Text className="text-base text-gray-600">
            We’ll tell you when a claim is paid or rejected, and tell admins
            when a claim is waiting for them. Nothing else.
          </Text>
          <Button
            label="Turn on notifications"
            loading={busy}
            onPress={onAllow}
          />
          <Button
            label="Not now"
            variant="ghost"
            disabled={busy}
            onPress={onNotNow}
          />
        </SafeAreaView>
      </View>
    </Modal>
  );
}
