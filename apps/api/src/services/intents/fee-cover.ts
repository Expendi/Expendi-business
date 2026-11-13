import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote, Wallet } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  intentQuotes,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { NearRelayer } from "../chain/near-relayer.js";
import { NearRpc } from "../chain/near-rpc.js";
import { isImplicitNearAccount } from "../chain/near.js";
import { sessionForQuote } from "./company-session.js";
import {
  ConfidentialAccounts,
  MOVE_IN_MIN_USDC,
} from "./confidential-account.js";
import { recordedExpendiSurplus } from "./expendi-surplus.js";
import { ONE_CLICK_USDC_ASSET_IDS, OneClick } from "./one-click.js";
import {
  DEPOSIT_MARGIN_MS,
  moveQuote,
  orCurrent,
  quoteById,
  settleFromOneClick,
} from "./quote-settle.js";

/**
 * Fee cover for a company that keeps its USDC in a confidential account
 * (docs/work/confidential-accounts/phase-3-4-design.md, B2). A Base hop or a
 * USDC payout to another chain costs more than it delivers, and Expendi, not
 * the company, absorbs that. A confidential account can't be sent to on
 * chain, so Expendi keeps a small float of its own USDC inside the account:
 * the recorded surplus of the `confidential_account` pool
 * (`recordedExpendiSurplus`). The company's own money is the ledger.
 *
 * The float is filled by a `fee_cover` quote: the gas relayer pays a 1Click
 * deposit address with USDC on NEAR, and 1Click delivers it into the
 * company's confidential account for nothing, refunding to the relayer. It
 * is not a ledger entry. The relayer's transaction hash is saved on the row
 * before it is broadcast and is sent again only once the chain shows it
 * failed, so a top-up is never paid twice.
 */

/** What a top-up brings the float to. */
export const FEE_FLOAT_TARGET_USDC = 1_000_000n;

/** The float below which the job tops it up, whether or not a hop waits for it. */
export const FEE_FLOAT_LOW_USDC = 250_000n;

/**
 * After a top-up ends refunded or failed, a new one waits this long, so a
 * route that keeps refusing doesn't spin.
 */
export const FEE_COVER_RETRY_AFTER_MS = 2 * 60_000;

/** How long a top-up's quote stays open for the relayer's deposit. */
const FEE_COVER_QUOTE_TTL_MS = 10 * 60_000;

const NEAR_USDC = ONE_CLICK_USDC_ASSET_IDS.near;

export type FeeCoverDeps =
  DatabaseService | OneClick | ConfidentialAccounts | NearRelayer | NearRpc;

const largest = (first: bigint, ...rest: readonly bigint[]): bigint =>
  rest.reduce((most, next) => (next > most ? next : most), first);

/** The company wallet's row, if the company's balance lives in a confidential account. */
function confidentialWallet(wallet: Wallet | undefined) {
  if (
    wallet?.status !== "active" ||
    wallet.chain !== "near" ||
    wallet.balanceHome !== "confidential_account" ||
    wallet.address === null ||
    wallet.privyWalletId === null ||
    !isImplicitNearAccount(wallet.address)
  ) {
    return null;
  }
  return {
    id: wallet.id,
    address: wallet.address,
    privyWalletId: wallet.privyWalletId,
  };
}

/** What Expendi's float in the company's confidential account comes to on the records. */
const floatOf = (
  tx: Transaction,
  walletId: string,
  excludeQuoteId?: string,
): Effect.Effect<bigint, DatabaseError> =>
  recordedExpendiSurplus(tx, walletId, excludeQuoteId, "confidential_account");

/**
 * Whether a top-up may start for the company now: none is unsettled (one in
 * `needs_review` counts, and blocks until a person settles it), and none
 * ended refunded or failed within `FEE_COVER_RETRY_AFTER_MS`.
 */
