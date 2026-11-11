import { eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { PAYEE_CHANGE_HOLD_HOURS } from "@expendi-business/shared";

import type { PayeeRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { PayoutRecipient } from "../paycrest/recipient.js";
import { memberships, payees } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { requireConfirmedPayoutPhone } from "../phone-verification/payout-phone.js";
import { detailsOf } from "./details.js";

/**
 * What paying a payee must pass (spec §6.19, §7.8). Bills (T37) and payroll
 * runs (T39) call these inside the transaction that prepares the payment.
 */

export class PayeeNotFound extends Data.TaggedError("PayeeNotFound")<{
  readonly payeeId: string;
  readonly message: string;
}> {}

/**
 * The payee's details changed less than 24 hours ago and the admin hasn't
 * confirmed a second time that they mean to pay them.
 */
export class PayeeChangeUnconfirmed extends Data.TaggedError(
  "PayeeChangeUnconfirmed",
)<{
  readonly payeeId: string;
  readonly detailsChangedAt: Date;
  readonly message: string;
}> {}

/**
 * The payee's details changed after the payment was prepared, so the
 * approval no longer pays the details the admin reviewed.
 */
export class PayeeChangedSincePrepared extends Data.TaggedError(
  "PayeeChangedSincePrepared",
)<{
  readonly payeeId: string;
  readonly message: string;
}> {}

export type PayeeNotPayableReason =
  "archived" | "no_details" | "paid_outside" | "no_confirmed_phone";

export class PayeeNotPayable extends Data.TaggedError("PayeeNotPayable")<{
  readonly payeeId: string;
  readonly reason: PayeeNotPayableReason;
  readonly message: string;
}> {}

export interface PayeeChangeConfirmation {
  /**
   * The admin saw the "details changed recently" warning and confirmed
   * again, in this request. Only the app's explicit second confirmation
   * may set it; never default it to true.
   */
  readonly secondConfirmation: boolean;
}

interface PayeeForPayment {
  readonly row: PayeeRow;
  readonly userId: string | null;
  readonly withinChangeHold: boolean;
}

/**
 * The payee, read under a share lock so its details can't change before
 * the caller's transaction ends. The 24 hours are measured on the
 * database's clock, the same one that set `details_changed_at`.
 */
function loadForPayment(
  tx: Transaction,
  payeeId: string,
): Effect.Effect<PayeeForPayment, PayeeNotFound | DatabaseError> {
  return query(() =>
    tx
      .select({
        row: payees,
        userId: memberships.userId,
        withinChangeHold: sql<boolean>`coalesce(${payees.detailsChangedAt} > now() - make_interval(hours => ${PAYEE_CHANGE_HOLD_HOURS}), false)`,
      })
      .from(payees)
      .leftJoin(memberships, eq(memberships.id, payees.membershipId))
      .where(eq(payees.id, payeeId))
      .for("share", { of: payees }),
  ).pipe(
    Effect.flatMap(([payee]) =>
      payee
        ? Effect.succeed(payee)
        : Effect.fail(
            new PayeeNotFound({ payeeId, message: "That payee wasn't found." }),
          ),
    ),
  );
}

function checkChangeHold(
  { row, withinChangeHold }: PayeeForPayment,
  { secondConfirmation }: PayeeChangeConfirmation,
): Effect.Effect<void, PayeeChangeUnconfirmed> {
  if (!withinChangeHold || secondConfirmation || !row.detailsChangedAt) {
    return Effect.void;
  }
  return Effect.fail(
    new PayeeChangeUnconfirmed({
      payeeId: row.id,
      detailsChangedAt: row.detailsChangedAt,
      message: `${row.name}'s payment details changed in the last ${PAYEE_CHANGE_HOLD_HOURS} hours. Check them, then confirm again to pay.`,
    }),
  );
}

/**
 * Refuses to pay a payee whose details changed less than 24 hours ago,
 * unless the caller passes the admin's explicit second confirmation
 * (spec §7.8). Enforced here, not only in the app.
 */
export function assertPayeeChangeConfirmed(
  tx: Transaction,
  payeeId: string,
  confirmation: PayeeChangeConfirmation,
): Effect.Effect<void, PayeeNotFound | PayeeChangeUnconfirmed | DatabaseError> {
  return loadForPayment(tx, payeeId).pipe(
    Effect.flatMap((payee) => checkChangeHold(payee, confirmation)),
  );
}

const notPayable = (
  row: PayeeRow,
  reason: PayeeNotPayableReason,
  message: string,
) => Effect.fail(new PayeeNotPayable({ payeeId: row.id, reason, message }));

/**
 * Where to pay the payee right now, as the payout engine's recipient. It
 * applies `assertPayeeChangeConfirmed` first, so the 24-hour rule can't be
 * skipped by a caller that only needs the recipient.
 *
 * An employee on M-Pesa is paid to the number they confirmed by SMS, read
 * from `users.phone` now with `requireConfirmedPayoutPhone` (spec §6.18):
 * the payee never stores it, so a number they change later is the one
 * paid. Without a confirmed number they can't be paid.
 */
export function resolvePayeeRecipient(
  tx: Transaction,
  payeeId: string,
  confirmation: PayeeChangeConfirmation,
): Effect.Effect<
  PayoutRecipient,
  PayeeNotFound | PayeeNotPayable | PayeeChangeUnconfirmed | DatabaseError
> {
  return loadForPayment(tx, payeeId).pipe(
    Effect.flatMap((payee) =>
      recipientOf(tx, payee, checkChangeHold(payee, confirmation)),
    ),
  );
}

/**
 * The same recipient, for a payment being approved: the 24-hour rule was
 * applied when it was prepared (`resolvePayeeRecipient`), so here the
 * payee's details must simply be unchanged since then (`preparedAt`, on
 * the database's clock). Called under the approval's locks.
 */
export function resolveApprovedPayeeRecipient(
  tx: Transaction,
  payeeId: string,
  preparedAt: Date,
): Effect.Effect<
  PayoutRecipient,
  PayeeNotFound | PayeeNotPayable | PayeeChangedSincePrepared | DatabaseError
> {
  return loadForPayment(tx, payeeId).pipe(
    Effect.flatMap((payee) =>
      recipientOf(tx, payee, checkUnchangedSince(payee.row, preparedAt)),
    ),
  );
}

function checkUnchangedSince(
  row: PayeeRow,
  preparedAt: Date,
): Effect.Effect<void, PayeeChangedSincePrepared> {
  if (row.detailsChangedAt === null || row.detailsChangedAt <= preparedAt) {
    return Effect.void;
  }
  return Effect.fail(
    new PayeeChangedSincePrepared({
      payeeId: row.id,
      message: `${row.name}'s payment details changed after this payment was prepared. Nothing was sent. Check them, then pay again.`,
    }),
  );
}

function recipientOf<E>(
  tx: Transaction,
  payee: PayeeForPayment,
  changeCheck: Effect.Effect<void, E>,
): Effect.Effect<PayoutRecipient, PayeeNotPayable | E | DatabaseError> {
  return Effect.gen(function* () {
    const { row } = payee;
    if (row.archived) {
      return yield* notPayable(row, "archived", `${row.name} is archived.`);
    }
    const details = detailsOf(row);
    if (details === null) {
      return yield* notPayable(
        row,
        "no_details",
        `Add ${row.name}'s payment details first.`,
      );
    }
    if (details.method === "outside") {
      return yield* notPayable(
        row,
        "paid_outside",
        `${row.name} is paid outside Expendi.`,
      );
    }
    yield* changeCheck;

    switch (details.method) {
      case "mpesa_phone": {
        if (details.phone !== undefined)
          return { ...details, phone: details.phone };
        if (payee.userId === null) {
          return yield* Effect.dieMessage(
            `employee payee ${row.id} has no user`,
          );
        }
        const phone = yield* requireConfirmedPayoutPhone(tx, payee.userId).pipe(
          Effect.catchTag("PayoutPhoneNotConfirmed", () =>
            notPayable(
              row,
              "no_confirmed_phone",
              `${row.name} hasn't confirmed their M-Pesa number yet, so they can't be paid.`,
            ),
          ),
        );
        return {
          method: "mpesa_phone",
          phone,
          accountName: details.accountName,
        };
      }
      case "mpesa_till":
      case "mpesa_paybill":
      case "bank":
        return details;
      case "usdc":
        return {
          method: "usdc",
          chain: details.chain,
          address: details.address,
          accountName: row.name,
        };
    }
  });
}
