import type { ComponentProps, JSX } from "react";
import { Text as NativeText, useWindowDimensions } from "react-native";

/** Outfit is embedded by expo-font; native font weights work on both platforms. */
export function Text({
  className,
  ...props
}: ComponentProps<typeof NativeText>) {
  return <NativeText className={`font-sans ${className ?? ""}`} {...props} />;
}

/**
 * Text in a fixed-size shape (avatar, badge, pill, the big figure) that
 * follows the person's text size up to `maxScale`, then stops. Sizes are set
 * here rather than with `maxFontSizeMultiplier`, which the new architecture
 * measures at the uncapped line height on iOS. Don't pass a text-size class.
 */
export function CappedText({
  size,
  lineHeight,
  maxScale,
  style,
  ...props
}: Omit<ComponentProps<typeof NativeText>, "allowFontScaling"> & {
  size: number;
  lineHeight?: number;
  maxScale: number;
}): JSX.Element {
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, maxScale);
  return (
    <Text
      allowFontScaling={false}
      style={[
        {
          fontSize: size * scale,
          lineHeight: lineHeight === undefined ? undefined : lineHeight * scale,
        },
        style,
      ]}
      {...props}
    />
  );
}