function mayStart(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<boolean, DatabaseError> {
  return query(() =>
    tx
      .select({ id: intentQuotes.id })
      .from(intentQuotes)
      .where(
        and(
          eq(intentQuotes.organizationId, organizationId),
          eq(intentQuotes.purpose, "fee_cover"),
          or(
            inArray(intentQuotes.status, [...UNSETTLED_INTENT_QUOTE_STATUSES]),
            and(
              inArray(intentQuotes.status, ["refunded", "failed"]),
              gt(
                intentQuotes.settledAt,
                new Date(Date.now() - FEE_COVER_RETRY_AFTER_MS),
              ),
            ),
          ),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows.length === 0));
}

/**
 * Whether the float covers what `quote` costs beyond what it delivers:
 * `covered`, or `waiting` until it does. When it doesn't, a top-up is
 * started for at least what is missing (saved only; the fee cover job pays
 * it), so the quote waits for a top-up and not for nothing. If none can
 * start, it waits and expires at its deadline with nothing moved.
 *
 * A quote that costs nothing (a payout to NEAR delivers what it takes in) is
 * always covered, even when sweep costs have taken the float below zero.
 * The quote itself is left out of the float, so it never counts against
 * itself, while every other quote in flight counts its whole difference:
 * two quotes in flight can't spend the same float.
 */
export function ensureFeeCover(
  quote: IntentQuote,
): Effect.Effect<"covered" | "waiting", DatabaseError, FeeCoverDeps> {
  return Effect.gen(function* () {
    const needed = quote.amountIn - quote.amountOut;
    if (needed <= 0n) return "covered";
    const float = yield* withScope(
      { organizationId: quote.organizationId },
      (tx) => floatOf(tx, quote.walletId, quote.id),
    );
    if (float >= needed) return "covered";
    yield* startFeeCover({
      organizationId: quote.organizationId,
      atLeast: needed - float,
    });
    return "waiting";
  });
}

/**
 * Starts a top-up of the company's float if its balance belongs in a
 * confidential account and none is unsettled: a free USDC-to-USDC delivery
 * into the account, refunding to the relayer, for the largest of `atLeast`,
 * what brings the float to its target and a move-in's minimum. Saved under
 * the company wallet's row lock after checking again that none may not
 * start, before anything is sent. Returns the quote it saved, not yet paid,
 * or null: for a company whose balance is in its company wallet (never read,
 * never signed in), for anything that stops one, for a relayer holding less
 * than the amount, and for a quote 1Click refused or that failed our checks.
 */
export function startFeeCover(input: {
  readonly organizationId: string;
  readonly atLeast: bigint;
}): Effect.Effect<IntentQuote | null, DatabaseError, FeeCoverDeps> {
  const { organizationId } = input;
  return Effect.gen(function* () {
    const ready = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          tx
            .select()
            .from(wallets)
            .where(eq(wallets.organizationId, organizationId))
            .limit(1),
        );
        const wallet = confidentialWallet(row);
        if (wallet === null) return null;
        if (!(yield* mayStart(tx, organizationId))) return null;
        return { wallet, float: yield* floatOf(tx, wallet.id) };
      }),
    );
    if (ready === null) return null;
    const { wallet, float } = ready;
    const { address } = wallet;
    const amount = largest(
      input.atLeast,
      FEE_FLOAT_TARGET_USDC - float,
      MOVE_IN_MIN_USDC,
    );

    const relayer = yield* NearRelayer;
    const rpc = yield* NearRpc;
    const relayerHolds = yield* rpc
      .usdcBalance(relayer.accountId)
      .pipe(Effect.either);
    if (relayerHolds._tag === "Left") {
      console.warn(
        `[fee-cover] the gas relayer's USDC balance is unreadable; nothing topped up for ${organizationId}`,
        relayerHolds.left.message,
      );
      return null;
    }
    if (relayerHolds.right < amount) {
      console.warn(
        `[fee-cover] the gas relayer holds less USDC than the ${amount} units ${organizationId}'s float needs; nothing topped up`,
      );
      return null;
    }

    const accounts = yield* ConfidentialAccounts;
    const session = yield* accounts
      .session({ privyWalletId: wallet.privyWalletId, accountId: address })
      .pipe(Effect.either);
    if (session._tag === "Left") {
      console.warn(
        `[fee-cover] couldn't sign ${organizationId} in to 1Click; nothing topped up`,
        session.left.message,
      );
      return null;
    }

    const oneClick = yield* OneClick;
    const quoted = yield* oneClick
      .quote(
        {
          dry: false,
          swapType: "EXACT_INPUT",
          originAsset: NEAR_USDC,
          destinationAsset: NEAR_USDC,
          amount,
          depositType: "ORIGIN_CHAIN",
          recipient: address,
          recipientType: "CONFIDENTIAL_INTENTS",
          refundTo: relayer.accountId,
          refundType: "ORIGIN_CHAIN",
          deadline: new Date(Date.now() + FEE_COVER_QUOTE_TTL_MS),
          slippageBps: 0,
        },
        session.right,
      )
      .pipe(Effect.either);
    if (quoted._tag === "Left") {
      console.warn(
        `[fee-cover] no quote to top up ${organizationId}'s float`,
        quoted.left.message,
      );
      return null;
    }
    const quote = quoted.right;
    if (
      quote.dry ||
      quote.depositMemo !== null ||
      !isImplicitNearAccount(quote.depositAddress) ||
      quote.depositAddress === address ||
      quote.depositAddress === relayer.accountId ||
      quote.amountIn !== amount ||
      quote.amountOut !== quote.amountIn
    ) {
      console.error(
        `[fee-cover] 1Click's quote to top up ${organizationId}'s float failed our checks; nothing sent`,
      );
      return null;
    }

    return yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        yield* query(() =>
          tx
            .select({ id: wallets.id })
            .from(wallets)
            .where(eq(wallets.id, wallet.id))
            .for("update"),
        );
        if (!(yield* mayStart(tx, organizationId))) return null;
        const [row] = yield* query(() =>
          tx
            .insert(intentQuotes)
            .values({
              organizationId,
              walletId: wallet.id,
              quoteKey: `fee-cover:${randomUUID()}`,
              purpose: "fee_cover",
              swapType: "EXACT_INPUT",
              originAsset: NEAR_USDC,
              destinationAsset: NEAR_USDC,
              amountIn: quote.amountIn,
              amountOut: quote.amountOut,
              minAmountOut: quote.minAmountOut,
              depositAddress: quote.depositAddress,
              depositType: "ORIGIN_CHAIN",
              recipient: address,
              recipientType: "CONFIDENTIAL_INTENTS",
              refundTo: relayer.accountId,
              refundType: "ORIGIN_CHAIN",
              deadline: quote.deadline,
              quoteResponse: quote.signedResponse,
            })
            .returning(),
        );
        if (!row) {
          return yield* Effect.dieMessage("fee cover insert returned no row");
        }
        return row;
      }),
    );
  });
}

