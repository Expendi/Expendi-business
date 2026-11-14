import type { JSX, ReactNode } from "react";
import { View } from "react-native";

import { CoralScreen } from "~/components/coral-screen";
import { WhiteMark } from "~/components/gradient-card";
import { Text } from "~/components/text";

/**
 * Signing in, in the K1 language: the white brand lockup on the coral top
 * (a logotype, so exempt from text contrast), a white sheet over it, a 30px
 * title over one line of help, then the form.
 */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <CoralScreen
      bottomInset
      top={
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel="Expendi Business"
          className="mx-auto mt-4 w-full max-w-md flex-row items-center gap-2.5 px-1 pb-[88px]"
        >
          <WhiteMark size={32} />
          <Text className="text-[20px] font-semibold text-white">
            Expendi Business
          </Text>
        </View>
      }
    >
      <View className="mx-auto w-full max-w-md">
        <Text
          accessibilityRole="header"
          className="text-[30px] font-semibold leading-9 tracking-[-0.5px] text-gray-900"
        >
          {title}
        </Text>
        <Text className="mt-2 text-[16px] leading-6 text-gray-600">
          {description}
        </Text>
        <View className="mt-7">{children}</View>
      </View>
    </CoralScreen>
  );
}
