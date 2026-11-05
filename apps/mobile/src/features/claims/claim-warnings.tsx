import type { JSX } from "react";
import { Pressable, View } from "react-native";

import type { ExpenseWarning } from "@expendi-business/shared";

import { Badge } from "~/components/badge";
import { Text } from "~/components/text";
import { formatKesCents } from "~/lib/money";
import { formatIsoDate } from "./dates";

const BADGES: Record<ExpenseWarning["code"], string> = {
  near_duplicate: "Possible duplicate",
  older_than_60_days: "Over 60 days old",
};

/** One badge per kind of warning, for the admin's claim list (spec §6.5). */
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
        <Badge key={code} label={BADGES[code]} tone="warning" />
      ))}
    </View>
  );
}

function describeWarning(warning: ExpenseWarning): string {
  return warning.code === "near_duplicate"
    ? `The same person claimed KES ${formatKesCents(warning.amountKes)} on ${formatIsoDate(warning.spentOn)} too.`
    : `Paid on ${formatIsoDate(warning.spentOn)}, ${warning.ageDays} days before it was claimed.`;
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
  return (
    <View className="gap-3 rounded-xl bg-amber-50 p-4">
      <Text className="text-base font-semibold text-amber-900">
        Check before approving
      </Text>
      {warnings.map((warning) => (
        <View
          key={
            warning.code === "near_duplicate" ? warning.expenseId : warning.code
          }
          className="gap-1"
        >
          <Text className="text-sm text-amber-900">
            {describeWarning(warning)}
          </Text>
          {warning.code === "near_duplicate" ? (
            <Pressable
              accessibilityRole="link"
              hitSlop={12}
              onPress={() => onOpenClaim(warning.expenseId)}
            >
              <Text className="text-sm font-semibold text-amber-900 underline">
                Open that claim
              </Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}
