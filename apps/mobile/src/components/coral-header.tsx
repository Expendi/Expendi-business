import type { JSX } from "react";
import { Bell, Building2, ChevronDown } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { CappedText } from "~/components/text";
import { initialsOf } from "~/lib/initials";
import { colors } from "~/theme/colors";

/**
 * The pill header on the coral top: the person's initials, the company pill
 * (switches company) and a round bell.
 */
export function CoralHeader({
  personName,
  company,
  onCompany,
  companyHint,
  onBell,
  bellLabel,
  bellDot = false,
}: {
  personName: string;
  company: string;
  onCompany: () => void;
  /** What tapping the company pill does, for screen readers. */
  companyHint: string;
  onBell: () => void;
  bellLabel: string;
  /** Shows a dot when something is waiting behind the bell. */
  bellDot?: boolean;
}): JSX.Element {
  return (
    <View className="flex-row items-center gap-2.5">
      <View
        accessible
        accessibilityLabel={personName}
        className="h-11 w-11 items-center justify-center rounded-full bg-white/60"
      >
        <CappedText
          size={15}
          maxScale={1.2}
          className="font-semibold text-gray-900"
        >
          {initialsOf(personName)}
        </CappedText>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={company}
        accessibilityHint={companyHint}
        onPress={onCompany}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 rounded-full bg-white/90 px-4 active:bg-white"
      >
        <Building2
          size={18}
          strokeWidth={1.75}
          color={colors.muted}
          accessible={false}
        />
        <CappedText
          numberOfLines={1}
          size={15}
          maxScale={1.5}
          className="flex-1 font-medium text-gray-900"
        >
          {company}
        </CappedText>
        <ChevronDown
          size={18}
          strokeWidth={2}
          color={colors.muted}
          accessible={false}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={bellLabel}
        onPress={onBell}
        className="h-11 w-11 items-center justify-center rounded-full bg-white active:bg-gray-100"
      >
        <Bell
          size={20}
          strokeWidth={1.75}
          color={colors.text}
          accessible={false}
        />
        {bellDot ? (
          <View className="absolute right-[9px] top-[9px] h-[10px] w-[10px] rounded-full border-2 border-white bg-brand-600" />
        ) : null}
      </Pressable>
    </View>
  );
}
