import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { BaseRpc } from "../chain/base-rpc.js";
import type { OneClickSession } from "./one-click.js";
import {
  intentQuotes,
  payouts,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { baseUsdcBalance } from "../chain/base-rpc.js";
import { isImplicitNearAccount } from "../chain/near.js";
import { isPaused } from "../payout/guards.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { sessionForQuote } from "./company-session.js";
import { ConfidentialAccounts } from "./confidential-account.js";
import { ONE_CLICK_USDC_ASSET_IDS, OneClick } from "./one-click.js";
import {
  COMPANY_QUOTE_TTL_MS,
  DEPOSIT_MARGIN_MS,
  maxQuoteCost,
  STABLECOIN_SLIPPAGE_BPS,
} from "./quote-deposit.js";
import { moveQuote, settleFromOneClick } from "./quote-settle.js";

/**
 * Sweeps (CONTEXT.md): whatever sits in a transit wallet once nothing of
 * the company's is in flight goes back to the company wallet, through a
 * Base to NEAR `EXACT_INPUT` quote paid by the transit wallet
 * (docs/decisions/near-main-chain.md, "Base hop", rule 7). What it finds
 * there is what a hop delivered beyond an order's exact amount, a hop whose
 * cash-out never funded, and Paycrest's refunds.
 *
 * A sweep moves a company's money between its own two wallets: it is never
 * a ledger entry, and its arrival on NEAR is one of the quote's own
 * transactions, which the deposit watcher skips.
 *
 * For a company whose balance is kept in a confidential account the sweep
 * delivers into that account instead (`CONFIDENTIAL_INTENTS`), and 1Click
 * talks about it only to the company's session. The refund still goes to
 * the transit wallet on Base. The dust threshold is the same: the 0.15 USDC
 * minimum of a delivery into the account is far below it.
 */

/** Balances up to this stay put: sweeping them would cost more than it returns. */
export const SWEEP_DUST_USDC = 1_000_000n;

const BASE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type SweepDeps =
  DatabaseService | OneClick | BaseRpc | PrivyWallets | ConfidentialAccounts;

/**
 * Whether anything of the company's could still need, or still change, the
 * transit wallet's balance: a quote that isn't settled (a hop on its way
 * in, another sweep, a delivery), or a cash-out between approval and its
 * funding transfer. A fund-in doesn't count: it only ever pays the company
 * wallet, and stays open for hours.
 */
function somethingInFlight(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<boolean, DatabaseError> {
  return Effect.gen(function* () {
    const [quote] = yield* query(() =>
      tx
        .select({ id: intentQuotes.id })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            inArray(intentQuotes.purpose, ["base_hop", "sweep", "usdc_payout"]),
            inArray(intentQuotes.status, [...UNSETTLED_INTENT_QUOTE_STATUSES]),
          ),
        )
        .limit(1),
    );
    if (quote) return true;
    const [cashOut] = yield* query(() =>
      tx
        .select({ id: payouts.id })
        .from(payouts)
        .where(
          and(
            eq(payouts.organizationId, organizationId),
            or(
              and(
                eq(payouts.provider, "paycrest"),
                inArray(payouts.status, [
                  "approved",
                  "order_created",
                  "funding",
                ]),
              ),
              // A Pretium cash-out has no order: once `paying`, its USDC has
              // left, and only a refund comes back, for the sweep to return.
              and(
                eq(payouts.provider, "pretium"),
                inArray(payouts.status, ["approved", "funding"]),
              ),
            ),
          ),
        )
        .limit(1),
    );
    return cashOut !== undefined;
  });
}

const sweepById = (organizationId: string, quoteId: string) =>
  withScope({ organizationId }, (tx) =>
    query(() =>
      tx.select().from(intentQuotes).where(eq(intentQuotes.id, quoteId)),
    ),
  ).pipe(
    Effect.flatMap(([quote]) =>
      quote ? Effect.succeed(quote) : Effect.dieMessage("sweep quote vanished"),
    ),
  );

/**
 * Moves a saved sweep as far as it can go now. The transit wallet's one
 * send is recorded as starting before Privy is asked, under a key Privy
 * replays rather than repeats:
 *
 * - the deadline too close, payouts paused, or the balance no longer there
 *   before the send: `expired`, nothing moved;
 * - Privy refuses: `failed`, nothing moved;
 * - Privy's answer is lost, or a run stopped between recording the start
 *   and saving the answer: `needs_review`, never sent again. 1Click's own
 *   report of the deposit still settles it if the send did go out;
 * - a sweep into a confidential account without the company's session
 *   (sign-in failed): returned unchanged, nothing started or told to
 *   1Click, and the next run tries again.
 */
