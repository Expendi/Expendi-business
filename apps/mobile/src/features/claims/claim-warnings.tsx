import type { JSX } from "react";
import { CircleAlert } from "lucide-react-native";
import { Pressable, View } from "react-native";

import type { ExpenseWarning } from "@expendi-business/shared";

import { CappedText, Text } from "~/components/text";
import { formatKesCents } from "~/lib/money";
import { colors } from "~/theme/colors";
import { formatShortDate, localIsoDate } from "./dates";

const BADGES: Record<ExpenseWarning["code"], string> = {
  near_duplicate: "Possible duplicate",
  older_than_60_days: "Over 60 days old",
};

/** One badge per kind of warning, for the admin's reimbursement lists (spec §6.5). */
export function WarningBadges({
  warnings,
}: {
  warnings: readonly ExpenseWarning[];
}): JSX.Element | null {
  const codes = [...new Set(warnings.map((warning) => warning.code))];
  if (codes.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {codes.map((code) => (
        <View
          key={code}
          className="self-start rounded-full bg-error-50 px-2.5 py-1"
        >
          <CappedText
            size={12}
            lineHeight={16}
            maxScale={1.3}
            className="font-semibold text-error-700"
          >
            {BADGES[code]}
          </CappedText>
        </View>
      ))}
    </View>
  );
}

function describeWarning(warning: ExpenseWarning, today: string): string {
  return warning.code === "near_duplicate"
    ? `The same person claimed KES ${formatKesCents(warning.amountKes)} on ${formatShortDate(warning.spentOn, today)} too.`
    : `Paid on ${formatShortDate(warning.spentOn, today)}, ${String(warning.ageDays)} days before it was claimed.`;
}

/** What the admin should check before approving, with a way to compare. */
export function WarningList({
  warnings,
  onOpenClaim,
}: {
  warnings: readonly ExpenseWarning[];
  onOpenClaim: (claimId: string) => void;
}): JSX.Element | null {
  if (warnings.length === 0) return null;
  const today = localIsoDate(new Date());
  return (
    <View
      accessibilityRole="summary"
      className="flex-row items-start gap-3 rounded-2xl bg-error-50 p-4"
    >
      <CircleAlert
        size={20}
        strokeWidth={1.75}
        color={colors.error}
        accessible={false}
      />
      <View className="min-w-0 flex-1 gap-3">
        <Text className="text-[15px] font-semibold text-gray-900">
          Check before approving
        </Text>
        {warnings.map((warning) => (
          <View
            key={
              warning.code === "near_duplicate"
                ? warning.expenseId
                : warning.code
            }
            className="gap-1"
          >
            <Text className="text-[15px] leading-[21px] text-gray-900">
              {describeWarning(warning, today)}
            </Text>
            {warning.code === "near_duplicate" ? (
              <Pressable
                accessibilityRole="link"
                hitSlop={12}
                onPress={() => onOpenClaim(warning.expenseId)}
              >
                <Text className="text-[15px] font-semibold text-brand-700 underline">
                  Open that reimbursement
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}
