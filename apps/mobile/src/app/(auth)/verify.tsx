import type { JSX } from "react";
import { useLoginWithEmail } from "@privy-io/expo";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";

import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { TextField } from "~/components/text-field";
import { useAuth } from "~/features/auth/auth-provider";

const CODE_LENGTH = 6;

export default function VerifyScreen(): JSX.Element {
  const router = useRouter();
  const { email } = useLocalSearchParams<{ email?: string }>();
  const { verifyEmailCode } = useAuth();
  const { sendCode, state: emailState } = useLoginWithEmail();
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!email) return <Redirect href="/sign-in" />;
  const sentTo = email;

  async function verify(value: string): Promise<void> {
    if (verifying) return;
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      await verifyEmailCode({ email: sentTo, code: value });
    } catch {
      setError(
        "That code didn't work. Check it and try again, or send a new one.",
      );
      setVerifying(false);
    }
  }

  async function resend(): Promise<void> {
    setError(null);
    setNotice(null);
    setCode("");
    try {
      await sendCode({ email: sentTo });
      setNotice(`We sent a new code to ${sentTo}.`);
    } catch {
      setError("We couldn't send a new code. Try again in a moment.");
    }
  }

  function handleCodeChange(value: string): void {
    const digits = value.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH) void verify(digits);
  }

  return (
    <Screen>
      <View className="gap-2 pt-8">
        <Text className="text-3xl font-bold text-gray-900">
          Check your email
        </Text>
        <Text className="text-base text-gray-600">
          Enter the 6-digit code we sent to {sentTo}.
        </Text>
      </View>

      <View className="gap-4">
        <TextField
          label="Code"
          value={code}
          onChangeText={handleCodeChange}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
          autoFocus
          editable={!verifying}
        />
        <ErrorMessage message={error} />
        {notice ? (
          <Text className="text-sm text-gray-600">{notice}</Text>
        ) : null}
        <Button
          label="Sign in"
          loading={verifying}
          disabled={code.length !== CODE_LENGTH}
          onPress={() => void verify(code)}
        />
        <Button
          label="Send a new code"
          variant="ghost"
          loading={emailState.status === "sending-code"}
          disabled={verifying}
          onPress={() => void resend()}
        />
        <Button
          label="Use a different email"
          variant="ghost"
          disabled={verifying}
          onPress={() => router.back()}
        />
      </View>
    </Screen>
  );
}