export function advanceSweep(
  input: Pick<IntentQuote, "id" | "organizationId">,
): Effect.Effect<IntentQuote, DatabaseError, SweepDeps> {
  const { organizationId } = input;
  return Effect.gen(function* () {
    let quote = yield* sweepById(organizationId, input.id);
    const open =
      quote.status === "quoted" ||
      quote.status === "depositing" ||
      quote.status === "needs_review";
    let session: OneClickSession | undefined;
    if (open) {
      const signedIn = yield* sessionForQuote(quote).pipe(Effect.either);
      if (signedIn._tag === "Left") {
        if (signedIn.left._tag === "DatabaseError") {
          return yield* Effect.fail(signedIn.left);
        }
        console.warn(
          `[sweep] no session for quote ${quote.id}; left as it is`,
          signedIn.left.message,
        );
        return quote;
      }
      session = signedIn.right;
    }
    const reread = sweepById(organizationId, quote.id);
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
          "The quote's deadline came before the sweep could start. Nothing moved.",
        );
      }
      const { transitPrivyWalletId, paused } = yield* withScope(
        { organizationId },
        (tx) =>
          Effect.gen(function* () {
            const [wallet] = yield* query(() =>
              tx
                .select({ transitPrivyWalletId: wallets.transitPrivyWalletId })
                .from(wallets)
                .where(eq(wallets.id, quote.walletId)),
            );
            return {
              transitPrivyWalletId: wallet?.transitPrivyWalletId ?? null,
              paused: yield* isPaused(tx, organizationId),
            };
          }),
      );
      if (paused || transitPrivyWalletId === null) {
        return yield* expire(
          paused
            ? "Payouts were paused before the sweep. Nothing moved."
            : "The company has no transit wallet. Nothing moved.",
        );
      }
      const held = yield* baseUsdcBalance(quote.refundTo).pipe(Effect.either);
      if (held._tag === "Left") return quote;
      if (held.right < quote.amountIn) {
        return yield* expire(
          "The transit wallet no longer holds what the sweep was quoted for. Nothing moved.",
        );
      }

      const started = yield* moveQuote(quote, untouched, {
        status: "depositing",
        depositStartedAt: new Date(),
      });
      if (started === null) return yield* reread;
      quote = started;

      const privy = yield* PrivyWallets;
      const sent = yield* privy
        .sendUsdc({
          privyWalletId: transitPrivyWalletId,
          to: quote.depositAddress,
          amount: quote.amountIn,
          idempotencyKey: `sweep-${quote.id}`,
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
                failure: `The transit wallet refused the sweep${failure.policyViolation ? " (blocked by its policy)" : ""}. Nothing moved.`,
              }
            : {
                status: "needs_review",
                failure:
                  "The sweep's transfer may have been sent: its outcome is unknown. Check the transit wallet on Base before doing anything; never send again.",
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
          "The sweep's transfer was started and its outcome was never saved. Check the transit wallet on Base before doing anything; never send again.",
      });
      quote = yield* reread;
    }

    if (quote.status !== "depositing" && quote.status !== "needs_review") {
      return quote;
    }
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

/**
 * Sweeps one company's transit wallet if there is something to sweep and
 * nothing in flight. The quote is saved, under the company wallet's row
 * lock and after checking again that nothing is in flight, before anything
 * is sent; an unsettled sweep is itself something in flight, so a balance
 * is never swept twice. Returns the sweep it started, or null.
 */
