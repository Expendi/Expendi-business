import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { IntentQuote } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { CompanyWalletSendInput } from "../wallet/company-wallet-send.js";
import type { ConfidentialAccounts } from "./confidential-account.js";
import type { QuoteDepositDeps } from "./quote-deposit.js";
import {
  intentQuotes,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { NearRpc } from "../chain/near-rpc.js";
import { isImplicitNearAccount } from "../chain/near.js";
import { isPaused } from "../payout/guards.js";
import { sendIntentsTokenFromCompanyWallet } from "../wallet/company-wallet-send.js";
import { sessionForQuote } from "./company-session.js";
import { FUND_IN_SLIPPAGE_BPS, quoteDelivery } from "./fund-in.js";
import {
  ONE_CLICK_FUND_IN_USDC_ASSET_IDS,
  ONE_CLICK_USDC_ASSET_IDS,
  OneClick,
} from "./one-click.js";
import {
  COMPANY_QUOTE_TTL_MS,
  continueCompanyDeposit,
  DEPOSIT_MARGIN_MS,
  maxQuoteCost,
} from "./quote-deposit.js";
import { moveQuote, orCurrent, quoteById } from "./quote-settle.js";

/**
 * Fund-in returns (CONTEXT.md): a fund-in 1Click can't complete is refunded
 * into the company's own NEAR Intents account, as the USDC token of the
 * chain it came from (docs/decisions/near-main-chain.md, "Fund-in"). This
 * swaps that balance back to USDC on NEAR through an `EXACT_INPUT` quote
 * paid from inside NEAR Intents, which delivers to the company wallet.
 *
 * The company wallet signs the one transfer, inside NEAR Intents, to the
 * quote's deposit account; nothing else of the company's moves. The
 * delivery is a deposit: that money never reached the company wallet
 * before, so the deposit watcher credits it, once, when it arrives. For a
 * company that keeps its USDC in a confidential account the delivery goes
 * there instead and `quote-credit.ts` credits it when 1Click reports
 * `SUCCESS`.
 *
 * The balance is read rather than worked out from the fund-ins, so
 * whatever reaches the account is returned, however it got there: a
 * refunded fund-in, the excess of one that was overpaid, a deposit made
 * after its deadline, or a return that was itself refunded.
 */

const ACTOR: AuditActor = { type: "system", id: "fund-in-return" };

/** The NEAR Intents tokens a fund-in can be refunded as. */
export const FUND_IN_RETURN_ASSETS: readonly string[] = Object.values(
  ONE_CLICK_FUND_IN_USDC_ASSET_IDS,
);

/**
 * After a return of an asset ends refunded or failed, a new one for it
 * waits this long, so a route that keeps refusing doesn't spin.
 */
export const RETURN_RETRY_AFTER_MS = 30 * 60_000;

export type FundInReturnDeps =
  QuoteDepositDeps | NearRpc | AuditLog | ConfidentialAccounts;

const sendFromIntents =
  (quote: IntentQuote) => (input: CompanyWalletSendInput) =>
    sendIntentsTokenFromCompanyWallet({ ...input, tokenId: quote.originAsset });

/**
 * Moves a saved return as far as it can go now, as `advanceCompanyQuote`
 * does for a Base hop: nothing to register and no fee to cover, since the
 * deposit is a transfer inside NEAR Intents.
 *
 * - the deadline too close, or payouts paused, before the deposit starts:
 *   `expired`, nothing moved;
 * - the company wallet refuses the send: `failed`, nothing moved;
 * - its outcome unknown: followed up under the same send key, which never
 *   sends twice, and `needs_review` if still unknown after the deadline;
 * - 1Click `REFUNDED`: the balance is back in the company's NEAR Intents
 *   account, and a later run returns it again.
 *
 * A return that delivers to a confidential account is only started, paid or
 * followed up with the company's session. If it can't be signed in, the
 * return is left as it is: a deposit must not start for a quote that can't
 * then be settled.
 */
export function advanceFundInReturn(
  input: Pick<IntentQuote, "id" | "organizationId">,
): Effect.Effect<IntentQuote, DatabaseError, FundInReturnDeps> {
  return Effect.gen(function* () {
    let quote = yield* quoteById(input.organizationId, input.id);
    if (quote.purpose !== "fund_in_return") return quote;

    const signedIn = yield* sessionForQuote(quote).pipe(Effect.either);
    if (signedIn._tag === "Left") {
      console.warn(
        `[fund-in-return] return ${quote.id} left as it is: no session`,
        signedIn.left.message,
      );
      return quote;
    }
    const session = signedIn.right;

    if (quote.status === "quoted") {
      const untouched = and(
        eq(intentQuotes.status, "quoted"),
        isNull(intentQuotes.depositStartedAt),
      );
      const expire = (failure: string) =>
        moveQuote(quote, untouched, {
          status: "expired",
          settledAt: new Date(),
          failure,
        }).pipe(Effect.flatMap((moved) => orCurrent(quote, moved)));

      if (quote.deadline.getTime() - Date.now() < DEPOSIT_MARGIN_MS) {
        return yield* expire(
          "The quote's deadline came before the return could start. Nothing moved.",
        );
      }
      const paused = yield* withScope(
        { organizationId: quote.organizationId },
        (tx) => isPaused(tx, quote.organizationId),
      );
      if (paused) {
        return yield* expire(
          "Payouts were paused before the return. Nothing moved.",
        );
      }
      const started = yield* moveQuote(quote, untouched, {
        status: "depositing",
        depositStartedAt: new Date(),
      });
      if (started === null) {
        return yield* quoteById(quote.organizationId, quote.id);
      }
      quote = started;
    }
    return yield* continueCompanyDeposit(
      quote,
      sendFromIntents(quote),
      session,
    );
  });
}

/** Whether a return of the company's is still open; one runs at a time. */
function returnInFlight(
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
          eq(intentQuotes.purpose, "fund_in_return"),
          inArray(intentQuotes.status, [...UNSETTLED_INTENT_QUOTE_STATUSES]),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows.length > 0));
}

