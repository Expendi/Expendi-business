import type { JSX } from "react";
import { View } from "react-native";

import type { Member } from "@expendi-business/shared";

import { Badge } from "~/components/badge";

export function memberDisplayName(member: Member): string {
  return member.name ?? member.email;
}

/** Accountants have no login and are never paid out, so the payout number doesn't apply to them. */
export function MemberBadges({ member }: { member: Member }): JSX.Element {
  return (
    <View className="flex-row flex-wrap gap-2">
      {member.status === "invited" ? (
        <Badge label="Invited" tone="warning" />
      ) : (
        <Badge label="Active" tone="success" />
      )}
      {member.role === "accountant" ? null : member.payoutPhoneConfirmed ? (
        <Badge label="M-Pesa number confirmed" tone="success" />
      ) : (
        <Badge label="No M-Pesa number yet" />
      )}
    </View>
  );
}
