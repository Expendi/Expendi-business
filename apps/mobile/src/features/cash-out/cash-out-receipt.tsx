import type { JSX } from "react";
import { View } from "react-native";

import type { CashOutReceipt } from "@expendi-business/shared";

import { CopyButton } from "~/components/copy-button";
import { ReviewRow } from "~/features/claims/claim-editor";
import { cashOutReceiptCopy, cashOutReceiptRows } from "./receipt-rows";

/**
 * The M-Pesa receipt or bank reference of a paid cash-out, so the payee can
 * find the payment in their M-Pesa messages or bank statement. Nothing until
 * it's paid.
 */
export function CashOutReceiptRows({
  receipts,
  copyable = false,
}: {
  receipts: readonly CashOutReceipt[];
  copyable?: boolean;
}): JSX.Element | null {
  const rows = cashOutReceiptRows(receipts);
  if (rows.length === 0) return null;
  const copy = copyable ? cashOutReceiptCopy(receipts) : null;
  return (
    <View className="gap-3">
      {rows.map((row) => (
        <ReviewRow
          key={row.label}
          label={row.label}
          value={row.value}
          selectable
        />
      ))}
      {copy ? (
        <CopyButton
          value={copy.value}
          label={copy.label}
          failureMessage="Couldn’t copy. Select the code and copy it instead."
        />
      ) : null}
    </View>
  );
}