/** Whether the company's balance still belongs in a confidential account. */
const stillConfidential = (
  quote: IntentQuote,
): Effect.Effect<boolean, DatabaseError, DatabaseService> =>
  withScope({ organizationId: quote.organizationId }, (tx) =>
    query(() =>
      tx
        .select({ balanceHome: wallets.balanceHome })
        .from(wallets)
        .where(eq(wallets.id, quote.walletId)),
    ),
  ).pipe(
    Effect.map(([wallet]) => wallet?.balanceHome === "confidential_account"),
  );

/**
 * Moves a saved top-up as far as it can go now and returns it as it then
 * stands. Safe to call at any time, any number of times: each call reads
 * the row and does only the next step that hasn't been done.
 *
 * - the deadline too close, or the balance no longer in the account, before
 *   anything was sent: `expired`, nothing moved;
 * - the relayer can't register the deposit address or send: unchanged, the
 *   next call tries again;
 * - the relayer's hash saved and the chain not showing it yet: waits, and
 *   is sent again only when the chain shows it failed;
 * - the deadline too close with no hash saved: `failed`, nothing moved;
 * - 1Click `SUCCESS`: `succeeded`, and the float holds the delivery;
 * - 1Click `REFUNDED`: `refunded`, back with the relayer, never credited to
 *   the company;
 * - 1Click `FAILED`, or silence long past the deadline: `needs_review`.
 *
 * When the company can't be signed in, the quote is returned unchanged:
 * 1Click tells us nothing about a delivery into a confidential account
 * without its session.
 */
