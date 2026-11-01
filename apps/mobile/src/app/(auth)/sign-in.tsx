import type { JSX } from "react";
import { useLoginWithEmail } from "@privy-io/expo";
import { useLoginWithPasskey } from "@privy-io/expo/passkey";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { isSupported as isPasskeySupported } from "react-native-passkeys";

import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { TextField } from "~/components/text-field";
import { isPasskeyCancellation, PASSKEY_RELYING_PARTY } from "~/lib/passkeys";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignInScreen(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { sendCode, state: emailState } = useLoginWithEmail();
  const { loginWithPasskey, state: passkeyState } = useLoginWithPasskey();

  const normalizedEmail = email.trim().toLowerCase();
  const sendingCode = emailState.status === "sending-code";
  const passkeyBusy =
    passkeyState.status === "generating-challenege" ||
    passkeyState.status === "awaiting-passkey" ||
    passkeyState.status === "submitting-response";

  async function handleSendCode(): Promise<void> {
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    try {
      await sendCode({ email: normalizedEmail });
      router.push({ pathname: "/verify", params: { email: normalizedEmail } });
    } catch {
      setError("We couldn't send a code to that email. Try again.");
    }
  }

  async function handlePasskeySignIn(): Promise<void> {
    setError(null);
    try {
      await loginWithPasskey({ relyingParty: PASSKEY_RELYING_PARTY });
    } catch (passkeyError) {
      if (isPasskeyCancellation(passkeyError)) return;
      setError(
        "That passkey didn't work. Sign in with your email, then set up a passkey again.",
      );
    }
  }

  return (
    <Screen>
      <View className="gap-2 pt-8">
        <Text className="text-3xl font-bold text-gray-900">
          Expendi Business
        </Text>
        <Text className="text-base text-gray-600">
          Sign in with your work email. We’ll send you a 6-digit code.
        </Text>
      </View>

      <View className="gap-4">
        <TextField
          label="Work email"
          value={email}
          onChangeText={setEmail}
          placeholder="you@company.co.ke"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="send"
          onSubmitEditing={() => void handleSendCode()}
          editable={!sendingCode && !passkeyBusy}
        />
        <ErrorMessage message={error} />
        <Button
          label="Email me a code"
          loading={sendingCode}
          disabled={normalizedEmail.length === 0 || passkeyBusy}
          onPress={() => void handleSendCode()}
        />
      </View>

      {isPasskeySupported() ? (
        <View className="gap-4">
          <View className="flex-row items-center gap-3">
            <View className="h-px flex-1 bg-gray-200" />
            <Text className="text-sm text-gray-500">
              Used this phone before?
            </Text>
            <View className="h-px flex-1 bg-gray-200" />
          </View>
          <Button
            label="Sign in with passkey"
            variant="secondary"
            loading={passkeyBusy}
            disabled={sendingCode}
            onPress={() => void handlePasskeySignIn()}
          />
        </View>
      ) : null}
    </Screen>
  );
}
