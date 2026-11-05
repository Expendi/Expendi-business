import type { JSX } from "react";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { MPESA_SMS_MAX_LENGTH } from "@expendi-business/shared";

import type { Prefill } from "./draft";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { describeApiError } from "~/lib/api";
import { readPastedSms, smsPrefill } from "./draft";
import { useRegisterSms } from "./use-claims";

/** A pasted M-Pesa SMS the API has kept as the claim's evidence. */
export interface AttachedSms {
  receiptFileId: string;
  text: string;
}

/**
 * "Paste M-Pesa SMS": the phone reads it first, so an unknown message falls
 * back to manual entry at once; a readable one is kept by the API, which
 * reads it again, and then fills in the form (spec §6.4).
 */
export function SmsEvidence({
  organizationId,
  attached,
  disabled = false,
  onAttach,
  onRemove,
}: {
  organizationId: string;
  attached: AttachedSms | null;
  disabled?: boolean;
  onAttach: (sms: AttachedSms, prefill: Prefill) => void;
  onRemove: () => void;
}): JSX.Element {
  const register = useRegisterSms(organizationId);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [readError, setReadError] = useState<string | null>(null);

  if (attached) {
    return (
      <View className="gap-2 rounded-xl border border-gray-200 p-3">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-medium text-gray-700">M-Pesa SMS</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            hitSlop={12}
            onPress={onRemove}
          >
            <Text className="text-sm font-semibold text-gray-900 underline">
              Remove
            </Text>
          </Pressable>
        </View>
        <Text className="text-sm text-gray-600" numberOfLines={4}>
          {attached.text}
        </Text>
      </View>
    );
  }

  if (!pasting) {
    return (
      <Button
        label="Paste M-Pesa SMS"
        variant="secondary"
        disabled={disabled}
        onPress={() => setPasting(true)}
      />
    );
  }

  function attachSms(): void {
    const reading = readPastedSms(text);
    if (!reading.ok) {
      setReadError(reading.message);
      return;
    }
    setReadError(null);
    register.mutate(
      { text: reading.text },
      {
        onSuccess: ({ receiptFileId, sms }) => {
          onAttach(
            { receiptFileId, text: reading.text.trim() },
            smsPrefill(sms),
          );
          setPasting(false);
          setText("");
        },
      },
    );
  }

  return (
    <View className="gap-3">
      <TextField
        label="M-Pesa SMS"
        value={text}
        onChangeText={(value) => {
          setText(value);
          setReadError(null);
        }}
        placeholder="Paste the M-Pesa confirmation message"
        multiline
        autoCorrect={false}
        maxLength={MPESA_SMS_MAX_LENGTH}
      />
      <ErrorMessage
        message={
          readError ??
          (register.isError ? describeApiError(register.error) : null)
        }
      />
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button
            label="Use this SMS"
            loading={register.isPending}
            disabled={disabled || text.trim() === ""}
            onPress={attachSms}
          />
        </View>
        <View className="flex-1">
          <Button
            label="Cancel"
            variant="ghost"
            disabled={register.isPending}
            onPress={() => {
              setPasting(false);
              setText("");
              setReadError(null);
              register.reset();
            }}
          />
        </View>
      </View>
    </View>
  );
}