export function sweepTransitWallet(input: {
  readonly organizationId: string;
}): Effect.Effect<IntentQuote | null, DatabaseError, SweepDeps> {
  const { organizationId } = input;
  return Effect.gen(function* () {
    const { wallet, busy } = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [company] = yield* query(() =>
          tx
            .select()
            .from(wallets)
            .where(eq(wallets.organizationId, organizationId))
            .limit(1),
        );
        return {
          wallet: company ?? null,
          busy: yield* somethingInFlight(tx, organizationId),
        };
      }),
    );
    if (
      busy ||
      wallet?.status !== "active" ||
      wallet.chain !== "near" ||
      wallet.address === null ||
      !isImplicitNearAccount(wallet.address) ||
      wallet.transitAddress === null ||
      !BASE_ADDRESS.test(wallet.transitAddress)
    ) {
      return null;
    }
    const { address, transitAddress } = wallet;

    const held = yield* baseUsdcBalance(transitAddress).pipe(Effect.either);
    if (held._tag === "Left" || held.right <= SWEEP_DUST_USDC) return null;
    // The transit wallet's Privy policy caps one transfer; a larger balance
    // goes back over several sweeps.
    const amount =
      held.right > wallet.perTransactionMaxUsdc
        ? wallet.perTransactionMaxUsdc
        : held.right;

    const intoConfidentialAccount =
      wallet.balanceHome === "confidential_account";
    let session: OneClickSession | undefined;
    if (intoConfidentialAccount) {
      if (wallet.privyWalletId === null) return null;
      const accounts = yield* ConfidentialAccounts;
      const signedIn = yield* accounts
        .session({ privyWalletId: wallet.privyWalletId, accountId: address })
        .pipe(Effect.either);
      if (signedIn._tag === "Left") {
        console.warn(
          `[sweep] no session to sweep ${organizationId}'s transit wallet`,
          signedIn.left.message,
        );
        return null;
      }
      session = signedIn.right;
    }

    const oneClick = yield* OneClick;
    const quoted = yield* oneClick
      .quote(
        {
          dry: false,
          swapType: "EXACT_INPUT",
          originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
          destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
          amount,
          recipient: address,
          ...(intoConfidentialAccount && {
            recipientType: "CONFIDENTIAL_INTENTS" as const,
          }),
          refundTo: transitAddress,
          deadline: new Date(Date.now() + COMPANY_QUOTE_TTL_MS),
          slippageBps: STABLECOIN_SLIPPAGE_BPS,
        },
        session,
      )
      .pipe(Effect.either);
    if (quoted._tag === "Left") {
      console.warn(
        `[sweep] no quote to sweep ${organizationId}'s transit wallet`,
        quoted.left.message,
      );
      return null;
    }
    const quote = quoted.right;
    if (
      quote.dry ||
      quote.depositMemo !== null ||
      !BASE_ADDRESS.test(quote.depositAddress) ||
      quote.depositAddress.toLowerCase() === transitAddress.toLowerCase() ||
      quote.amountIn !== amount ||
      quote.amountOut > quote.amountIn ||
      quote.amountIn - (quote.minAmountOut ?? quote.amountOut) >
        maxQuoteCost(quote.amountIn)
    ) {
      console.error(
        `[sweep] 1Click's quote to sweep ${organizationId}'s transit wallet failed our checks; nothing sent`,
      );
      return null;
    }

    const saved = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        yield* query(() =>
          tx
            .select({ id: wallets.id })
            .from(wallets)
            .where(eq(wallets.id, wallet.id))
            .for("update"),
        );
        if (yield* somethingInFlight(tx, organizationId)) return null;
        const [row] = yield* query(() =>
          tx
            .insert(intentQuotes)
            .values({
              organizationId,
              walletId: wallet.id,
              quoteKey: `sweep:${randomUUID()}`,
              purpose: "sweep",
              swapType: "EXACT_INPUT",
              originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
              destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
              amountIn: quote.amountIn,
              amountOut: quote.amountOut,
              minAmountOut: quote.minAmountOut,
              depositAddress: quote.depositAddress,
              ...(intoConfidentialAccount && {
                recipientType: "CONFIDENTIAL_INTENTS" as const,
              }),
              recipient: address,
              refundTo: transitAddress,
              deadline: quote.deadline,
              quoteResponse: quote.signedResponse,
            })
            .returning(),
        );
        return row ?? null;
      }),
    );
    if (saved === null) return null;
    return yield* advanceSweep(saved);
  });
}

interface WalletRef extends Record<string, unknown> {
  readonly organization_id: string;
}

export interface SweepSummary {
  readonly checked: number;
  readonly swept: number;
  readonly errors: number;
}

/**
 * The sweep job: looks at every company wallet on the main chain, each on
 * its own, so one company's failure never stops the rest.
 */
export function sweepTransitWallets(): Effect.Effect<
  SweepSummary,
  DatabaseError,
  SweepDeps
> {
  return Effect.gen(function* () {
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<WalletRef>(
          sql`SELECT organization_id FROM active_main_chain_wallets()`,
        ),
      ),
    );
    let swept = 0;
    let errors = 0;
    for (const ref of rows) {
      const exit = yield* Effect.exit(
        sweepTransitWallet({ organizationId: ref.organization_id }),
      );
      if (Exit.isSuccess(exit)) {
        if (exit.value !== null) swept += 1;
      } else {
        errors += 1;
        console.error(
          `[sweep] sweeping ${ref.organization_id}'s transit wallet broke`,
          Cause.pretty(exit.cause),
        );
      }
    }
    return { checked: rows.length, swept, errors };
  });
}
