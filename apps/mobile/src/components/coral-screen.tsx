import type { JSX, ReactNode } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors } from "~/theme/colors";

/**
 * A tab root with a coral top and a white sheet overlapping it (Home). The
 * coral continues behind the scroll view so pulling to refresh stays coral.
 */
export function CoralScreen({
  top,
  children,
  refreshing = false,
  onRefresh,
}: {
  /** Sits on the coral: the pill header and the peeking gradient card. */
  top: ReactNode;
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-white">
      <View className="absolute left-0 right-0 top-0 h-1/2 bg-brand-500" />
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
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
        <View className="bg-brand-500 px-4" style={{ paddingTop: insets.top + 8 }}>
          <View className="mx-auto w-full max-w-3xl">{top}</View>
        </View>
        <View className="-mt-14 flex-1 rounded-t-[28px] bg-white px-5 pb-10 pt-6">
          <View className="mx-auto w-full max-w-3xl">{children}</View>
        </View>
      </ScrollView>
    </View>
  );
}
