import type { JSX } from "react";
import { ArrowDownRight, ArrowUpRight, Info } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Text } from "~/components/text";
import { colors } from "~/theme/colors";

/**
 * One line under a figure: red ↘ when money goes out, green ↗ when it comes
 * in. White surfaces only; red and green fail contrast on coral.
 */
export function TrendLine({
  direction,
  text,
  onPress,
  info = false,
  accessibilityHint,
}: {
  direction: "in" | "out";
  text: string;
  onPress?: () => void;
  /** Shows an info icon; use with `onPress` that explains the figure. */
  info?: boolean;
  accessibilityHint?: string;
}): JSX.Element {
  const tone = direction === "in" ? colors.success : colors.error;
  const Arrow = direction === "in" ? ArrowUpRight : ArrowDownRight;
  const content = (
    <>
      <Arrow size={16} strokeWidth={2.25} color={tone} accessible={false} />
      <Text
        className="shrink text-[15px] font-medium leading-5"
        style={{ color: tone, fontVariant: ["tabular-nums"] }}
      >
        {text}
      </Text>
      {info ? (
        <Info
          size={17}
          strokeWidth={1.75}
          color={colors.muted}
          accessible={false}
          style={{ marginLeft: 4 }}
        />
      ) : null}
    </>
  );
  const className = "mt-1 min-h-9 flex-row items-center gap-1.5 self-start";
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={text} className={className}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      className={className}
    >
      {content}
    </Pressable>
  );
}
