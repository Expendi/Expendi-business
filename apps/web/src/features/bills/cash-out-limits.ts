import { z } from "zod";

import type {
  CashOutAmountLimits,
  PayeeMethod,
  WalletResponse,
} from "@expendi-business/shared";
import {
  cashOutAmountProblem,
  parseKesToCents,
  paysByCashOut,
} from "@expendi-business/shared";

import { ApiError } from "~/lib/api";
import { formatKes } from "~/lib/money";

/**
 * What one cash-out can send now, as the wallet reports it; null while the
 * wallet isn't active or the API is one that doesn't send them yet.
 */
export function limitsFromWallet(
  wallet: WalletResponse | undefined,
): CashOutAmountLimits | null {
  if (wallet?.status !== "active" || !wallet.cashOutLimits) return null;
  const { minKesCents, maxKesCents } = wallet.cashOutLimits;
  return {
    minKesCents: minKesCents === null ? null : BigInt(minKesCents),
    maxKesCents: maxKesCents === null ? null : BigInt(maxKesCents),
  };
}

/**
 * The limits a bill's KES amount keeps to: only a payee paid by cash-out
 * has any. USDC payees, payees paid outside Expendi and payees with no
 * payment details yet have none.
 */
export function limitsForPayee(
  method: PayeeMethod | null | undefined,
  limits: CashOutAmountLimits | null,
): CashOutAmountLimits | null {
  return limits !== null && paysByCashOut(method ?? null) ? limits : null;
}

/** "Smallest amount: KES 20" under the amount; null while the minimum is unknown. */
export function smallestAmountHint(
  limits: CashOutAmountLimits | null,
): string | null {
  if (limits?.minKesCents === null || limits?.minKesCents === undefined) {
    return null;
  }
  return `Smallest amount: KES ${formatKes(limits.minKesCents.toString())}`;
}

/**
 * The API's message for a typed KES amount one cash-out can't send, or
 * null. A blank or unreadable amount is left to the request schema.
 */
export function typedAmountProblem(
  typed: string,
  limits: CashOutAmountLimits | null,
): string | null {
  if (limits === null) return null;
  const cents = parseKesToCents(typed);
  return cents === null ? null : cashOutAmountProblem(cents, limits);
}

const fieldDetailsSchema = z.object({ field: z.string() });

/**
 * A 400 about one request field (`details.field`), as an issue for the
 * form to show on that field; none when the form has no such field. The
 * limits can change after the form loaded, so the API can still refuse.
 */
export function serverFieldIssues(
  error: unknown,
  fields: Readonly<Partial<Record<string, string>>>,
): { path: [string]; message: string }[] {
  if (!(error instanceof ApiError) || error.status !== 400) return [];
  const parsed = fieldDetailsSchema.safeParse(error.details);
  if (!parsed.success || fields[parsed.data.field] === undefined) return [];
  return [{ path: [parsed.data.field], message: error.message }];
}
