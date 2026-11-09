import type { JSX, ReactNode } from "react";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { isSupported as isPasskeySupported } from "react-native-passkeys";

import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Text } from "~/components/text";
import { useAuth } from "~/features/auth/auth-provider";
import { describeApiError } from "~/lib/api";
import {
  describeApprovalError,
  isRecentLoginRequired,
  useApprovalPasskeyStatus,
  useEnrolApprovalPasskey,
} from "./use-approval-passkey";

export interface PasskeySetupCopy {
  readonly title: string;
  readonly description: string;
}

const PAYMENTS_SETUP_COPY: PasskeySetupCopy = {
  title: "Set up your approval passkey",
  description:
    "You confirm every payment and withdrawal with your fingerprint or face. Set it up once on this phone.",
};

/**
 * Shows `children` once the person has an approval passkey; until then,
 * asks them to set one up. Every money action needs it (spec §7.3), and so
 * does seeing a card's details, so `setupCopy` can say what it's for.
 */
export function ApprovalPasskeyGate({
  children,
  setupCopy,
}: {
  children: ReactNode;
  setupCopy?: PasskeySetupCopy;
}): JSX.Element {
  const status = useApprovalPasskeyStatus();

  if (status.isPending) {
    return <ActivityIndicator accessibilityLabel="Checking your passkey" />;
  }
  if (status.isError) {
    return (
      <View className="gap-4">
        <ErrorMessage message={describeApiError(status.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={status.isFetching}
          onPress={() => void status.refetch()}
        />
      </View>
    );
  }
  if (!status.data.enrolled) return <SetUpApprovalPasskey copy={setupCopy} />;
  return <>{children}</>;
}

export function SetUpApprovalPasskey({
  copy = PAYMENTS_SETUP_COPY,
}: {
  copy?: PasskeySetupCopy | undefined;
}): JSX.Element {
  const enrol = useEnrolApprovalPasskey();
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const supported = isPasskeySupported();
  const needsSignIn = enrol.isError && isRecentLoginRequired(enrol.error);

  async function handleSignInAgain(): Promise<void> {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <View
      accessibilityRole="summary"
      className="gap-4 rounded-2xl border border-gray-200 p-5"
    >
      <View className="gap-1">
        <Text className="text-lg font-bold text-gray-900">{copy.title}</Text>
        <Text className="text-base text-gray-600">
          {supported
            ? copy.description
            : "This phone can't use passkeys. Turn on a screen lock, then come back to set one up."}
        </Text>
      </View>

      {needsSignIn ? (
        <View className="gap-3">
          <Text className="text-sm text-gray-700">
            For your security, sign in again first. Then come back here to set
            up your passkey within 10 minutes.
          </Text>
          <Button
            label="Sign in again"
            loading={signingOut}
            onPress={() => void handleSignInAgain()}
          />
        </View>
      ) : supported ? (
        <View className="gap-3">
          <ErrorMessage
            message={enrol.isError ? describeApprovalError(enrol.error) : null}
          />
          <Button
            label="Set up passkey"
            loading={enrol.isPending}
            onPress={() => enrol.mutate()}
          />
        </View>
      ) : null}
    </View>
  );
}
