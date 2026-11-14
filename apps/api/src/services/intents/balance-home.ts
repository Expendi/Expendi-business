import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import type { Wallet } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import {
  companyWalletSends,
  intentQuotes,
  payouts,
  RESERVING_STATUSES,
  treasuryMoves,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { NearRelayer } from "../chain/near-relayer.js";
import { NearRpc } from "../chain/near-rpc.js";
import { isImplicitNearAccount } from "../chain/near.js";
import { ConfidentialAccounts } from "./confidential-account.js";
import { recordedExpendiSurplus } from "./expendi-surplus.js";

export class BalanceHomeNotReady extends Data.TaggedError(
  "BalanceHomeNotReady",
)<{
  readonly message: string;
}> {}

export const FEE_FLOAT_TARGET_USDC = 1_000_000n;
const refuse = (message: string) =>
  Effect.fail(new BalanceHomeNotReady({ message }));

/** Shared by switches and activation. Lock the wallet before calling. */
export function balanceHomeBusy(
  tx: Transaction,
  wallet: Pick<Wallet, "id" | "organizationId">,
) {
  return Effect.gen(function* () {
    const quotes = yield* query(() =>
      tx
        .select({ purpose: intentQuotes.purpose, status: intentQuotes.status })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.walletId, wallet.id),
            inArray(intentQuotes.status, [...UNSETTLED_INTENT_QUOTE_STATUSES]),
          ),
        ),
    );
    const payments = yield* query(() =>
      tx
        .select({ status: payouts.status })
        .from(payouts)
        .where(
          and(
            eq(payouts.walletId, wallet.id),
            inArray(payouts.status, [
              ...RESERVING_STATUSES,
              "needs_review",
              "paying",
            ]),
          ),
        ),
    );
    const moves = yield* query(() =>
      tx
        .select({ status: treasuryMoves.status })
        .from(treasuryMoves)
        .where(
          and(
            eq(treasuryMoves.walletId, wallet.id),
            inArray(treasuryMoves.status, ["open", "needs_review"]),
          ),
        ),
    );
    const sends = yield* query(() =>
      tx
        .select({ status: companyWalletSends.status })
        .from(companyWalletSends)
        .where(
          and(
            eq(companyWalletSends.walletId, wallet.id),
            inArray(companyWalletSends.status, ["reserved", "signed"]),
          ),
        ),
    );
    const credits = yield* query(() =>
      tx
        .select({ id: intentQuotes.id })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.walletId, wallet.id),
            eq(intentQuotes.status, "succeeded"),
            eq(intentQuotes.recipientType, "CONFIDENTIAL_INTENTS"),
            isNull(intentQuotes.ledgerCreditedAt),
            inArray(intentQuotes.purpose, [
              "fund_in",
              "invoice_payment",
              "fund_in_return",
              "from_treasury",
            ]),
          ),
        ),
    );
    // Exact-output quotes can return their unused buffer after SUCCESS.
    // The measured return was about a minute later; use the same five-minute
    // quiet period as balance reconciliation before allowing a switch.
    const returningBuffers = yield* query(() =>
      tx
        .select({ id: intentQuotes.id })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.walletId, wallet.id),
            eq(intentQuotes.status, "succeeded"),
            eq(intentQuotes.depositType, "CONFIDENTIAL_INTENTS"),
            eq(intentQuotes.swapType, "EXACT_OUTPUT"),
            gt(intentQuotes.settledAt, new Date(Date.now() - 5 * 60_000)),
          ),
        ),
    );
    return [
      ...quotes.map((q) => `a ${q.purpose} quote is ${q.status}`),
      ...payments.map((p) => `a payout is ${p.status}`),
      ...moves.map((m) => `a Treasury move is ${m.status}`),
      ...sends.map((s) => `a company wallet send is ${s.status}`),
      ...credits.map((q) => `quote ${q.id} is awaiting its ledger credit`),
      ...returningBuffers.map(
        (q) =>
          `quote ${q.id} is inside its five-minute buffer-return quiet period`,
      ),
    ];
  });
}

/** Serialises activation budgets across companies and API instances. */
export const lockConfidentialRollout = (tx: Transaction) =>
  query(() => tx.execute(sql`SELECT pg_advisory_xact_lock(72061)`)).pipe(
    Effect.asVoid,
  );

/**
 * The relayer must cover this company's float and every previously admitted
 * company's outstanding float. A conservative reservation: even a refill in
 * flight counts until delivery settles. No credentials or balances cross RLS.
 * Caller holds lockConfidentialRollout, then the company wallet row lock.
 */