/** Assets whose last return ended refunded or failed too recently to retry. */
function resting(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<ReadonlySet<string>, DatabaseError> {
  return query(() =>
    tx
      .select({ asset: intentQuotes.originAsset })
      .from(intentQuotes)
      .where(
        and(
          eq(intentQuotes.organizationId, organizationId),
          eq(intentQuotes.purpose, "fund_in_return"),
          inArray(intentQuotes.status, ["refunded", "failed"]),
          gt(
            intentQuotes.settledAt,
            new Date(Date.now() - RETURN_RETRY_AFTER_MS),
          ),
        ),
      ),
  ).pipe(Effect.map((rows) => new Set(rows.map(({ asset }) => asset))));
}

/**
 * Starts returning the first of the company's NEAR Intents balances that
 * can be returned, if no return of its is open. The quote is saved under
 * the company wallet's row lock after checking again that none is, and
 * links the refunded fund-ins of that asset to it, before anything is
 * sent. A balance over the wallet's per-transaction maximum goes back over
 * several returns. Returns the return it started, or null.
 */
export function startFundInReturn(input: {
  readonly organizationId: string;
}): Effect.Effect<IntentQuote | null, DatabaseError, FundInReturnDeps> {
  const { organizationId } = input;
  return Effect.gen(function* () {
    const { wallet, busy, waiting } = yield* withScope(
      { organizationId },
      (tx) =>
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
            busy: yield* returnInFlight(tx, organizationId),
            waiting: yield* resting(tx, organizationId),
          };
        }),
    );
    if (
      busy ||
      wallet?.status !== "active" ||
      wallet.chain !== "near" ||
      wallet.address === null ||
      !isImplicitNearAccount(wallet.address)
    ) {
      return null;
    }
    const { address } = wallet;

    const rpc = yield* NearRpc;
    const balances = yield* rpc
      .intentsBalances(address, FUND_IN_RETURN_ASSETS)
      .pipe(Effect.either);
    if (balances._tag === "Left") {
      console.warn(
        `[fund-in-return] ${organizationId}'s NEAR Intents balances unreadable`,
        balances.left.message,
      );
      return null;
    }
    const index = FUND_IN_RETURN_ASSETS.findIndex(
      (asset, i) => (balances.right[i] ?? 0n) > 0n && !waiting.has(asset),
    );
    const asset = FUND_IN_RETURN_ASSETS[index];
    const held = balances.right[index];
    if (asset === undefined || held === undefined) return null;
    const amount =
      held > wallet.perTransactionMaxUsdc ? wallet.perTransactionMaxUsdc : held;

    const delivery = yield* quoteDelivery(wallet).pipe(Effect.either);
    if (delivery._tag === "Left") {
      console.warn(
        `[fund-in-return] no session to return ${organizationId}'s ${asset} with`,
        delivery.left.message,
      );
      return null;
    }
    const oneClick = yield* OneClick;
    const quoted = yield* oneClick
      .quote(
        {
          dry: false,
          swapType: "EXACT_INPUT",
          originAsset: asset,
          depositType: "INTENTS",
          destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
          amount,
          recipient: address,
          ...delivery.right.deliverTo,
          refundTo: address,
          refundType: "INTENTS",
          deadline: new Date(Date.now() + COMPANY_QUOTE_TTL_MS),
          slippageBps: FUND_IN_SLIPPAGE_BPS,
        },
        delivery.right.session,
      )
      .pipe(Effect.either);
    if (quoted._tag === "Left") {
      console.warn(
        `[fund-in-return] no quote to return ${organizationId}'s ${asset}`,
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
      quote.amountIn !== amount ||
      quote.amountOut > quote.amountIn ||
      quote.amountIn - (quote.minAmountOut ?? quote.amountOut) >
        maxQuoteCost(quote.amountIn)
    ) {
      console.error(
        `[fund-in-return] 1Click's quote to return ${organizationId}'s ${asset} failed our checks; nothing sent`,
      );
      return null;
    }

    const saved = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* query(() =>
          tx
            .select({ id: wallets.id })
            .from(wallets)
            .where(eq(wallets.id, wallet.id))
            .for("update"),
        );
        if (yield* returnInFlight(tx, organizationId)) return null;
        const [row] = yield* query(() =>
          tx
            .insert(intentQuotes)
            .values({
              organizationId,
              walletId: wallet.id,
              quoteKey: `fund-in-return:${randomUUID()}`,
              purpose: "fund_in_return",
              swapType: "EXACT_INPUT",
              originAsset: asset,
              destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
              amountIn: quote.amountIn,
              amountOut: quote.amountOut,
              minAmountOut: quote.minAmountOut,
              depositAddress: quote.depositAddress,
              depositType: "INTENTS",
              recipient: address,
              ...delivery.right.deliverTo,
              refundTo: address,
              refundType: "INTENTS",
              deadline: quote.deadline,
              quoteResponse: quote.signedResponse,
            })
            .returning(),
        );
        if (!row) {
          return yield* Effect.dieMessage(
            "fund-in return insert returned no row",
          );
        }
        const undelivered = tx
          .select({ id: intentQuotes.id })
          .from(intentQuotes)
          .where(
            and(
              eq(intentQuotes.organizationId, organizationId),
              eq(intentQuotes.purpose, "fund_in_return"),
              inArray(intentQuotes.status, ["refunded", "failed", "expired"]),
            ),
          );
        const linked = yield* query(() =>
          tx
            .update(intentQuotes)
            .set({ returnQuoteId: row.id })
            .where(
              and(
                eq(intentQuotes.organizationId, organizationId),
                eq(intentQuotes.purpose, "fund_in"),
                eq(intentQuotes.status, "refunded"),
                eq(intentQuotes.refundType, "INTENTS"),
                eq(intentQuotes.originAsset, asset),
                or(
                  isNull(intentQuotes.returnQuoteId),
                  inArray(intentQuotes.returnQuoteId, undelivered),
                ),
              ),
            )
            .returning({ id: intentQuotes.id }),
        );
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId,
          action: "fund_in_return.created",
          entity: { type: "intent_quote", id: row.id },
          after: {
            originAsset: asset,
            amountIn: row.amountIn,
            amountOut: row.amountOut,
            depositAddress: row.depositAddress,
            deadline: row.deadline.toISOString(),
            fundInIds: linked.map(({ id }) => id),
          },
        });
        return row;
      }),
    );
    if (saved === null) return null;
    return yield* advanceFundInReturn(saved);
  });
}

