import type { JSX } from "react";
import { View } from "react-native";

import type { ExpenseStatus } from "@expendi-business/shared";

import type { ClaimStatusTone } from "./claim-status-labels";
import { CappedText } from "~/components/text";
import { CLAIM_STATUSES } from "./claim-status-labels";

export { claimStatusLabel } from "./claim-status-labels";

const TONE_CLASSES: Record<ClaimStatusTone, { container: string; label: string }> = {
  neutral: { container: "bg-gray-100", label: "text-gray-700" },
  success: { container: "bg-success-50", label: "text-success-700" },
  attention: { container: "bg-brand-50", label: "text-brand-800" },
  problem: { container: "bg-error-50", label: "text-error-700" },
};

export function ClaimStatusBadge({
  status,
}: {
  status: ExpenseStatus;
}): JSX.Element {
  const { label, tone } = CLAIM_STATUSES[status];
  const classes = TONE_CLASSES[tone];
  return (
    <View className={`self-start rounded-full px-3 py-1 ${classes.container}`}>
      <CappedText
        size={13}
        lineHeight={18}
        maxScale={1.3}
        className={`font-semibold ${classes.label}`}
      >
        {label}
      </CappedText>
    </View>
  );
}
