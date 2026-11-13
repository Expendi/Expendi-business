import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote, Wallet } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { DepositGate, QuoteDepositDeps } from "./quote-deposit.js";
import {
  companyWalletSends,
  intentQuotes,
  payouts,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { NearRpc } from "../chain/near-rpc.js";
import { isImplicitNearAccount } from "../chain/near.js";
import { isPaused } from "../payout/guards.js";
import { sessionForQuote } from "./company-session.js";
import {
  ConfidentialAccounts,
  MOVE_IN_MIN_USDC,
} from "./confidential-account.js";
import { ONE_CLICK_USDC_ASSET_IDS, OneClick } from "./one-click.js";
import {
  advanceCompanyQuote,
  COMPANY_QUOTE_TTL_MS,
  recordedExpendiSurplus,
} from "./quote-deposit.js";
import { quoteById } from "./quote-settle.js";

/**
 * Move-ins (CONTEXT.md): USDC that sits in a company wallet of a company
 * whose balance lives in a confidential account is moved into that account
 * (docs/decisions/confidential-accounts.md). A move-in is a 1Click
 * `EXACT_INPUT` quote from USDC on NEAR to USDC on NEAR, delivered to the
 * company's own confidential account, and paid like a Base hop: the gas
 * relayer registers the deposit address with USDC, then the company wallet
 * sends the amount with a plain `ft_transfer`.
 *
 * A move-in is not a ledger entry. The money stays the company's, moving
 * between its own two places, so nothing is written to `wallet_transactions`
 * and the quote must be free: a charge would leave the confidential balance
 * permanently below the ledger.
 *
 * Turning the feature on for a company is this job run over its whole
 * balance. Companies that keep their balance in the company wallet are never
 * quoted or read.
 */

const ACTOR = { type: "system", id: "move-in" } as const;

/**
 * After a move-in ends refunded or failed, a new one waits this long, so a
 * route that keeps refusing doesn't spin.
 */
export const MOVE_IN_RETRY_AFTER_MS = 30 * 60_000;

export type MoveInDeps =
  QuoteDepositDeps | NearRpc | ConfidentialAccounts | AuditLog;

/**
 * Quote purposes whose funds or fee cover are waiting in the company wallet.
 * Only when paid by a transfer from it: a quote paid out of the confidential
 * account keeps nothing in the company wallet.
 */
const COMPANY_WALLET_QUOTE_PURPOSES = [
  "base_hop",
  "usdc_payout",
  "to_treasury",
] as const;

/** The company wallet of a company that keeps its balance in a confidential account. */
interface MoveInWallet {
  readonly id: string;
  readonly address: string;
  readonly privyWalletId: string;
  readonly perTransactionMaxUsdc: bigint;
}

function moveInWallet(wallet: Wallet | undefined): MoveInWallet | null {
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
    perTransactionMaxUsdc: wallet.perTransactionMaxUsdc,
  };
}

/**
 * Whether a move-in may start for the company now: none is open (one in
 * `needs_review` counts, and blocks until a person settles it), none ended
 * refunded or failed within `MOVE_IN_RETRY_AFTER_MS`, nothing else is
 * moving the company wallet's USDC (a Base hop, a USDC payout or a move to
 * Treasury paid by a transfer from it, a company wallet send, a payout being
 * funded), and payouts aren't paused. A hop in review that was paid out of
 * the confidential account blocks nothing: it never touched the company
 * wallet.
 */
function mayStart(
  tx: Transaction,
  organizationId: string,
  walletId: string,
): Effect.Effect<boolean, DatabaseError> {
  return Effect.gen(function* () {
    const [quote] = yield* query(() =>
      tx
        .select({ id: intentQuotes.id })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            or(
              and(
                eq(intentQuotes.purpose, "move_in"),
                inArray(intentQuotes.status, [
                  ...UNSETTLED_INTENT_QUOTE_STATUSES,
                ]),
              ),
              and(
                eq(intentQuotes.purpose, "move_in"),
                inArray(intentQuotes.status, ["refunded", "failed"]),
                gt(
                  intentQuotes.settledAt,
                  new Date(Date.now() - MOVE_IN_RETRY_AFTER_MS),
                ),
              ),
              and(
                inArray(intentQuotes.purpose, [
                  ...COMPANY_WALLET_QUOTE_PURPOSES,
                ]),
                eq(intentQuotes.depositType, "ORIGIN_CHAIN"),
                inArray(intentQuotes.status, [
                  ...UNSETTLED_INTENT_QUOTE_STATUSES,
                ]),
              ),
            ),
          ),
        )
        .limit(1),
    );
    if (quote) return false;

    const [send] = yield* query(() =>
      tx
        .select({ id: companyWalletSends.id })
        .from(companyWalletSends)
        .where(
          and(
            eq(companyWalletSends.walletId, walletId),
            inArray(companyWalletSends.status, ["reserved", "signed"]),
          ),
        )
        .limit(1),
    );
    if (send) return false;

    const [funding] = yield* query(() =>
      tx
        .select({ id: payouts.id })
        .from(payouts)
        .where(
          and(eq(payouts.walletId, walletId), eq(payouts.status, "funding")),
        )
        .limit(1),
    );
    if (funding) return false;

    return !(yield* isPaused(tx, organizationId));
  });
}

