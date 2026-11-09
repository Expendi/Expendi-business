import type { JSX } from "react";
import type { Edge } from "react-native-safe-area-context";
import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, Platform, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import type { RevealSession } from "./card-api";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Text } from "~/components/text";
import { colors } from "~/theme/colors";
import {
  httpsOrigin,
  mayNavigateReveal,
  revealLifetimeMs,
  revealMustClose,
} from "./card-reveal";

const ALL_EDGES: Edge[] = ["top", "right", "bottom", "left"];

/**
 * The library hands anything outside its whitelist to the phone's browser,
 * and logs it. Letting everything through to `onShouldStartLoadWithRequest`
 * means a blocked page is just blocked.
 */
const LET_THE_GUARD_DECIDE = ["*"];

const COULD_NOT_LOAD =
  "Your card details couldn't be shown. Close this and try again.";

/**
 * Lithic's page in a full-screen WebView: the card number never touches the
 * app. The session in `session.url` is passed to the WebView and nowhere else,
 * so nothing may log it, and this unmounts as soon as the person leaves.
 */
export function RevealedCardDetails({
  session,
  onClose,
}: {
  session: RevealSession;
  onClose: () => void;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const origin = httpsOrigin(session.url);

  useEffect(() => {
    if (revealMustClose(AppState.currentState)) {
      onClose();
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (revealMustClose(state)) onClose();
    });
    return () => subscription.remove();
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(
      onClose,
      revealLifetimeMs(session.expiresAt, Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session.expiresAt, onClose]);

  return (
    <SafeAreaView edges={ALL_EDGES} className="flex-1 bg-gray-50">
      <View className="gap-1 px-5 py-3">
        <Text
          accessibilityRole="header"
          className="text-lg font-semibold text-gray-900"
        >
          Your card details
        </Text>
        <Text className="text-sm text-gray-600">
          These hide after a few minutes. Keep them private.
        </Text>
      </View>
      {origin === null || failed ? (
        <View className="flex-1 px-5">
          <ErrorMessage message={COULD_NOT_LOAD} />
        </View>
      ) : (
        <WebView
          source={{ uri: session.url }}
          style={{ flex: 1, backgroundColor: colors.background }}
          originWhitelist={LET_THE_GUARD_DECIDE}
          onShouldStartLoadWithRequest={(request) =>
            mayNavigateReveal(origin, request)
          }
          // `cacheEnabled` alone doesn't stop iOS keeping site data; on Android,
          // `incognito` would also wipe the cookies of every other WebView.
          incognito={Platform.OS === "ios"}
          cacheEnabled={false}
          cacheMode="LOAD_NO_CACHE"
          setSupportMultipleWindows={false}
          allowsLinkPreview={false}
          startInLoadingState
          renderLoading={() => (
            <View className="absolute inset-0 items-center justify-center">
              <ActivityIndicator accessibilityLabel="Loading your card details" />
            </View>
          )}
          onError={() => setFailed(true)}
          onHttpError={() => setFailed(true)}
          onRenderProcessGone={onClose}
          onContentProcessDidTerminate={onClose}
        />
      )}
      <View className="px-5 py-3">
        <Button label="Done" variant="secondary" onPress={onClose} />
      </View>
    </SafeAreaView>
  );
}
