import type { LucideIcon } from "lucide-react-native";
import type { JSX, ReactNode } from "react";
import type { AccessibilityRole, AccessibilityState } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { Children, Fragment } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";

import { Avatar } from "~/components/avatar";
import { Text } from "~/components/text";
import { colors } from "~/theme/colors";

/** The soft grey container: no border, 24px radius, hairlines between rows. */
export function SoftGroup({ children }: { children: ReactNode }): JSX.Element {
  const rows = Children.toArray(children);
  return (
    <View className="rounded-3xl bg-gray-50 px-4">
      {rows.map((row, index) => (
        <Fragment key={index}>
          {index === 0 ? null : <View className="h-px bg-gray-200/70" />}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

export type IconTone = "brand" | "neutral" | "negative" | "positive";

const ICON_COLORS: Record<IconTone, string> = {
  brand: colors.brandStrong,
  neutral: colors.iconNeutral,
  negative: colors.error,
  positive: colors.success,
};

const ICON_BACKGROUNDS: Record<IconTone, string> = {
  brand: "bg-white",
  neutral: "bg-white",
  negative: "bg-error-50",
  positive: "bg-success-50",
};

const META_CLASSES = {
  default: "text-gray-600",
  negative: "font-medium text-error-700",
  positive: "font-medium text-success-700",
} as const;

const AMOUNT_CLASSES = {
  default: "text-gray-900",
  muted: "text-gray-500",
  /** For "Add amount" and similar calls to act. */
  action: "text-brand-700",
} as const;

export interface ItemRowProps {
  title: string;
  meta?: string;
  metaTone?: keyof typeof META_CLASSES;
  /** Already formatted, e.g. "8,999.00" or "Add amount". */
  amount?: string;
  amountTone?: keyof typeof AMOUNT_CLASSES;
  /** Right-hand text that isn't an amount, e.g. "On". */
  value?: string;
  /** Replaces the amount or value on the right. */
  trailing?: ReactNode;
  icon?: LucideIcon;
  iconTone?: IconTone;
  /** Shows the person's initials instead of an icon. */
  avatarName?: string;
  /** Replaces the icon or avatar, e.g. a checkbox. */
  leading?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
}

/** A row in a `SoftGroup`: 44px icon circle, title over meta, amount, chevron. */
export function ItemRow({
  title,
  meta,
  metaTone = "default",
  amount,
  amountTone = "default",
  value,
  trailing,
  icon: Icon,
  iconTone = "brand",
  avatarName,
  leading,
  onPress,
  accessibilityLabel,
  accessibilityRole = "button",
  accessibilityState,
}: ItemRowProps): JSX.Element {
  const start =
    leading ??
    (avatarName !== undefined ? (
      <Avatar name={avatarName} />
    ) : Icon ? (
      <View
        accessible={false}
        className={`h-11 w-11 items-center justify-center rounded-full ${ICON_BACKGROUNDS[iconTone]}`}
      >
        <Icon size={20} strokeWidth={1.75} color={ICON_COLORS[iconTone]} />
      </View>
    ) : null);
  const end =
    trailing ??
    (amount !== undefined ? (
      <Text
        className={`text-right text-[16px] font-semibold ${AMOUNT_CLASSES[amountTone]}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {amount}
      </Text>
    ) : value !== undefined ? (
      <Text className="text-right text-[15px] text-gray-600">{value}</Text>
    ) : null);
  const label =
    accessibilityLabel ??
    [title, meta, amount ?? value].filter(Boolean).join(", ");
  const body = (
    <>
      {start}
      <View className={`min-w-0 flex-1 ${start ? "ml-3" : ""}`}>
        <Text
          numberOfLines={2}
          className="text-[16px] font-semibold leading-[22px] text-gray-900"
        >
          {title}
        </Text>
        {meta ? (
          <Text
            className={`mt-0.5 text-[14px] leading-5 ${META_CLASSES[metaTone]}`}
          >
            {meta}
          </Text>
        ) : null}
      </View>
      {end ? <View className="ml-3 max-w-[45%] shrink-0">{end}</View> : null}
      {onPress ? (
        <ChevronRight
          size={18}
          strokeWidth={2}
          color={colors.subtle}
          accessible={false}
          style={{ marginLeft: 6 }}
        />
      ) : null}
    </>
  );
  const className = "min-h-[72px] flex-row items-center py-3";
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={label} className={className}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      onPress={onPress}
      className={`${className} active:opacity-70`}
    >
      {body}
    </Pressable>
  );
}

/** Placeholder rows with the same shape as `ItemRow`, while a list loads. */
export function SoftGroupSkeleton({
  rows = 3,
  label,
}: {
  rows?: number;
  /** Announced while loading, e.g. "Loading bills". */
  label: string;
}): JSX.Element {
  return (
    <Animated.View
      entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
      accessible
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
    >
      <SoftGroup>
        {Array.from({ length: rows }, (_, index) => (
          <View
            key={index}
            importantForAccessibility="no-hide-descendants"
            className="min-h-[72px] flex-row items-center gap-3 py-3"
          >
            <View className="h-11 w-11 rounded-full bg-gray-200/70" />
            <View className="flex-1 gap-2">
              <View className="h-4 w-1/2 rounded bg-gray-200/70" />
              <View className="h-3.5 w-1/3 rounded bg-gray-200/70" />
            </View>
            <View className="h-4 w-16 rounded bg-gray-200/70" />
          </View>
        ))}
      </SoftGroup>
    </Animated.View>
  );
}
