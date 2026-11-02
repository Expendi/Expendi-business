import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import { formatKesAmount, parseMpesaSms } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { receiptFiles } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { BadRequest } from "../../errors.js";

/**
 * A pasted M-Pesa SMS is evidence, not a form filler: the app's own reading
 * only pre-fills the form, and the API reads the stored text again on every
 * write (spec §6.4, §6.5).
 */

/** The SMS among these receipts; `checkAttachableReceipts` allows at most one. */
export function smsTextAmong(
  tx: Transaction,
  organizationId: string,
  receipts:
    | { readonly receiptFileIds: readonly string[] }
    | { readonly expenseId: string },
): Effect.Effect<string | null, DatabaseError> {
  return query(() =>
    tx
      .select({ smsText: receiptFiles.smsText })
      .from(receiptFiles)
      .where(
        and(
          eq(receiptFiles.organizationId, organizationId),
          eq(receiptFiles.kind, "sms_text"),
          "expenseId" in receipts
            ? eq(receiptFiles.expenseId, receipts.expenseId)
            : inArray(receiptFiles.id, [...receipts.receiptFileIds]),
        ),
      )
      .limit(1),
  ).pipe(Effect.map(([file]) => file?.smsText ?? null));
}

export interface SmsCheckedFields {
  readonly mpesaCode: string | null;
  readonly amountKes: bigint;
}

/**
 * The M-Pesa code to store: the SMS's own when the employee left it out.
 * Refuses a code or amount that contradicts the attached SMS.
 */
export function reconcileWithSms(
  fields: SmsCheckedFields,
  smsText: string | null,
): Effect.Effect<string | null, BadRequest> {
  if (smsText === null) return Effect.succeed(fields.mpesaCode);
  const parsed = parseMpesaSms(smsText);
  if (!parsed.ok) {
    return Effect.fail(
      new BadRequest({
        message:
          "The attached M-Pesa SMS can't be read. Remove it and add a photo instead.",
      }),
    );
  }
  const { sms } = parsed;
  if (fields.mpesaCode !== null && fields.mpesaCode !== sms.code) {
    return Effect.fail(
      new BadRequest({
        message: `The M-Pesa code doesn't match the SMS you attached, which says ${sms.code}.`,
      }),
    );
  }
  const smsAmount = BigInt(sms.amountKesCents);
  if (fields.amountKes !== smsAmount) {
    return Effect.fail(
      new BadRequest({
        message: `The amount doesn't match the SMS you attached, which says ${formatKesAmount(smsAmount)}.`,
      }),
    );
  }
  return Effect.succeed(sms.code);
}
