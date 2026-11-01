import type { PaycrestOrder } from "./paycrest-client.js";
import type { KesPayoutQuote } from "./quote.js";
import type { PaycrestRecipient } from "./recipient.js";
import { kesCentsFor, toMicro } from "./amounts.js";

/**
 * Checks a Paycrest order before a single USDC is sent to it (spec §6.7,
 * §7), ported from the consumer backend's `assertSafeDeposit`. Paycrest
 * picks a new deposit address per order, so a policy can't allowlist
 * recipients; these checks are what stop money going anywhere unintended.
 */

/** Deposit instructions must stay valid long enough to send and confirm. */
export const MIN_DEPOSIT_WINDOW_MS = 120_000;

/** The order may come back at most 0.5% under the quoted rate. */
const RATE_TOLERANCE_BPS = 50n;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

export type OrderProblem =
  /** Wrong destination, network, token, recipient or state: never fund it. */
  | { readonly kind: "unsafe"; readonly reasons: readonly string[] }
  /** The rate moved so the payout is no longer covered: quote again. */
  | { readonly kind: "quote_changed"; readonly reasons: readonly string[] }
  /** Paycrest wants more USDC than was approved. */
  | {
      readonly kind: "over_approved_debit";
      readonly reasons: readonly string[];
    };

export interface ExpectedOrder {
  readonly reference: string;
  /** The paying company's wallet. */
  readonly refundAddress: string;
  readonly recipient: PaycrestRecipient;
  readonly quote: KesPayoutQuote;
  /** The most USDC the approval allows to leave the wallet for this order. */
  readonly maxDebitUsdc: bigint;
  readonly now: number;
}

const sameAddress = (a: string | undefined, b: string): boolean =>
  a?.toLowerCase() === b.toLowerCase();

function unsafeReasons(
  order: PaycrestOrder,
  expected: ExpectedOrder,
): string[] {
  const deposit = order.providerAccount;
  const expectedRecipient = expected.recipient;
  const recipient = order.destination.recipient;
  const validUntil = deposit ? Date.parse(deposit.validUntil) : Number.NaN;

  const checks: [boolean, string][] = [
    [!!deposit, "no deposit instructions"],
    [
      !!deposit &&
        EVM_ADDRESS.test(deposit.receiveAddress) &&
        deposit.receiveAddress.toLowerCase() !== ZERO_ADDRESS,
      "deposit address is not a valid address",
    ],
    [
      !sameAddress(deposit?.receiveAddress, expected.refundAddress),
      "deposit address is the company's own wallet",
    ],
    [deposit?.network === "base", "deposit network is not Base"],
    [deposit?.currency === "USDC", "deposit token is not USDC"],
    [!deposit?.memo, "deposit requires a memo"],
    [
      Number.isFinite(validUntil) &&
        validUntil - expected.now >= MIN_DEPOSIT_WINDOW_MS,
      "deposit instructions expire too soon",
    ],
    [order.source.type === "crypto", "source is not crypto"],
    [order.source.network === "base", "source network is not Base"],
    [order.source.currency === "USDC", "source token is not USDC"],
    [
      sameAddress(order.source.refundAddress, expected.refundAddress),
      "refunds would not return to the company wallet",
    ],
    [order.destination.type === "fiat", "destination is not fiat"],
    [order.destination.currency === "KES", "destination currency is not KES"],
    [
      !order.destination.country || order.destination.country === "KE",
      "destination country is not Kenya",
    ],
    [
      recipient.institution === expectedRecipient.institution,
      "recipient institution differs",
    ],
    [
      recipient.accountIdentifier === expectedRecipient.accountIdentifier,
      "recipient account differs",
    ],
    [order.reference === expected.reference, "order reference differs"],
    [order.status === "initiated", `order status is ${order.status}`],
    [
      !order.direction || order.direction === "offramp",
      "order is not an off-ramp",
    ],
  ];

  const expectedMetadata = expectedRecipient.metadata;
  if (expectedMetadata) {
    // Paycrest treats a missing channel as an M-Pesa number.
    const channel = recipient.metadata?.channel ?? "Mobile";
    checks.push([
      channel === expectedMetadata.channel,
      `channel is ${channel}, not ${expectedMetadata.channel}`,
    ]);
    if (expectedMetadata.channel === "Paybill") {
      checks.push([
        recipient.metadata?.businessNumber === expectedMetadata.businessNumber,
        "Paybill business number differs",
      ]);
    }
  }

  return checks.filter(([ok]) => !ok).map(([, reason]) => reason);
}

/** Null when the order is safe to fund exactly once. */
export function checkOrder(
  order: PaycrestOrder,
  expected: ExpectedOrder,
): OrderProblem | null {
  const unsafe = unsafeReasons(order, expected);
  if (unsafe.length > 0) return { kind: "unsafe", reasons: unsafe };

  const quoteChanged: string[] = [];
  if (
    toMicro(order.rate) * 10_000n <
    toMicro(expected.quote.rate) * (10_000n - RATE_TOLERANCE_BPS)
  ) {
    quoteChanged.push(
      `rate ${order.rate} is below the quoted ${expected.quote.rate}`,
    );
  }
  const amount = toMicro(order.amount);
  // No tolerance: M-Pesa moves whole shillings, so even a cent short could
  // pay the recipient a shilling less than they're owed.
  if (kesCentsFor(amount, order.rate) < expected.quote.payoutKesCents) {
    quoteChanged.push("order no longer covers the KES payout");
  }
  if (quoteChanged.length > 0) {
    return { kind: "quote_changed", reasons: quoteChanged };
  }

  const deposit = order.providerAccount;
  const toTransfer = deposit ? toMicro(deposit.amountToTransfer) : 0n;
  const debit: string[] = [];
  if (amount !== expected.quote.usdcAmount) {
    debit.push("order amount differs from the quote");
  }
  if (toMicro(order.senderFee) !== 0n) {
    debit.push("order carries a sender fee");
  }
  if (toTransfer !== amount + toMicro(order.transactionFee)) {
    debit.push("deposit is not amount plus Paycrest's fee");
  }
  if (toTransfer > expected.maxDebitUsdc) {
    debit.push("deposit exceeds the approved maximum");
  }
  return debit.length > 0
    ? { kind: "over_approved_debit", reasons: debit }
    : null;
}