export function checkConfidentialReadiness(tx: Transaction, wallet: Wallet) {
  return Effect.gen(function* () {
    if (
      wallet.chain !== "near" ||
      !wallet.address ||
      !wallet.privyWalletId ||
      !isImplicitNearAccount(wallet.address)
    ) {
      return yield* refuse("The company has no usable company wallet on NEAR");
    }
    const accounts = yield* ConfidentialAccounts;
    const confidentialUsdc = yield* accounts
      .usdcBalance({
        accountId: wallet.address,
        privyWalletId: wallet.privyWalletId,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new BalanceHomeNotReady({
              message: `The company's confidential account couldn't be read: ${error.message}`,
            }),
        ),
      );
    const relayer = yield* NearRelayer;
    const rpc = yield* NearRpc;
    const held = yield* rpc.usdcBalance(relayer.accountId).pipe(
      Effect.mapError(
        (error) =>
          new BalanceHomeNotReady({
            message: `The gas relayer's USDC balance couldn't be read: ${error.message}`,
          }),
      ),
    );
    const { rows } = yield* query(() =>
      tx.execute<{ required: string }>(
        sql`SELECT confidential_rollout_reserve(${wallet.id})::text AS required`,
      ),
    );
    const float = yield* recordedExpendiSurplus(
      tx,
      wallet.id,
      undefined,
      "confidential_account",
    );
    const needed =
      FEE_FLOAT_TARGET_USDC > float ? FEE_FLOAT_TARGET_USDC - float : 0n;
    if (held < BigInt(rows[0]?.required ?? "0") + needed) {
      return yield* refuse(
        "The gas relayer cannot fund this company's fee float and the floats already reserved",
      );
    }
    return confidentialUsdc;
  });
}

/** Administrative switch; never signs or sends a payment itself. */
export function changeBalanceHome(
  organizationId: string,
  target: "company_wallet" | "confidential_account",
) {
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      yield* lockConfidentialRollout(tx);
      const [wallet] = yield* query(() =>
        tx
          .select()
          .from(wallets)
          .where(eq(wallets.organizationId, organizationId))
          .for("update"),
      );
      if (
        wallet?.status !== "active" ||
        wallet.chain !== "near" ||
        !wallet.address ||
        !wallet.privyWalletId
      ) {
        return yield* refuse(
          "The company has no active company wallet on NEAR",
        );
      }
      if (wallet.balanceHomeChanging) {
        return yield* refuse(
          "The company's move-out is already running; the job resumes it automatically",
        );
      }
      if (wallet.balanceHome === target)
        return yield* refuse(`The company's balance home is already ${target}`);
      const busy = yield* balanceHomeBusy(tx, wallet);
      if (busy.length)
        return yield* refuse(
          `Something of the company's is in flight: ${busy.join("; ")}`,
        );
      const float = yield* recordedExpendiSurplus(
        tx,
        wallet.id,
        undefined,
        "confidential_account",
      );
      if (target === "company_wallet" && float < 0n) {
        return yield* refuse(
          "Refill the company's fee float before moving its balance back to the company wallet",
        );
      }
      const accounts = yield* ConfidentialAccounts;
      const confidentialUsdc =
        target === "confidential_account"
          ? yield* checkConfidentialReadiness(tx, wallet)
          : yield* accounts
              .usdcBalance({
                accountId: wallet.address,
                privyWalletId: wallet.privyWalletId,
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new BalanceHomeNotReady({
                      message: `The company's confidential account couldn't be read: ${error.message}`,
                    }),
                ),
              );
      // An empty account with a float still recorded drains too: the move-out
      // job writes that float off when it finishes.
      const draining =
        target === "company_wallet" && (confidentialUsdc > 0n || float !== 0n);
      const balanceHome = draining ? wallet.balanceHome : target;
      yield* query(() =>
        tx
          .update(wallets)
          .set({
            balanceHome,
            balanceHomeChanging: draining,
            confidentialOptOut: target === "company_wallet",
            balanceHomeChangedAt: new Date(),
          })
          .where(eq(wallets.id, wallet.id)),
      );
      const audit = yield* AuditLog;
      yield* audit.record(tx, {
        actor: { type: "system", id: "confidential-account-script" },
        organizationId,
        action: draining
          ? "wallet.move_out_requested"
          : "wallet.balance_home_changed",
        entity: { type: "wallet", id: wallet.id },
        before: { balanceHome: wallet.balanceHome },
        after: { balanceHome, confidentialUsdc },
      });
      return {
        balanceHome,
        confidentialUsdc,
        ...(draining ? { draining: true as const } : {}),
      };
    }),
  );
}
