import type {
  BillCurrency,
  CashOutAmountLimits,
  PayeeMethod,
  WalletResponse,
} from "@expendi-business/shared";
import {
  cashOutAmountProblem,
  parseKesToCents,
  paysByCashOut,
} from "@expendi-business/shared";

import { ApiError, apiErrorField } from "../../lib/api";
import { formatKesCents } from "../../lib/money";

/**
 * The amounts one cash-out can send, as the wallet states them now. Null
 * when it states none: no active wallet, or an API from before limits.
 */
export function cashOutLimitsOf(
  wallet: WalletResponse | undefined,
): CashOutAmountLimits | null {
  if (wallet?.status !== "active" || wallet.cashOutLimits === undefined) {
    return null;
  }
  const { minKesCents, maxKesCents } = wallet.cashOutLimits;
  return {
    minKesCents: minKesCents === null ? null : BigInt(minKesCents),
    maxKesCents: maxKesCents === null ? null : BigInt(maxKesCents),
  };
}

/** A KES amount field as typed, for a payee paid by `method`. */
export interface TypedPayeeAmount {
  readonly currency: BillCurrency;
  readonly amount: string;
  readonly method: PayeeMethod | null;
}

function appliesTo(typed: TypedPayeeAmount): boolean {
  return typed.currency === "kes" && paysByCashOut(typed.method);
}

/**
 * "Smallest amount: KES 20" by the amount field, while a minimum is known,
 * blank or not: entering a variable bill's amount is when it matters.
 */
export function cashOutAmountHint(
  typed: TypedPayeeAmount,
  limits: CashOutAmountLimits | null,
): string | null {
  const minKesCents = limits?.minKesCents ?? null;
  if (minKesCents === null || !appliesTo(typed)) return null;
  const minimum = formatKesCents(minKesCents.toString()).replace(/\.00$/, "");
  return `Smallest amount: KES ${minimum}`;
}

/**
 * Why the typed amount can't be sent as one cash-out, in the API's words,
 * or null. A blank amount, or one that doesn't parse, is left to the
 * request's schema.
 */
export function cashOutAmountError(
  typed: TypedPayeeAmount,
  limits: CashOutAmountLimits | null,
): string | null {
  if (limits === null || !appliesTo(typed)) return null;
  const cents = parseKesToCents(typed.amount);
  return cents === null ? null : cashOutAmountProblem(cents, limits);
}

const AMOUNT_FIELDS: readonly (string | null)[] = ["amountKes", "amountUsd"];

/**
 * The API's message when it refused a save for its amount, e.g. outside
 * the cash-out limits, to show on the amount field; null for anything else.
 */
export function amountRefusal(error: unknown): string | null {
  return error instanceof ApiError &&
    AMOUNT_FIELDS.includes(apiErrorField(error))
    ? error.message
    : null;
}
