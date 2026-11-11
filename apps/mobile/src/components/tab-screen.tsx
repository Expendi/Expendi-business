import type { JSX, ReactNode } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "~/components/text";
import { colors } from "~/theme/colors";

/** A tab root's 30px SemiBold title with round or pill actions on the right. */
export function ScreenTitle({
  title,
  right,
}: {
  title: string;
  right?: ReactNode;
}): JSX.Element {
  return (
    <View className="min-h-11 flex-row items-center justify-between gap-3">
      <Text
        accessibilityRole="header"
        className="shrink text-[30px] font-semibold leading-9 tracking-[-0.5px] text-gray-900"
      >
        {title}
      </Text>
      {right ? (
        <View className="flex-row items-center gap-2">{right}</View>
      ) : null}
    </View>
  );
}

/** A white tab root: large title, scrolling content, pull to refresh. */
export function TabScreen({
  title,
  right,
  children,
  refreshing = false,
  onRefresh,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-white">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 12 }}
        contentContainerClassName="mx-auto w-full max-w-3xl px-5 pb-10"
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
        <ScreenTitle title={title} right={right} />
        <View className="pt-5">{children}</View>
      </ScrollView>
    </View>
  );
}
