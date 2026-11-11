import type { LucideIcon } from "lucide-react-native";
import type { JSX } from "react";
import { Pressable, View } from "react-native";

import { CappedText } from "~/components/text";
import { colors } from "~/theme/colors";

export interface QuickAction {
  label: string;
  icon: LucideIcon;
  /** A coral count on the circle, e.g. reimbursements waiting. */
  badge?: number;
  onPress: () => void;
}

/** Up to four 60px grey circles with a label underneath. */
export function QuickActions({
  actions,
}: {
  actions: readonly QuickAction[];
}): JSX.Element {
  return (
    <View className="flex-row justify-between">
      {actions.map(({ label, icon: Icon, badge, onPress }) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityLabel={
            badge ? `${label}, ${String(badge)} waiting` : label
          }
          onPress={onPress}
          className="min-w-0 flex-1 items-center active:opacity-70"
        >
          <View className="h-[60px] w-[60px] items-center justify-center rounded-full bg-gray-100">
            <Icon
              size={24}
              strokeWidth={1.75}
              color={colors.text}
              accessible={false}
            />
            {badge ? (
              <View className="absolute -right-0.5 -top-0.5 h-[22px] min-w-[22px] items-center justify-center rounded-full border-2 border-white bg-brand-500 px-1">
                <CappedText
                  size={12}
                  maxScale={1.2}
                  className="font-semibold text-gray-900"
                >
                  {String(badge)}
                </CappedText>
              </View>
            ) : null}
          </View>
          <CappedText
            size={14}
            lineHeight={20}
            maxScale={1.35}
            numberOfLines={2}
            className="mt-2 text-center font-medium text-gray-900"
          >
            {label}
          </CappedText>
        </Pressable>
      ))}
    </View>
  );
}
