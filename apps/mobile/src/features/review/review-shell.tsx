import type { JSX, ReactNode } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DetailHeader } from "~/components/detail-header";
import { colors } from "~/theme/colors";

/**
 * A pushed screen in direction K1: round-back header, scrolling content and
 * an optional footer that stays fixed under it.
 */
export function ReviewShell({
  title,
  onBack,
  right,
  footer,
  children,
  refreshing = false,
  onRefresh,
}: {
  title: string;
  onBack: () => void;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-white">
      <DetailHeader title={title} onBack={onBack} right={right} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="mx-auto w-full max-w-3xl px-5 pb-8 pt-4"
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.brandStrong}
              colors={[colors.brandStrong]}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
      {footer ? (
        <View
          className="border-t border-gray-100 bg-white px-5 pt-3"
          style={{ paddingBottom: insets.bottom + 8 }}
        >
          <View className="mx-auto w-full max-w-3xl">{footer}</View>
        </View>
      ) : null}
    </View>
  );
}