export function advanceFeeCover(
  ref: Pick<IntentQuote, "id" | "organizationId">,
): Effect.Effect<IntentQuote, DatabaseError, FeeCoverDeps> {
  return Effect.gen(function* () {
    let quote = yield* quoteById(ref.organizationId, ref.id);
    if (
      quote.purpose !== "fee_cover" ||
      !UNSETTLED_INTENT_QUOTE_STATUSES.some((status) => status === quote.status)
    ) {
      return quote;
    }
    const session = yield* sessionForQuote(quote).pipe(Effect.either);
    if (session._tag === "Left") {
      console.warn(
        `[fee-cover] couldn't sign in to settle fee cover ${quote.id}; left as it is`,
        session.left.message,
      );
      return quote;
    }
    const relayer = yield* NearRelayer;
    const rpc = yield* NearRpc;
    const untouched = and(
      eq(intentQuotes.status, "quoted"),
      isNull(intentQuotes.depositStartedAt),
    );
    const unpaid = and(
      eq(intentQuotes.status, "depositing"),
      isNull(intentQuotes.depositTxHash),
    );
    const current = () => quoteById(quote.organizationId, quote.id);

    if (quote.status === "quoted") {
      const expire = (failure: string) =>
        moveQuote(quote, untouched, {
          status: "expired",
          settledAt: new Date(),
          failure,
        }).pipe(Effect.flatMap((moved) => orCurrent(quote, moved)));
      if (quote.deadline.getTime() - Date.now() < DEPOSIT_MARGIN_MS) {
        return yield* expire(
          "The quote's deadline came before the top-up could start. Nothing moved.",
        );
      }
      if (!(yield* stillConfidential(quote))) {
        return yield* expire(
          "The company's balance no longer belongs in a confidential account. Nothing moved.",
        );
      }
      const registered = yield* relayer
        .registerUsdcAccount({
          accountId: quote.depositAddress,
          beforeBroadcast: (txHash) =>
            moveQuote(quote, untouched, {
              depositRegistrationTxHash: txHash,
            }).pipe(Effect.asVoid),
        })
        .pipe(Effect.either);
      if (registered._tag === "Left") {
        console.warn(
          `[fee-cover] the deposit address of fee cover ${quote.id} isn't registered with USDC yet`,
          registered.left.message,
        );
        return yield* current();
      }
      const started = yield* moveQuote(quote, untouched, {
        status: "depositing",
        depositStartedAt: new Date(),
      });
      if (started === null) return yield* current();
      quote = started;
    }

    const send = (): Effect.Effect<IntentQuote, DatabaseError, FeeCoverDeps> =>
      Effect.gen(function* () {
        if (quote.deadline.getTime() - Date.now() < DEPOSIT_MARGIN_MS) {
          return yield* moveQuote(quote, unpaid, {
            status: "failed",
            settledAt: new Date(),
            failure:
              "The relayer never sent the top-up before the quote's deadline. Nothing moved.",
          }).pipe(Effect.flatMap((moved) => orCurrent(quote, moved)));
        }
        const sent = yield* relayer
          .sendUsdc({
            to: quote.depositAddress,
            amount: quote.amountIn,
            beforeBroadcast: (txHash) =>
              moveQuote(quote, unpaid, { depositTxHash: txHash }).pipe(
                Effect.flatMap((saved) =>
                  saved
                    ? Effect.void
                    : Effect.dieMessage(
                        `fee cover ${quote.id} moved while its transfer was being sent`,
                      ),
                ),
              ),
          })
          .pipe(Effect.either);
        if (sent._tag === "Left") {
          console.warn(
            `[fee-cover] the transfer for fee cover ${quote.id} wasn't sent`,
            sent.left.message,
          );
          return yield* current();
        }
        yield* relayer
          .awaitOutcome(sent.right.txHash)
          .pipe(Effect.orElseSucceed(() => null));
        return yield* current();
      });

    if (quote.status === "depositing" && quote.depositTxHash === null) {
      quote = yield* send();
      if (quote.depositTxHash === null) return quote;
    }

    const sentHash = quote.depositTxHash;
    if (
      quote.status === "depositing" &&
      sentHash !== null &&
      quote.depositSubmittedAt === null
    ) {
      const outcome = yield* rpc
        .transactionOutcome(sentHash, relayer.accountId)
        .pipe(Effect.orElseSucceed(() => null));
      if (outcome !== null && !outcome.succeeded) {
        const cleared = yield* moveQuote(
          quote,
          and(
            eq(intentQuotes.status, "depositing"),
            eq(intentQuotes.depositTxHash, sentHash),
            isNull(intentQuotes.depositSubmittedAt),
          ),
          { depositTxHash: null },
        );
        if (cleared === null) return yield* current();
        quote = cleared;
        quote = yield* send();
        if (quote.depositTxHash === null) return quote;
      } else if (outcome?.succeeded === true) {
        const oneClick = yield* OneClick;
        const told = yield* oneClick
          .submitDeposit(quote.depositAddress, sentHash, session.right)
          .pipe(Effect.either);
        if (told._tag === "Right") {
          quote = yield* orCurrent(
            quote,
            yield* moveQuote(quote, isNull(intentQuotes.depositSubmittedAt), {
              depositSubmittedAt: new Date(),
            }),
          );
        }
      }
    }

    return yield* settleFromOneClick(quote, session.right);
  });
}

