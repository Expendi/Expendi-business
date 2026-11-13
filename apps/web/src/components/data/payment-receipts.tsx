"use client";

import type { JSX } from "react";

import type { CashOutReceipt } from "@expendi-business/shared";
import { cashOutReceiptLabel } from "@expendi-business/shared";

import type { ReceiptRow } from "~/features/payment-receipts";
import { CopyButton } from "~/components/copy-button";
import { receiptRows } from "~/features/payment-receipts";
import { DetailItem } from "./detail-sheet";

/** A row's codes, in the order they were paid, each with its copy button. */
export function ReceiptCodes({ row }: { row: ReceiptRow }): JSX.Element {
  const one = cashOutReceiptLabel(row.kind);
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {row.codes.map((code, at) => (
        <li
          key={`${String(at)}-${code}`}
          className="flex items-center justify-between gap-3"
        >
          <span className="[overflow-wrap:anywhere]">{code}</span>
          <CopyButton value={code} what={`${one} ${code}`} wide={false} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A paid cash-out's receipt rows for a `DetailList`, e.g. "M-Pesa receipt
 * UKDCW299LW"; nothing until one is paid.
 */
export function PaymentReceiptItems({
  receipts,
}: {
  receipts: readonly CashOutReceipt[];
}): JSX.Element {
  return (
    <>
      {receiptRows(receipts).map((row) => (
        <DetailItem key={row.kind} label={row.label}>
          <ReceiptCodes row={row} />
        </DetailItem>
      ))}
    </>
  );
}
