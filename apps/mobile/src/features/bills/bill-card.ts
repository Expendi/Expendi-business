import type {
  Bill,
  BillDetail,
  BillStatus,
  RecurringItemState,
} from "@expendi-business/shared";
import { UNPAID_BILL_STATUSES } from "@expendi-business/shared";

import type { BillAmountFields } from "./bill-amount";
import { formatKesCents } from "../../lib/money";
import { maskedCardNumber, purchaseDate } from "../cards/card-display";
import { formatBillAmount } from "./bill-amount";

/**
 * Bills a company-held card pays (spec §6.20). Their recurring payment is
 * set up on the web dashboard and a Card purchase settles them, so the app
 * labels them and never offers to pay them.
 */

export type BillCard = NonNullable<Bill["card"]>;

type DeclineFields = Pick<Bill, "status" | "cardDeclinedAt">;

const isUnpaid = (status: BillStatus): boolean =>
  (UNPAID_BILL_STATUSES as readonly BillStatus[]).includes(status);

/**
 * The company-held card set to pay it, even while something stops it
 * (`payingCard`); null once it's settled, and for any bill no card pays.
 */
export function automaticCard(
  bill: Pick<Bill, "status" | "card">,
): BillCard | null {
  return isUnpaid(bill.status) ? (bill.card ?? null) : null;
}

/** A decline only matters while the bill is still owed. */
export function cardDeclined(bill: DeclineFields): boolean {
  return isUnpaid(bill.status) && bill.cardDeclinedAt != null;
}

/** The payee charges what they charge: "About USD 20.00", or "No estimate". */
export function formatEstimate(amount: BillAmountFields): string {
  const formatted = formatBillAmount(amount);
  return formatted === null ? "No estimate" : `About ${formatted}`;
}

/** "company-held card •••• 1234", for the middle of a sentence. */
export function companyHeldCardName(
  card: Pick<BillCard, "lastFour"> | null | undefined,
): string {
  return card
    ? `company-held card ${maskedCardNumber(card.lastFour)}`
    : "a company-held card";
}

export function byCompanyHeldCard(
  card: Pick<BillCard, "lastFour"> | null | undefined,
): string {
  return `By ${companyHeldCardName(card)}`;
}

/**
 * What can stop the card paying a bill still owed: its recurring payment's
 * state and whether it's paused, and the card's own state, which only an
 * API built before them leaves out.
 */
export type StopFields = Pick<Bill, "status" | "card"> & {
  readonly recurring?: {
    readonly state: RecurringItemState;
    readonly active?: boolean | undefined;
  } | null;
};

interface PayeeName {
  readonly payee: Pick<Bill["payee"], "name">;
}

export type StoppedCardState = "frozen" | "closed";

/** A frozen or closed card declines every Card purchase, so it won't pay a bill still owed. */
export function stoppedCardState(
  bill: Pick<Bill, "status" | "card">,
): StoppedCardState | null {
  const state = automaticCard(bill)?.state;
  return state === "frozen" || state === "closed" ? state : null;
}

type Stop = "paused" | "ended" | StoppedCardState;

/**
 * A payment whose schedule ended still has its card pay the bill it left
 * owed, unless it's paused; an API that doesn't say whether it's paused is
 * taken to have it declined.
 */
const endedWithLastBill = (bill: StopFields): boolean =>
  bill.recurring?.state === "ended" && bill.recurring.active === true;

/**
 * A paused payment's Card purchases are declined, and an ended one's but
 * for its last bill, as are a frozen or closed card's.
 */
function stopOf(bill: StopFields): Stop | null {
  const recurringState = bill.recurring?.state;
  if (recurringState === "paused") return recurringState;
  if (recurringState === "ended" && !endedWithLastBill(bill)) {
    return recurringState;
  }
  return stoppedCardState(bill);
}

/** The card that will pay it, with nothing known to stop it; null otherwise. */
export function payingCard(bill: StopFields): BillCard | null {
  return stopOf(bill) === null ? automaticCard(bill) : null;
}

/** Why the card won't pay a bill still owed; null while nothing known stops it. */
export function cardPaymentStop(bill: StopFields & PayeeName): string | null {
  const card = automaticCard(bill);
  const stop = stopOf(bill);
  if (card === null || stop === null) return null;
  switch (stop) {
    case "paused":
      return `Paused: Card purchases from ${bill.payee.name} are declined`;
    case "ended":
      return `Ended: Card purchases from ${bill.payee.name} are declined`;
    case "frozen":
    case "closed":
      return `Card ${maskedCardNumber(card.lastFour)} is ${stop}`;
  }
}

/**
 * How the card pays a bill still owed. Only a card known to be open is
 * said to pay when the payee charges it, or, on an ended payment's last
 * bill, to pay that and nothing after; otherwise the card is just named.
 */
export function cardPaymentInWords(
  bill: StopFields & PayeeName,
): string | null {
  const card = automaticCard(bill);
  if (card === null) return null;
  const stop = cardPaymentStop(bill);
  if (stop !== null) return stop;
  if (card.state !== "open") return byCompanyHeldCard(card);
  return endedWithLastBill(bill)
    ? `Card ${maskedCardNumber(card.lastFour)} pays this last bill, and nothing after it.`
    : `Paid by card ${maskedCardNumber(card.lastFour)} when ${bill.payee.name} charges it`;
}

/** When and why the card declined it; null unless that's still to sort out. */
export function cardDeclineLine(
  bill: DeclineFields & Pick<Bill, "cardDeclineReason">,
): string | null {
  if (!cardDeclined(bill) || !bill.cardDeclinedAt) return null;
  const reason = bill.cardDeclineReason ?? "No reason given";
  return `${purchaseDate(bill.cardDeclinedAt)}: ${reason}`;
}

/** "Paid by card •••• 1234" for a bill a Card purchase paid; null for any other. */
export function paidByCardLabel(
  bill: Pick<Bill, "status" | "card">,
): string | null {
  if (bill.status !== "paid_by_card") return null;
  return bill.card
    ? `Paid by card ${maskedCardNumber(bill.card.lastFour)}`
    : "Paid by card";
}

/**
 * What a Card purchase paid, "USD 20.00 · KES 2,600.00": a USD bill's
 * amount, then the KES its spending row recorded at the day's rate. Just
 * the amount when it's in KES or the KES isn't known; null without one.
 */
export function paidByCardAmount(
  bill: BillAmountFields & Partial<Pick<BillDetail, "paidAmountKes">>,
): string | null {
  const amount = formatBillAmount(bill);
  if (
    amount === null ||
    bill.currency !== "usd" ||
    bill.paidAmountKes == null
  ) {
    return amount;
  }
  return `${amount} · KES ${formatKesCents(bill.paidAmountKes)}`;
}
