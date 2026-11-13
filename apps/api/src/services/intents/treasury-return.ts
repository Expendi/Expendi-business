import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { BaseRpc } from "../chain/base-rpc.js";
import type { ConfidentialAccounts } from "./confidential-account.js";
import { intentQuotes, treasuryMoves, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { baseUsdcBalance } from "../chain/base-rpc.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { sessionForQuote } from "./company-session.js";
import { OneClick } from "./one-click.js";
import { DEPOSIT_MARGIN_MS } from "./quote-deposit.js";
import { moveQuote, quoteById, settleFromOneClick } from "./quote-settle.js";

/**
 * Paying a `from_treasury` quote (docs/work/treasury/spec.md, section 4,
 * "Move to wallet"): the Treasury wallet sends the part to the quote's
 * deposit address through Privy, as the transit wallet pays a sweep, then
 * 1Click's status settles the quote. A part is never a ledger entry itself:
 * its delivery to the company wallet is, once the deposit watcher confirms it,
 * or, for a part delivered into a confidential account, once 1Click reports
 * it `SUCCESS` (`quote-credit.ts`).
 *
 * 1Click reports a part that delivers into a confidential account only to the
 * company's session, so such a part never starts, and is never settled,
 * without one.
 */

export type TreasuryReturnDeps =
  DatabaseService | OneClick | BaseRpc | PrivyWallets | ConfidentialAccounts;

/** The key Privy replays rather than repeats, one per quote. */
export const treasuryReturnSendKey = (quoteId: string): string =>
  `treasury-return-${quoteId}`;

/**
 * Whether the quote may still be paid, read from the rows as they are now
 * (spec section 6, rule 5): its move is open, and it still pays the
 * company's own company wallet and refunds to its own Treasury wallet, as the
 * `wallets` row says. Nothing the request or the quote row says decides where
 * the money goes.
 */
function payableWallet(quote: IntentQuote) {
  const { treasuryMoveId } = quote;
  if (treasuryMoveId === null) {
    return Effect.succeed({
      ok: false,
      reason: "The quote belongs to no move. Nothing was sent.",
    } as const);
  }
  return withScope({ organizationId: quote.organizationId }, (tx) =>
    Effect.gen(function* () {
      const [move] = yield* query(() =>
        tx
          .select({ status: treasuryMoves.status })
          .from(treasuryMoves)
          .where(eq(treasuryMoves.id, treasuryMoveId)),
      );
      const [wallet] = yield* query(() =>
        tx.select().from(wallets).where(eq(wallets.id, quote.walletId)),
      );
      if (move?.status !== "open") {
        return {
          ok: false,
          reason: "The move is no longer open. Nothing was sent.",
        } as const;
      }
      if (
        wallet?.treasuryAddress == null ||
        wallet.treasuryPrivyWalletId === null ||
        wallet.address === null ||
        quote.recipient !== wallet.address ||
        quote.refundTo !== wallet.treasuryAddress
      ) {
        return {
          ok: false,
          reason:
            "The quote doesn't pay the company's own company wallet and refund its own Treasury wallet. Nothing was sent.",
        } as const;
      }
      return {
        ok: true,
        treasuryPrivyWalletId: wallet.treasuryPrivyWalletId,
        treasuryAddress: wallet.treasuryAddress,
      } as const;
    }),
  );
}

/**
 * Moves a saved `from_treasury` quote as far as it can go now. The Treasury
 * wallet's one send is recorded as starting before Privy is asked, under a
 * key Privy replays rather than repeats:
 *
 * - the deadline too close, the move no longer open, or the quote not paying
 *   the company's own wallets: `expired`, nothing moved;
 * - the wallet not holding the amount yet (a refunded part still arriving):
 *   left alone until the deadline margin expires it;
 * - Privy refuses: `failed`, nothing moved;
 * - Privy's answer is lost, or a run stopped between recording the start and
 *   saving the answer: `needs_review`, never sent again. 1Click's own report
 *   of the deposit still settles it if the send did go out.
 */
export function advanceTreasuryReturnQuote(
  input: Pick<IntentQuote, "id" | "organizationId">,
): Effect.Effect<IntentQuote, DatabaseError, TreasuryReturnDeps> {
  const { organizationId } = input;
  return Effect.gen(function* () {
    let quote = yield* quoteById(organizationId, input.id);
    const signIn = sessionForQuote(quote).pipe(
      Effect.map((session) => ({ session })),
      Effect.catchIf(
        (error) => error._tag !== "DatabaseError",
        () => Effect.succeed(null),
      ),
    );
    const reread = quoteById(organizationId, quote.id);
    const untouched = and(
      eq(intentQuotes.status, "quoted"),
      isNull(intentQuotes.depositStartedAt),
    );
    const expire = (failure: string) =>
      moveQuote(quote, untouched, {
        status: "expired",
        settledAt: new Date(),
        failure,
      }).pipe(Effect.zipRight(reread));
    const unsent = and(
      eq(intentQuotes.status, "depositing"),
      isNull(intentQuotes.depositPrivyTransactionId),
      isNull(intentQuotes.depositTxHash),
    );

    if (quote.status === "quoted") {
      if (quote.deadline.getTime() - Date.now() < DEPOSIT_MARGIN_MS) {
        return yield* expire(
          "The quote's deadline came before the transfer could start. Nothing moved.",
        );
      }
      const payable = yield* payableWallet(quote);
      if (!payable.ok) return yield* expire(payable.reason);
      const held = yield* baseUsdcBalance(payable.treasuryAddress).pipe(
        Effect.either,
      );
      if (held._tag === "Left" || held.right < quote.amountIn) return quote;
      if ((yield* signIn) === null) return quote;

      const started = yield* moveQuote(quote, untouched, {
        status: "depositing",
        depositStartedAt: new Date(),
      });
      if (started === null) return yield* reread;
      quote = started;

      const privy = yield* PrivyWallets;
      const sent = yield* privy
        .sendUsdc({
          privyWalletId: payable.treasuryPrivyWalletId,
          to: quote.depositAddress,
          amount: quote.amountIn,
          idempotencyKey: treasuryReturnSendKey(quote.id),
        })
        .pipe(Effect.either);
      if (sent._tag === "Left") {
        const failure = sent.left;
        yield* moveQuote(
          quote,
          unsent,
          failure._tag === "SendRefused"
            ? {
                status: "failed",
                settledAt: new Date(),
                failure: `The Treasury wallet refused the transfer${failure.policyViolation ? " (blocked by its policy)" : ""}. Nothing moved.`,
              }
            : {
                status: "needs_review",
                failure:
                  "The Treasury wallet's transfer may have been sent: its outcome is unknown. Check the Treasury wallet on Base before doing anything; never send again.",
              },
        );
        return yield* reread;
      }
      const saved = yield* moveQuote(quote, unsent, {
        depositPrivyTransactionId: sent.right.privyTransactionId,
        depositTxHash: sent.right.txHash,
      });
      quote = saved ?? (yield* reread);
    } else if (
      quote.status === "depositing" &&
      quote.depositPrivyTransactionId === null &&
      quote.depositTxHash === null
    ) {
      yield* moveQuote(quote, unsent, {
        status: "needs_review",
        failure:
          "The Treasury wallet's transfer was started and its outcome was never saved. Check the Treasury wallet on Base before doing anything; never send again.",
      });
      quote = yield* reread;
    }

    if (quote.status !== "depositing" && quote.status !== "needs_review") {
      return quote;
    }
    const signedIn = yield* signIn;
    if (signedIn === null) return quote;
    const { session } = signedIn;
    if (quote.depositTxHash !== null && quote.depositSubmittedAt === null) {
      const oneClick = yield* OneClick;
      const told = yield* oneClick
        .submitDeposit(quote.depositAddress, quote.depositTxHash, session)
        .pipe(Effect.either);
      if (told._tag === "Right") {
        yield* moveQuote(quote, isNull(intentQuotes.depositSubmittedAt), {
          depositSubmittedAt: new Date(),
        });
        quote = yield* reread;
      }
    }
    return yield* settleFromOneClick(quote, session);
  });
}
