import type { LucideIcon } from "lucide-react-native";
import { CircleAlert, CircleCheck, ReceiptText } from "lucide-react-native";

import type { Claim } from "@expendi-business/shared";

import type { ItemRowProps } from "~/components/soft-group";
import type { ReimbursementIcon } from "./owed";
import { reimbursementLine } from "./owed";

const ICONS: Record<
  ReimbursementIcon,
  { icon: LucideIcon; iconTone: NonNullable<ItemRowProps["iconTone"]> }
> = {
  waiting: { icon: ReceiptText, iconTone: "brand" },
  returned: { icon: CircleAlert, iconTone: "negative" },
  paid: { icon: CircleCheck, iconTone: "positive" },
};

/** A reimbursement as a soft-group row; `metaPrefix` adds who sent it for admins. */
export function reimbursementRow(
  claim: Claim,
  today: string,
  onPress: () => void,
  metaPrefix = "",
): ItemRowProps {
  const line = reimbursementLine(claim, today);
  const meta = `${metaPrefix}${line.meta}`;
  return {
    title: line.title,
    meta,
    metaTone: line.metaTone,
    amount: line.amount,
    amountTone: line.amountTone,
    accessibilityLabel: `${line.title}, KES ${line.amount}, ${meta}`,
    onPress,
    ...ICONS[line.icon],
  };
}
