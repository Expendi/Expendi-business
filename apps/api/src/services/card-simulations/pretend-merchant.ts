import { randomBytes } from "node:crypto";

/**
 * The merchant a sandbox Card purchase pretends to come from (spec §6.25).
 * The purchase check knows a merchant by Lithic's acceptor ID, so the usual
 * one must be the same every time for a recurring payment, as a real
 * subscription's merchant is, and a new one must never repeat.
 */

/** Lithic's limits on a simulated purchase. */
const DESCRIPTOR_MAX = 25;
const ACCEPTOR_ID_MAX = 15;

const NEW_MARK = " NEW ";
const NEW_SUFFIX_LENGTH = 5;

export interface PretendMerchant {
  /** What the purchase shows as the merchant's name. */
  readonly descriptor: string;
  /** Lithic's ID for the merchant: the `merchant_key` the match is made on. */
  readonly acceptorId: string;
}

function nameOf(payeeName: string): string {
  return payeeName.trim().toUpperCase().slice(0, DESCRIPTOR_MAX).trimEnd();
}

/** The merchant a recurring payment always charges from. */
export function usualMerchant(
  recurringItemId: string,
  payeeName: string,
): PretendMerchant {
  const hex = recurringItemId.replaceAll("-", "").toUpperCase();
  return {
    descriptor: nameOf(payeeName),
    acceptorId: `SBX${hex}`.slice(0, ACCEPTOR_ID_MAX),
  };
}

/**
 * A merchant the card has never seen, to show what admins are asked when
 * one charges. Its name says so, and differs on every run.
 */
export function newMerchant(
  payeeName: string,
  randomHex: string = randomBytes(6).toString("hex"),
): PretendMerchant {
  const unique = randomHex.toUpperCase();
  const suffix = `${NEW_MARK}${unique.slice(0, NEW_SUFFIX_LENGTH)}`;
  return {
    descriptor: `${nameOf(payeeName)
      .slice(0, DESCRIPTOR_MAX - suffix.length)
      .trimEnd()}${suffix}`,
    acceptorId: `NEW${unique}`.slice(0, ACCEPTOR_ID_MAX),
  };
}
