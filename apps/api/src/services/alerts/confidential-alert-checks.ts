import { eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { BaseRpc } from "../chain/base-rpc.js";
import type { NearRpc } from "../chain/near-rpc.js";
import type { ConfidentialAccounts } from "../intents/confidential-account.js";
import type { AlertSignal, CheckResult } from "./ops-alerts.js";
import { wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { MOVE_IN_MIN_USDC } from "../intents/confidential-account.js";
import { fromMicro } from "../paycrest/amounts.js";
import { reconcileBalances } from "../wallet/reconcile.js";

/**
 * The ledger against what the company holds, for a company that keeps its
 * USDC in a confidential account (docs/decisions/confidential-accounts.md).
 * Nobody outside can check that balance on a chain, and there is no list of
 * arrivals to read, so this comparison is the only thing that shows USDC
 * that reached the account without a quote of ours, or a delivery 1Click
 * reported wrongly. It reads, saves what it read, and raises or clears the
 * alert; it never moves money or writes to the ledger.
 */

const SYSTEM_SCOPE = {} as const;

interface ConfidentialWalletRow extends Record<string, unknown> {
  readonly wallet_id: string;
  readonly organization_id: string;
  readonly organization_name: string;
}

const usdc = (units: bigint | null): string =>
  units === null ? "not read" : `${fromMicro(units)} USDC`;

/** Saves the reading for staff, whose code can't sign in to take one. */
function saveReading(
  organizationId: string,
  walletId: string,
  confidentialUsdc: bigint,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .update(wallets)
        .set({ confidentialUsdc, confidentialUsdcReadAt: sql`now()` })
        .where(eq(wallets.id, walletId)),
    ),
  ).pipe(Effect.asVoid);
}

/** Which way the figures disagree, or null when they don't. */
function disagreement(figures: {
  readonly differenceUsdc: bigint;
  readonly expendiSurplusUsdc: bigint;
  readonly companyWalletSurplusUsdc: bigint;
  readonly companyWalletUsdc: bigint;
}): "short" | "unexplained" | null {
  if (figures.differenceUsdc < 0n) return "short";
  if (figures.differenceUsdc <= figures.expendiSurplusUsdc) return null;
  const waitingToBeMovedIn =
    figures.companyWalletUsdc >
    figures.companyWalletSurplusUsdc + MOVE_IN_MIN_USDC;
  return waitingToBeMovedIn ? null : "unexplained";
}

/**
 * Company wallet + transit wallet + confidential account, less the ledger,
 * for every company that keeps its USDC in a confidential account.
 *
 * Fires when the difference is negative: the ledger promises more than the
 * company holds, which includes a float Expendi's costs have spent below
 * zero. Fires when it is positive by more than Expendi's recorded surplus
 * (its own USDC: the float in the confidential account and what a hop left
 * in the company wallet, not the company's), unless the company wallet holds
 * more than its own part of that surplus and a move-in's minimum: the excess
 * is then public USDC waiting to be moved in, which the deposit watcher
 * credits. What is left is USDC in the confidential account that no quote
 * credited and no watcher ever will.
 *
 * The alert stays as it is, neither raised nor cleared, when a balance
 * can't be read, when any money is in flight (a move-in, a delivery, a
 * credit due, a send, a payout, a Treasury move), or when a quote settled or
 * a ledger row was written in the last 5 minutes. A delivery still
 * uncredited 10 minutes after it settled explains nothing and fires the
 * alert whatever the difference. Each reading taken is saved on the
 * company's wallet row for the admin app.
 */
export function confidentialBalanceCheck(
  now: Date = new Date(),
): Effect.Effect<
  CheckResult,
  DatabaseError,
  DatabaseService | NearRpc | BaseRpc | ConfidentialAccounts
> {
  return Effect.gen(function* () {
    const { rows } = yield* withScope(SYSTEM_SCOPE, (tx) =>
      query(() =>
        tx.execute<ConfidentialWalletRow>(
          sql`SELECT * FROM confidential_account_wallets()`,
        ),
      ),
    );
    const firing: AlertSignal[] = [];
    const keep: string[] = [];

    for (const row of rows) {
      const id = row.organization_id;
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const reading = yield* reconcileBalances(id, now);
          if (reading !== null && reading.confidentialUsdc !== null) {
            yield* saveReading(id, row.wallet_id, reading.confidentialUsdc);
          }
          return reading;
        }),
      );
      if (Exit.isFailure(exit)) {
        console.error(
          `[alerts] Confidential account of company ${id} unreadable`,
          Cause.pretty(exit.cause),
        );
        keep.push(id);
        continue;
      }
      const reading = exit.value;
      if (reading?.balanceHome !== "confidential_account") {
        keep.push(id);
        continue;
      }
      const { nearUsdc, differenceUsdc } = reading;
      const comparable =
        nearUsdc !== null &&
        differenceUsdc !== null &&
        reading.inFlight.length === 0 &&
        !reading.recentActivity;
      const verdict = comparable
        ? disagreement({
            differenceUsdc,
            expendiSurplusUsdc: reading.expendiSurplusUsdc,
            companyWalletSurplusUsdc: reading.companyWalletSurplusUsdc,
            companyWalletUsdc: nearUsdc,
          })
        : null;
      const overdue = reading.overdueCredits;
      if (!comparable && overdue.length === 0) {
        keep.push(id);
        continue;
      }
      if (verdict === null && overdue.length === 0) continue;
      firing.push({
        kind: "confidential_balance_mismatch",
        subjectKey: id,
        organizationId: id,
        title:
          verdict === null
            ? `Delivered payment missing from the ledger at ${row.organization_name}`
            : `Confidential account doesn't match the ledger at ${row.organization_name}`,
        details: [
          { label: "Company", value: row.organization_name },
          { label: "Ledger", value: usdc(reading.ledgerUsdc) },
          { label: "Company wallet", value: usdc(nearUsdc) },
          { label: "Transit wallet", value: usdc(reading.baseUsdc) },
          {
            label: "Confidential account",
            value: usdc(reading.confidentialUsdc),
          },
          ...(differenceUsdc === null
            ? []
            : [
                {
                  label: "Held less ledger",
                  value: `${usdc(differenceUsdc)}, of which Expendi's recorded surplus explains ${usdc(reading.expendiSurplusUsdc)}`,
                },
              ]),
          ...(overdue.length === 0
            ? []
            : [
                {
                  label: "Delivered but not credited",
                  value: `1Click reports these quotes delivered, but they are not in the ledger: ${overdue.join(", ")}`,
                },
              ]),
          ...(verdict === null
            ? []
            : [
                {
                  label: "What to check",
                  value:
                    verdict === "short"
                      ? "The company holds less than the ledger says it has. Look at its recent payouts, sends and fund-ins first: a delivery 1Click reported but never made would show up here."
                      : "The company holds more than the ledger and Expendi's surplus explain. Compare the company wallet, transit wallet and confidential account figures with recent transfers and quotes. An unrecorded transfer into any of these can explain the excess; do not assume it reached the confidential account.",
                },
              ]),
        ],
      });
    }
    return { kind: "confidential_balance_mismatch", firing, keep };
  });
}
