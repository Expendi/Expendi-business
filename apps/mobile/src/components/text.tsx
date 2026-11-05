import type { ComponentProps } from "react";
import { Text as NativeText } from "react-native";

/** Outfit is embedded by expo-font; native font weights work on both platforms. */
export function Text({
  className,
  ...props
}: ComponentProps<typeof NativeText>) {
  return <NativeText className={`font-sans ${className ?? ""}`} {...props} />;
}
