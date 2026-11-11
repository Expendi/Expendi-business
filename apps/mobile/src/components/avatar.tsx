import type { JSX } from "react";
import { View } from "react-native";

import { CappedText } from "~/components/text";
import { initialsOf } from "~/lib/initials";

/** A person's initials on a coral-100 circle. */
export function Avatar({
  name,
  size = 44,
}: {
  name: string;
  size?: number;
}): JSX.Element {
  return (
    <View
      accessible={false}
      className="items-center justify-center rounded-full bg-brand-100"
      style={{ width: size, height: size }}
    >
      <CappedText
        size={size > 44 ? 17 : 15}
        maxScale={1.2}
        className="font-semibold text-brand-800"
      >
        {initialsOf(name)}
      </CappedText>
    </View>
  );
}