/**
 * The amount of one move-in: what the company wallet holds on chain less
 * Expendi's own USDC in it (`recordedExpendiSurplus`), in even parts no
 * larger than the spend cap, as Treasury splits a move. Even parts rather
 * than full parts and a remainder, which could be too small to move. Null
 * below `MOVE_IN_MIN_USDC`: that dust stays in the company wallet, counted
 * by the ledger.
 */
function moveInAmount(input: {
  readonly held: bigint;
  readonly surplus: bigint;
  readonly spendCap: bigint;
}): bigint | null {
  const movable = input.held - input.surplus;
  if (movable < MOVE_IN_MIN_USDC) return null;
  const parts = (movable + input.spendCap - 1n) / input.spendCap;
  return (movable + parts - 1n) / parts;
}

/**
 * Starts a move-in for the company if its balance belongs in a confidential
 * account and USDC is waiting in its company wallet. The quote is saved
 * under the company wallet's row lock after checking again that none may
 * not start, before anything is sent. Returns the move-in it started, or
 * null: for nothing to move, for anything that stops one, and for a quote
 * 1Click refused or that failed our checks.
 */
export function startMoveIn(input: {
  readonly organizationId: string;
}): Effect.Effect<IntentQuote | null, DatabaseError, MoveInDeps> {
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
        const wallet = moveInWallet(row);
        if (wallet === null) return null;
        if (!(yield* mayStart(tx, organizationId, wallet.id))) return null;
        return {
          wallet,
          surplus: yield* recordedExpendiSurplus(tx, wallet.id),
        };
      }),
    );
    if (ready === null) return null;
    const { wallet, surplus } = ready;
    const { address } = wallet;

    const rpc = yield* NearRpc;
    const held = yield* rpc.usdcBalance(address).pipe(Effect.either);
    if (held._tag === "Left") {
      console.warn(
        `[move-in] ${organizationId}'s company wallet balance unreadable`,
        held.left.message,
      );
      return null;
    }
    const amount = moveInAmount({
      held: held.right,
      surplus,
      spendCap: wallet.perTransactionMaxUsdc,
    });
    if (amount === null) return null;

    const accounts = yield* ConfidentialAccounts;
    const session = yield* accounts
      .session({ privyWalletId: wallet.privyWalletId, accountId: address })
      .pipe(Effect.either);
    if (session._tag === "Left") {
      console.warn(
        `[move-in] couldn't sign ${organizationId} in to 1Click; nothing moved`,
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
          originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
          destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
          amount,
          depositType: "ORIGIN_CHAIN",
          recipient: address,
          recipientType: "CONFIDENTIAL_INTENTS",
          refundTo: address,
          refundType: "ORIGIN_CHAIN",
          deadline: new Date(Date.now() + COMPANY_QUOTE_TTL_MS),
          slippageBps: 0,
        },
        session.right,
      )
      .pipe(Effect.either);
    if (quoted._tag === "Left") {
      console.warn(
        `[move-in] no quote to move ${organizationId}'s USDC in`,
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
      quote.amountOut !== quote.amountIn
    ) {
      console.error(
        `[move-in] 1Click's quote to move ${organizationId}'s USDC in failed our checks; nothing sent`,
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
        if (!(yield* mayStart(tx, organizationId, wallet.id))) return null;
        const [row] = yield* query(() =>
          tx
            .insert(intentQuotes)
            .values({
              organizationId,
              walletId: wallet.id,
              quoteKey: `move-in:${randomUUID()}`,
              purpose: "move_in",
              swapType: "EXACT_INPUT",
              originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
              destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
              amountIn: quote.amountIn,
              amountOut: quote.amountOut,
              minAmountOut: quote.minAmountOut,
              depositAddress: quote.depositAddress,
              depositType: "ORIGIN_CHAIN",
              recipient: address,
              recipientType: "CONFIDENTIAL_INTENTS",
              refundTo: address,
              refundType: "ORIGIN_CHAIN",
              deadline: quote.deadline,
              quoteResponse: quote.signedResponse,
            })
            .returning(),
        );
        if (!row) {
          return yield* Effect.dieMessage("move-in insert returned no row");
        }
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId,
          action: "move_in.created",
          entity: { type: "intent_quote", id: row.id },
          after: {
            amountIn: row.amountIn,
            amountOut: row.amountOut,
            depositAddress: row.depositAddress,
            deadline: row.deadline.toISOString(),
          },
        });
        return row;
      }),
    );
    if (saved === null) return null;
    return yield* advanceMoveIn(saved);
  });
}

