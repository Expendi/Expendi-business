import type { JSX } from "react";
import { useLinkWithPasskey } from "@privy-io/expo/passkey";
import { useState } from "react";
import { View } from "react-native";
import { isSupported as isPasskeySupported } from "react-native-passkeys";

import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { useAuth } from "~/features/auth/auth-provider";
import {
  isPasskeyAlreadyOnDevice,
  isPasskeyCancellation,
  PASSKEY_RELYING_PARTY,
} from "~/lib/passkeys";

export default function SetUpPasskeyScreen(): JSX.Element {
  const { finishPasskeyOffer } = useAuth();
  const { linkWithPasskey } = useLinkWithPasskey();
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = isPasskeySupported();

  async function handleSetUp(): Promise<void> {
    setLinking(true);
    setError(null);
    try {
      await linkWithPasskey({ relyingParty: PASSKEY_RELYING_PARTY });
      finishPasskeyOffer();
    } catch (linkError) {
      if (isPasskeyAlreadyOnDevice(linkError)) {
        finishPasskeyOffer();
        return;
      }
      if (!isPasskeyCancellation(linkError)) {
        setError("We couldn't set up a passkey. Try again, or skip for now.");
      }
      setLinking(false);
    }
  }

  return (
    <Screen>
      <View className="gap-2 pt-8">
        <Text className="text-3xl font-bold text-gray-900">
          Sign in faster next time
        </Text>
        <Text className="text-base text-gray-600">
          {supported
            ? "Set up a passkey and sign in with your fingerprint or face instead of an email code."
            : "This phone can't use passkeys. Turn on a screen lock to use one, or keep signing in with an email code."}
        </Text>
      </View>

      <View className="gap-4">
        <ErrorMessage message={error} />
        {supported ? (
          <Button
            label="Set up passkey"
            loading={linking}
            onPress={() => void handleSetUp()}
          />
        ) : null}
        <Button
          label={supported ? "Skip for now" : "Continue"}
          variant={supported ? "ghost" : "primary"}
          disabled={linking}
          onPress={finishPasskeyOffer}
        />
      </View>
    </Screen>
  );
}
