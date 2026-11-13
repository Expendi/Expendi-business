import type { JSX } from "react";
import { View } from "react-native";

import type { BillHeading, BillStatus } from "@expendi-business/shared";

import type { BadgeFields } from "./bill-badges";
import { Badge } from "~/components/badge";
import { BILL_STATUS_BADGES, billBadges } from "./bill-badges";

export const HEADING_LABELS: Record<BillHeading, string> = {
  transactions: "Transactions",
  subscriptions: "Subscriptions",
};

export function BillStatusBadge({
  status,
}: {
  status: BillStatus;
}): JSX.Element {
  const { label, tone } = BILL_STATUS_BADGES[status];
  return <Badge label={label} tone={tone} />;
}

/** Its status, and whether a company-held card pays it or declined it. */
export function BillBadges({ bill }: { bill: BadgeFields }): JSX.Element {
  return (
    <View className="flex-row flex-wrap gap-2">
      {billBadges(bill).map((badge) => (
        <Badge key={badge.label} label={badge.label} tone={badge.tone} />
      ))}
    </View>
  );
}