interface QuoteRef extends Record<string, unknown> {
  readonly quote_id: string;
  readonly organization_id: string;
}

interface WalletRef extends Record<string, unknown> {
  readonly organization_id: string;
}

export interface FundInReturnSummary {
  /** Open returns moved on in this run. */
  readonly advanced: number;
  readonly started: number;
  readonly errors: number;
}

/**
 * The fund-in return job: moves on every open return, then starts one for
 * each company with a balance waiting in NEAR Intents. Each quote and each
 * company is handled on its own, so one failure never stops the rest.
 */
export function returnFundIns(
  maxRows = 50,
): Effect.Effect<FundInReturnSummary, DatabaseError, FundInReturnDeps> {
  return Effect.gen(function* () {
    let advanced = 0;
    let started = 0;
    let errors = 0;
    const isolated = <A>(
      what: string,
      work: Effect.Effect<A, DatabaseError, FundInReturnDeps>,
    ) =>
      Effect.exit(work).pipe(
        Effect.map((exit) => {
          if (Exit.isSuccess(exit)) return exit.value;
          errors += 1;
          console.error(
            `[fund-in-return] ${what} broke`,
            Cause.pretty(exit.cause),
          );
          return null;
        }),
      );

    const { rows: open } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<QuoteRef>(
          sql`SELECT quote_id, organization_id FROM intent_quotes_to_refresh(ARRAY['fund_in_return'], ${maxRows})`,
        ),
      ),
    );
    for (const ref of open) {
      const moved = yield* isolated(
        `return ${ref.quote_id}`,
        advanceFundInReturn({
          id: ref.quote_id,
          organizationId: ref.organization_id,
        }),
      );
      if (moved !== null) advanced += 1;
    }

    const { rows: companies } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<WalletRef>(
          sql`SELECT organization_id FROM active_main_chain_wallets()`,
        ),
      ),
    );
    for (const { organization_id: organizationId } of companies) {
      const begun = yield* isolated(
        `returning ${organizationId}'s NEAR Intents balance`,
        startFundInReturn({ organizationId }),
      );
      if (begun !== null) started += 1;
    }
    return { advanced, started, errors };
  });
}
