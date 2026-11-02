import type { JSX } from "react";
import { useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";

import { MAX_RECEIPTS_PER_CLAIM } from "@expendi-business/shared";

import type { ReceiptSource } from "./receipt-upload";
import type { ReceiptSlot, ReceiptSlots } from "./use-receipt-slots";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { pickReceiptImage } from "./receipt-upload";

const NO_CAMERA =
  "Expendi Business can’t use the camera. Allow it in Settings, or choose an image instead.";
const PICKER_FAILED = "Couldn’t open that image. Try again.";

export function ReceiptPicker({
  receipts,
  error,
  disabled = false,
  label = "Receipt",
}: {
  receipts: ReceiptSlots;
  error?: string | null;
  disabled?: boolean;
  label?: string;
}): JSX.Element {
  const [pickError, setPickError] = useState<string | null>(null);
  const full = receipts.slots.length >= MAX_RECEIPTS_PER_CLAIM;

  async function pick(source: ReceiptSource): Promise<void> {
    setPickError(null);
    try {
      const result = await pickReceiptImage(source);
      if (result.status === "picked") receipts.add(result.image, source);
      if (result.status === "no-camera-access") setPickError(NO_CAMERA);
    } catch (cause) {
      console.warn("[claims] image picker failed", cause);
      setPickError(PICKER_FAILED);
    }
  }

  return (
    <View className="gap-3">
      <Text className="text-sm font-medium text-gray-700">{label}</Text>
      {receipts.slots.map((slot) => (
        <ReceiptRow
          key={slot.key}
          slot={slot}
          disabled={disabled}
          onRetry={() => receipts.retry(slot.key)}
          onRemove={() => receipts.remove(slot.key)}
        />
      ))}
      {full ? null : (
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Button
              label="Take a photo"
              variant="secondary"
              disabled={disabled}
              onPress={() => void pick("camera")}
            />
          </View>
          <View className="flex-1">
            <Button
              label="Choose image"
              variant="secondary"
              disabled={disabled}
              onPress={() => void pick("library")}
            />
          </View>
        </View>
      )}
      <ErrorMessage message={pickError ?? error ?? null} />
    </View>
  );
}

function ReceiptRow({
  slot,
  disabled,
  onRetry,
  onRemove,
}: {
  slot: ReceiptSlot;
  disabled: boolean;
  onRetry: () => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <View className="flex-row items-center gap-3 rounded-xl border border-gray-200 p-3">
      <Image
        source={{ uri: slot.previewUri }}
        accessibilityIgnoresInvertColors
        className="h-16 w-16 rounded-lg bg-gray-100"
        resizeMode="cover"
      />
      <View className="flex-1 gap-1">
        {slot.status === "uploading" ? (
          <View className="flex-row items-center gap-2">
            <ActivityIndicator accessibilityLabel="Uploading the receipt" />
            <Text className="text-sm text-gray-600">Uploading…</Text>
          </View>
        ) : null}
        {slot.status === "ready" ? (
          <Text className="text-sm text-gray-600">Uploaded</Text>
        ) : null}
        {slot.status === "failed" ? (
          <ErrorMessage message={slot.error} />
        ) : null}
      </View>
      <View className="gap-2">
        {slot.status === "failed" ? (
          <TextAction label="Retry" disabled={disabled} onPress={onRetry} />
        ) : null}
        <TextAction label="Remove" disabled={disabled} onPress={onRemove} />
      </View>
    </View>
  );
}

function TextAction({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={12}
      onPress={onPress}
    >
      <Text className="text-sm font-semibold text-gray-900 underline">
        {label}
      </Text>
    </Pressable>
  );
}
