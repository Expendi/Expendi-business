import type { LucideIcon } from "lucide-react-native";
import type { JSX } from "react";
import { Pressable } from "react-native";

import { colors } from "~/theme/colors";

type RoundButtonTone = "gray" | "brand" | "white";

const TONE_CLASSES: Record<RoundButtonTone, string> = {
  gray: "bg-gray-100 active:bg-gray-200",
  brand: "bg-brand-500 active:opacity-80",
  white: "bg-white active:bg-gray-100",
};

/** A 44px icon-only button; `label` is what screen readers announce. */
export function RoundButton({
  icon: Icon,
  label,
  onPress,
  tone = "gray",
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  tone?: RoundButtonTone;
}): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      className={`h-11 w-11 items-center justify-center rounded-full ${TONE_CLASSES[tone]}`}
    >
      <Icon size={20} strokeWidth={2} color={colors.text} accessible={false} />
    </Pressable>
  );
}