interface QuoteRef extends Record<string, unknown> {
  readonly quote_id: string;
  readonly organization_id: string;
}

interface WalletRef extends Record<string, unknown> {
  readonly wallet_id: string;
  readonly organization_id: string;
}

export interface FeeCoverSummary {
  /** Open top-ups moved on in this run. */
  readonly advanced: number;
  readonly started: number;
  readonly errors: number;
}

/**
 * The fee cover job: moves on every open top-up, then starts one, and moves
 * it on, for each company whose balance belongs in a confidential account
 * and whose float has fallen under `FEE_FLOAT_LOW_USDC`. Each quote and each
 * company is handled on its own, so one failure never stops the rest. Other
 * companies are never read.
 */
export function coverFees(
  maxRows = 50,
): Effect.Effect<FeeCoverSummary, DatabaseError, FeeCoverDeps> {
  return Effect.gen(function* () {
    let advanced = 0;
    let started = 0;
    let errors = 0;
    const isolated = <A>(
      what: string,
      work: Effect.Effect<A, DatabaseError, FeeCoverDeps>,
    ) =>
      Effect.exit(work).pipe(
        Effect.map((exit) => {
          if (Exit.isSuccess(exit)) return exit.value;
          errors += 1;
          console.error(`[fee-cover] ${what} broke`, Cause.pretty(exit.cause));
          return null;
        }),
      );

    const { rows: open } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<QuoteRef>(
          sql`SELECT quote_id, organization_id FROM intent_quotes_to_refresh(ARRAY['fee_cover'], ${maxRows})`,
        ),
      ),
    );
    for (const ref of open) {
      const moved = yield* isolated(
        `fee cover ${ref.quote_id}`,
        advanceFeeCover({
          id: ref.quote_id,
          organizationId: ref.organization_id,
        }),
      );
      if (moved !== null) advanced += 1;
    }

    const { rows: companies } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<WalletRef>(
          sql`SELECT wallet_id, organization_id FROM confidential_account_wallets()`,
        ),
      ),
    );
    for (const company of companies) {
      const organizationId = company.organization_id;
      const begun = yield* isolated(
        `topping up ${organizationId}'s float`,
        Effect.gen(function* () {
          const float = yield* withScope({ organizationId }, (tx) =>
            floatOf(tx, company.wallet_id),
          );
          if (float >= FEE_FLOAT_LOW_USDC) return null;
          const quote = yield* startFeeCover({ organizationId, atLeast: 0n });
          return quote === null ? null : yield* advanceFeeCover(quote);
        }),
      );
      if (begun !== null) started += 1;
    }
    return { advanced, started, errors };
  });
}