/** Asked before the deposit starts: still wanted while payouts run and the balance lives in the account. */
function stillWanted(
  quote: IntentQuote,
): Effect.Effect<DepositGate, DatabaseError, DatabaseService> {
  return withScope({ organizationId: quote.organizationId }, (tx) =>
    Effect.gen(function* () {
      if (yield* isPaused(tx, quote.organizationId)) {
        return {
          kind: "abandon",
          reason: "Payouts were paused before the move-in. Nothing moved.",
        } as const;
      }
      const [wallet] = yield* query(() =>
        tx
          .select({ balanceHome: wallets.balanceHome })
          .from(wallets)
          .where(eq(wallets.id, quote.walletId)),
      );
      if (wallet?.balanceHome !== "confidential_account") {
        return {
          kind: "abandon",
          reason:
            "The company's balance no longer belongs in a confidential account. Nothing moved.",
        } as const;
      }
      return { kind: "go" } as const;
    }),
  );
}

/**
 * Moves a saved move-in as far as it can go now, as `advanceCompanyQuote`
 * does for a Base hop, with the company's 1Click session, since 1Click
 * tells us nothing about a quote that delivers to a confidential account
 * without it. When the company can't be signed in, the quote is returned
 * unchanged: a deposit must not start when the quote can't be settled.
 *
 * - the deadline too close, payouts paused or the balance no longer in the
 *   account, before the deposit starts: `expired`, nothing moved;
 * - the company wallet refuses the send: `failed`, nothing moved;
 * - its outcome unknown: followed up under the same send key, and
 *   `needs_review` if still unknown after the deadline;
 * - 1Click `REFUNDED`: `refunded`, the USDC is back in the company wallet;
 * - 1Click `FAILED`: `needs_review`.
 */
export function advanceMoveIn(
  ref: Pick<IntentQuote, "id" | "organizationId">,
): Effect.Effect<IntentQuote, DatabaseError, MoveInDeps> {
  return Effect.gen(function* () {
    const quote = yield* quoteById(ref.organizationId, ref.id);
    if (
      quote.purpose !== "move_in" ||
      !UNSETTLED_INTENT_QUOTE_STATUSES.some((status) => status === quote.status)
    ) {
      return quote;
    }
    const session = yield* sessionForQuote(quote).pipe(Effect.either);
    if (session._tag === "Left") {
      console.warn(
        `[move-in] couldn't sign in to settle move-in ${quote.id}; left as it is`,
        session.left.message,
      );
      return quote;
    }
    return yield* advanceCompanyQuote({
      quote,
      session: session.right,
      beforeDeposit: stillWanted,
    });
  });
}

interface QuoteRef extends Record<string, unknown> {
  readonly quote_id: string;
  readonly organization_id: string;
}

interface WalletRef extends Record<string, unknown> {
  readonly organization_id: string;
}

export interface MoveInSummary {
  /** Open move-ins moved on in this run. */
  readonly advanced: number;
  readonly started: number;
  readonly errors: number;
}

/**
 * The move-in job: moves on every open move-in, then starts one for each
 * company whose balance belongs in a confidential account. Each quote and
 * each company is handled on its own, so one failure never stops the rest.
 * Other companies are never read.
 */
export function moveIn(
  maxRows = 50,
): Effect.Effect<MoveInSummary, DatabaseError, MoveInDeps> {
  return Effect.gen(function* () {
    let advanced = 0;
    let started = 0;
    let errors = 0;
    const isolated = <A>(
      what: string,
      work: Effect.Effect<A, DatabaseError, MoveInDeps>,
    ) =>
      Effect.exit(work).pipe(
        Effect.map((exit) => {
          if (Exit.isSuccess(exit)) return exit.value;
          errors += 1;
          console.error(`[move-in] ${what} broke`, Cause.pretty(exit.cause));
          return null;
        }),
      );

    const { rows: open } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<QuoteRef>(
          sql`SELECT quote_id, organization_id FROM intent_quotes_to_refresh(ARRAY['move_in'], ${maxRows})`,
        ),
      ),
    );
    for (const ref of open) {
      const moved = yield* isolated(
        `move-in ${ref.quote_id}`,
        advanceMoveIn({
          id: ref.quote_id,
          organizationId: ref.organization_id,
        }),
      );
      if (moved !== null) advanced += 1;
    }

    const { rows: companies } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<WalletRef>(
          sql`SELECT organization_id FROM confidential_account_wallets()`,
        ),
      ),
    );
    for (const { organization_id: organizationId } of companies) {
      const begun = yield* isolated(
        `moving ${organizationId}'s USDC in`,
        startMoveIn({ organizationId }),
      );
      if (begun !== null) started += 1;
    }
    return { advanced, started, errors };
  });
}
