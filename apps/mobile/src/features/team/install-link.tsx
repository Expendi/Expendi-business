import type { JSX } from "react";
import { useState } from "react";
import { Share, View } from "react-native";

import { Button } from "~/components/button";
import { CopyButton } from "~/components/copy-button";
import { ErrorMessage } from "~/components/error-message";
import { Text } from "~/components/text";

interface InstallLinkProps {
  url: string;
  inviteeEmail: string;
  companyName: string;
}

/** For when the invite email didn't go out and the admin passes the link on themselves. */
export function InstallLink({
  url,
  inviteeEmail,
  companyName,
}: InstallLinkProps): JSX.Element {
  const [shareFailed, setShareFailed] = useState(false);

  async function share(): Promise<void> {
    try {
      await Share.share({
        message: `You’re invited to ${companyName} on Expendi Business. Install the app from ${url} and sign in with ${inviteeEmail}.`,
      });
      setShareFailed(false);
    } catch {
      setShareFailed(true);
    }
  }

  return (
    <View className="gap-3">
      <Text
        selectable
        accessibilityLabel={`Install link ${url}`}
        className="rounded-xl bg-gray-50 p-4 text-sm text-gray-900"
      >
        {url}
      </Text>
      <ErrorMessage
        message={
          shareFailed ? "Couldn’t open sharing. Copy the link instead." : null
        }
      />
      <Button label="Share link" onPress={() => void share()} />
      <CopyButton
        value={url}
        label="Copy link"
        failureMessage="Couldn’t copy the link. Select it and copy it instead."
      />
    </View>
  );
}
