import type { LucideIcon } from "lucide-react-native";
import type { JSX, ReactNode } from "react";
import { Image } from "expo-image";
import { useId } from "react";
import { Pressable, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";

import { CappedText } from "~/components/text";
import { colors } from "~/theme/colors";
import mark from "../../assets/brand-mark.png";

const VIEW_WIDTH = 360;

/**
 * A coral-gradient feature card with faint white line art. `peek` squares
 * the bottom corners so it can tuck behind the white sheet on Home. White
 * text belongs on the darker, lower-right part only.
 */
export function GradientCard({
  children,
  height,
  peek = false,
  vertical = false,
  onPress,
  accessibilityLabel,
}: {
  children: ReactNode;
  height: number;
  peek?: boolean;
  /** Darkens towards the bottom rather than the bottom-right. */
  vertical?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
}): JSX.Element {
  const gradientId = `card${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const art = (
    <Svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(height)}`}
      preserveAspectRatio="xMidYMid slice"
      style={{ position: "absolute" }}
      accessible={false}
    >
      <Defs>
        <LinearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2={vertical ? "0.35" : "1"}
          y2="1"
        >
          <Stop offset="0" stopColor="#ffa58f" />
          <Stop offset="0.55" stopColor="#f0613e" />
          <Stop offset="1" stopColor="#cc4528" />
        </LinearGradient>
      </Defs>
      <Rect
        x="0"
        y="0"
        width={VIEW_WIDTH}
        height={height}
        fill={`url(#${gradientId})`}
      />
      <G fill="none" stroke="#ffffff" strokeOpacity={0.22} strokeWidth={1}>
        <Circle cx="318" cy="18" r="34" />
        <Circle cx="318" cy="18" r="62" />
        <Circle cx="318" cy="18" r="92" />
        <Circle cx="318" cy="18" r="124" />
        <Path
          d={`M0 ${String(height - 28)} C 70 ${String(height - 64)}, 130 ${String(height + 8)}, 210 ${String(height - 32)} S 330 ${String(height - 54)}, 360 ${String(height - 20)}`}
        />
      </G>
    </Svg>
  );
  const className = `overflow-hidden ${peek ? "rounded-t-[22px]" : "rounded-[22px]"}`;
  if (!onPress) {
    return (
      <View className={className} style={{ minHeight: height }}>
        {art}
        {children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      className={`${className} active:opacity-90`}
      style={{ minHeight: height }}
    >
      {art}
      {children}
    </Pressable>
  );
}

/** The Expendi mark in white, for gradient cards. */
export function WhiteMark({ size = 34 }: { size?: number }): JSX.Element {
  return (
    <Image
      source={mark}
      tintColor="#ffffff"
      style={{ width: size, height: size }}
      contentFit="contain"
      accessible={false}
    />
  );
}

/** A white label pill on a gradient card. */
export function WhitePill({
  icon: Icon,
  label,
}: {
  icon?: LucideIcon;
  label: string;
}): JSX.Element {
  return (
    <View className="min-h-10 flex-row items-center gap-2 self-start rounded-full bg-white px-4 py-2">
      {Icon ? (
        <Icon
          size={18}
          strokeWidth={1.75}
          color={colors.text}
          accessible={false}
        />
      ) : null}
      <CappedText
        size={15}
        maxScale={1.4}
        className="shrink font-semibold text-gray-900"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {label}
      </CappedText>
    </View>
  );
}
