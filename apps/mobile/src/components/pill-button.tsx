import type { LucideIcon } from "lucide-react-native";
import type { JSX } from "react";
import { Pressable } from "react-native";

import { Text } from "~/components/text";
import { colors } from "~/theme/colors";

/** A grey 44px pill with an optional leading icon and trailing chevron. */
export function PillButton({
  icon: Icon,
  trailingIcon: Trailing,
  label,
  accessibilityLabel,
  onPress,
}: {
  icon?: LucideIcon;
  trailingIcon?: LucideIcon;
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      className="min-h-11 flex-row items-center gap-1.5 rounded-full bg-gray-100 px-4 active:bg-gray-200"
    >
      {Icon ? (
        <Icon
          size={18}
          strokeWidth={1.75}
          color={colors.text}
          accessible={false}
        />
      ) : null}
      <Text className="text-[15px] font-semibold text-gray-900">{label}</Text>
      {Trailing ? (
        <Trailing
          size={16}
          strokeWidth={2}
          color={colors.muted}
          accessible={false}
        />
      ) : null}
    </Pressable>
  );
}
