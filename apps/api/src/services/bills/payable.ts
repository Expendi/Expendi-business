import { Data, Effect } from "effect";

import type { BillCurrency, BillStatus } from "@expendi-business/shared";
import {
  currencyForPayeeMethod,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import type {
  BillRow,
  PayeeRow,
  RecurringItemRow,
} from "../../db/schema/index.js";

export type BillNotPayableReason =
  | "not_unpaid"
  | "paid_outside_payee"
  | "paid_outside_recurring"
  | "no_amount"
  | "no_reference"
  | "currency_mismatch";

/** The bill can't be paid through Expendi as it stands (spec §6.20). */
export class BillNotPayable extends Data.TaggedError("BillNotPayable")<{
  readonly billId: string;
  readonly reason: BillNotPayableReason;
  readonly message: string;
}> {}

export interface PayableBillCheck {
  readonly bill: Pick<
    BillRow,
    "id" | "status" | "currency" | "amountKes" | "amountUsdc" | "reference"
  >;
  readonly payee: Pick<PayeeRow, "name" | "kind" | "method">;
  /** The recurring payment the bill came from, if any. */
  readonly recurringItem?: Pick<RecurringItemRow, "payVia"> | null;
}

const STATUS_MESSAGES: Partial<Record<BillStatus, string>> = {
  paying: "This bill is already being paid.",
  paid: "This bill is already paid.",
  paid_outside: "This bill was already marked paid.",
  cancelled: "This bill is cancelled.",
};

/** What a payable bill pays: KES through Paycrest, or exactly this USDC. */
export type BillAmount =
  | { readonly currency: "kes"; readonly amountKes: bigint }
  | { readonly currency: "usd"; readonly amountUsdc: bigint };

const CURRENCY_NAMES: Readonly<Record<BillCurrency, string>> = {
  kes: "KES",
  usd: "USD",
};

/** A bill's amount in its own currency, or null while a variable bill has none. */
export function billAmountOf(
  bill: Pick<BillRow, "currency" | "amountKes" | "amountUsdc">,
): BillAmount | null {
  if (bill.currency === "usd") {
    return bill.amountUsdc === null
      ? null
      : { currency: "usd", amountUsdc: bill.amountUsdc };
  }
  return bill.amountKes === null
    ? null
    : { currency: "kes", amountKes: bill.amountKes };
}

const isUnpaid = (status: BillStatus): boolean =>
  (UNPAID_BILL_STATUSES as readonly BillStatus[]).includes(status);

/**
 * Statutory bodies match a payment by its reference, e.g. KRA's payment
 * registration number, which changes every time.
 */
const needsReference = (payee: PayableBillCheck["payee"]): boolean =>
  payee.kind === "statutory";

/**
 * What a bill itself must pass before Expendi pays it (spec §6.20). Paying
 * bills (T37) runs this inside the transaction that prepares the payout,
 * with the bill locked, then `resolvePayeeRecipient` for the payee's own
 * checks (archived, no details, the 24-hour hold). Returns the amount to
 * pay.
 *
 * - Only an unpaid bill can be paid: upcoming, due, overdue, or failed.
 * - A payee paid outside Expendi (e.g. a card-only subscription) never is,
 *   nor is a recurring payment set up as paid outside: the admin marks
 *   those bills paid instead.
 * - A variable bill needs its amount first, and a statutory payment its
 *   reference.
 * - The amount is in the payee's currency: USD for a payee paid in USDC,
 *   KES otherwise. A payee whose method changed since the bill was entered
 *   needs the amount entered again.
 */
export function assertBillPayable({
  bill,
  payee,
  recurringItem,
}: PayableBillCheck): Effect.Effect<BillAmount, BillNotPayable> {
  const refuse = (reason: BillNotPayableReason, message: string) =>
    Effect.fail(new BillNotPayable({ billId: bill.id, reason, message }));

  if (!isUnpaid(bill.status)) {
    return refuse(
      "not_unpaid",
      STATUS_MESSAGES[bill.status] ?? "This bill can't be paid now.",
    );
  }
  if (payee.method === "outside") {
    return refuse(
      "paid_outside_payee",
      `${payee.name} is paid outside Expendi. Mark this bill paid once you've paid it.`,
    );
  }
  if (recurringItem?.payVia === "outside") {
    return refuse(
      "paid_outside_recurring",
      "This payment is made outside Expendi. Mark this bill paid once you've paid it.",
    );
  }
  const payeeCurrency = currencyForPayeeMethod(payee.method);
  if (payee.method !== null && payeeCurrency !== bill.currency) {
    return refuse(
      "currency_mismatch",
      `${payee.name} is now paid in ${payeeCurrency === "usd" ? "USDC" : "KES"}. Enter this bill's amount in ${CURRENCY_NAMES[payeeCurrency]} before paying it.`,
    );
  }
  const amount = billAmountOf(bill);
  if (amount === null) {
    return refuse("no_amount", "Enter this bill's amount before paying it.");
  }
  if (needsReference(payee) && bill.reference === null) {
    return refuse(
      "no_reference",
      "Enter the payment reference before paying, e.g. the KRA payment registration number.",
    );
  }
  return Effect.succeed(amount);
}
