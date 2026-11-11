import type { JSX } from "react";
import { Pressable, View } from "react-native";

import { CappedText, Text } from "~/components/text";

/** 18px SemiBold section title, an optional coral count and a link on the right. */
export function SectionHeader({
  title,
  count,
  action,
  onAction,
}: {
  title: string;
  count?: number;
  action?: string;
  onAction?: () => void;
}): JSX.Element {
  return (
    <View className="mb-3 min-h-11 flex-row items-center justify-between gap-3">
      <View className="min-w-0 flex-1 flex-row items-center gap-2">
        <Text
          accessibilityRole="header"
          className="shrink text-[18px] font-semibold leading-6 text-gray-900"
        >
          {title}
        </Text>
        {count === undefined ? null : (
          <View
            accessibilityLabel={`${String(count)} items`}
            className="h-6 min-w-6 items-center justify-center rounded-full bg-brand-500 px-2"
          >
            <CappedText
              size={13}
              maxScale={1.3}
              className="font-semibold text-gray-900"
            >
              {String(count)}
            </CappedText>
          </View>
        )}
      </View>
      {action && onAction ? (
        <Pressable
          accessibilityRole="link"
          hitSlop={8}
          onPress={onAction}
          className="min-h-11 justify-center"
        >
          <Text className="text-[15px] font-semibold text-brand-700">
            {action}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
