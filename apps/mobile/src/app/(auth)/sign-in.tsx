import type { JSX } from "react";
import { useLoginWithEmail } from "@privy-io/expo";
import { useLoginWithPasskey } from "@privy-io/expo/passkey";
import { useRouter } from "expo-router";
import { ArrowRight, Fingerprint } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { isSupported as isPasskeySupported } from "react-native-passkeys";

import { BrandMark } from "~/components/brand-mark";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
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
    <Screen centered>
      <View className="mx-auto w-full max-w-md gap-8">
        <View className="flex-row items-center gap-3">
          <BrandMark />
          <Text className="text-lg font-semibold text-gray-900">
            Expendi Business
          </Text>
        </View>
        <View className="gap-3">
          <Text
            accessibilityRole="header"
            className="text-3xl font-semibold leading-10 text-gray-900"
          >
            Sign in to your workspace
          </Text>
          <Text className="text-base leading-6 text-gray-600">
            Sign in with your work email. We’ll send you a 6-digit code.
          </Text>
        </View>

        <View className="gap-5 rounded-2xl border border-gray-200 bg-white p-5">
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
            icon={ArrowRight}
            loading={sendingCode}
            disabled={normalizedEmail.length === 0 || passkeyBusy}
            onPress={() => void handleSendCode()}
          />
          {isPasskeySupported() ? (
            <View className="gap-4">
              <View className="flex-row items-center gap-3">
                <View className="h-px flex-1 bg-gray-200" />
                <Text className="shrink text-center text-xs text-gray-500">
                  Or use your passkey
                </Text>
                <View className="h-px flex-1 bg-gray-200" />
              </View>
              <Button
                label="Sign in with passkey"
                icon={Fingerprint}
                variant="secondary"
                loading={passkeyBusy}
                disabled={sendingCode}
                onPress={() => void handlePasskeySignIn()}
              />
            </View>
          ) : null}
        </View>
        <Text className="text-center text-sm leading-5 text-gray-500">
          Claims, payments and company spending, in one workspace for your team.
        </Text>
      </View>
    </Screen>
  );
}
