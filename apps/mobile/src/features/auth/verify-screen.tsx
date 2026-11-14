import type { JSX } from "react";
import { useLoginWithEmail } from "@privy-io/expo";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { AuthShell } from "./auth-shell";
import { useAuth } from "./auth-provider";

const CODE_LENGTH = 6;

/** Step two of email sign-in: the code sent to `email`. */
export function VerifyScreen({ email }: { email: string }): JSX.Element {
  const router = useRouter();
  const { verifyEmailCode } = useAuth();
  const { sendCode, state: emailState } = useLoginWithEmail();
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function verify(value: string): Promise<void> {
    if (verifying) return;
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      await verifyEmailCode({ email, code: value });
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
      await sendCode({ email });
      setNotice(`We sent a new code to ${email}.`);
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
    <AuthShell
      title="Check your email"
      description={
        <>
          Enter the 6-digit code we sent to{" "}
          <Text className="font-semibold text-gray-900">{email}</Text>.
        </>
      }
    >
      <View className="gap-4">
        <TextField
          label="Code"
          helper="The code has 6 digits."
          style={{
            fontVariant: ["tabular-nums"],
            letterSpacing: 8,
            textAlign: "center",
            fontSize: 24,
          }}
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
          <Text
            accessibilityLiveRegion="polite"
            className="text-[14px] leading-5 text-gray-600"
          >
            {notice}
          </Text>
        ) : null}
        <Button
          label="Sign in"
          loading={verifying}
          disabled={code.length !== CODE_LENGTH}
          onPress={() => void verify(code)}
        />
        <Button
          label="Send a new code"
          variant="secondary"
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
    </AuthShell>
  );
}
