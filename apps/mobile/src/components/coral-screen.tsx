import type { JSX, ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors } from "~/theme/colors";

/**
 * A screen with a coral top and a white sheet overlapping it (Home, sign-in).
 * The coral continues behind the scroll view so pulling to refresh stays
 * coral, and the sheet moves above the keyboard when it holds a form.
 */
export function CoralScreen({
  top,
  children,
  refreshing = false,
  onRefresh,
  bottomInset = false,
}: {
  /** Sits on the coral: the pill header and the peeking gradient card. */
  top: ReactNode;
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Pads for the home indicator when no tab bar sits under the screen. */
  bottomInset?: boolean;
}): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-white">
      <View className="absolute left-0 right-0 top-0 h-1/2 bg-brand-500" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.text}
                colors={[colors.brandStrong]}
              />
            ) : undefined
          }
        >
          <View
            className="bg-brand-500 px-4"
            style={{ paddingTop: insets.top + 8 }}
          >
            <View className="mx-auto w-full max-w-3xl">{top}</View>
          </View>
          <View
            className="-mt-14 flex-1 rounded-t-[28px] bg-white px-5 pt-6"
            style={{ paddingBottom: 40 + (bottomInset ? insets.bottom : 0) }}
          >
            <View className="mx-auto w-full max-w-3xl">{children}</View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
