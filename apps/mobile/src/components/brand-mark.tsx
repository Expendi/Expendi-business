import { Image } from "expo-image";

import mark from "../../assets/brand-mark.png";

/** Original mark from the Expendi Expo app, with app-icon padding trimmed. */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <Image
      source={mark}
      style={{ width: size, height: size }}
      contentFit="contain"
      accessible={false}
    />
  );
}
