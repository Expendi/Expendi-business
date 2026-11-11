import type { SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Cause, Effect, Exit } from "effect";

import type { FundInChain, FundInStatus } from "@expendi-business/shared";
import { FUND_IN_CHAINS } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote, IntentQuoteStatus } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { OneClickError } from "./one-click.js";
import {
  intentQuotes,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Conflict,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import {
  ONE_CLICK_FUND_IN_USDC_ASSET_IDS,
  ONE_CLICK_USDC_ASSET_IDS,
  OneClick,
} from "./one-click.js";
import { refreshQuoteStatus } from "./quote-status.js";

/**
 * Fund-in (CONTEXT.md): a company adds money to its company wallet by
 * sending USDC on another chain to a deposit address NEAR Intents gives for
 * it. Nothing here credits the ledger: the deposit watcher does, when the
 * USDC actually arrives at the company wallet.
 *
 * A fund-in that can't be completed is refunded into the company's own
 * NEAR Intents account, never to an address on the sending chain, so
 * nobody has to give one. The fund-in return (fund-in-return.ts) swaps it
 * back and delivers it to the company wallet, where it is credited.
 */

/**
 * How long a deposit address takes deposits. Long enough to send from an
 * exchange; short, because while a fund-in is open, USDC reaching the
 * company wallet from NEAR Intents waits to be told apart from it.
 */
export const FUND_IN_DEADLINE_MS = 2 * 60 * 60_000;

/** 1%: USDC to USDC moves cost a few cents, so this only bounds a bad quote. */
export const FUND_IN_SLIPPAGE_BPS = 100;

export const FUND_INS_LISTED = 20;

/** How many of one company's open fund-ins a run of the job asks 1Click about. */
const REFRESH_BATCH = 50;

/** `FundIn` before serialisation, which turns bigints and dates into strings. */
export interface FundInView {
  readonly id: string;
  readonly chain: FundInChain;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly depositAddress: string;
  readonly deadline: Date;
  readonly status: FundInStatus;
  readonly createdAt: Date;
}

const chainOfAsset = (originAsset: string): FundInChain | null =>
  FUND_IN_CHAINS.find(
    (chain) => ONE_CLICK_FUND_IN_USDC_ASSET_IDS[chain] === originAsset,
  ) ?? null;

/**
 * What the company is shown. A fund-in under review still reads as
 * `processing`: the money is somewhere between the two chains, and saying
 * `failed` before a person has looked would be a guess. A fund-in refunded
 * into NEAR Intents is `returning` until the quote returning it delivers.
 */
export function fundInStatus(
  quote: Pick<IntentQuote, "status" | "oneClickStatus" | "refundType">,
  returnStatus: IntentQuoteStatus | null,
): FundInStatus {
  switch (quote.status) {
    case "succeeded":
      return "completed";
    case "refunded":
      if (quote.refundType === "ORIGIN_CHAIN") return "refunded";
      return returnStatus === "succeeded" ? "returned" : "returning";
    case "failed":
    case "expired":
      return quote.status;
    case "needs_review":
      return "processing";
    case "quoted":
    case "depositing":
      return quote.oneClickStatus === null ||
        quote.oneClickStatus === "PENDING_DEPOSIT"
        ? "awaiting_deposit"
        : "processing";
  }
}

function toView(
  quote: IntentQuote,
  returnStatus: IntentQuoteStatus | null,
): Effect.Effect<FundInView> {
  const chain = chainOfAsset(quote.originAsset);
  return chain === null
    ? Effect.dieMessage(
        `fund-in ${quote.id} starts from an asset no fund-in chain uses`,
      )
    : Effect.succeed({
        id: quote.id,
        chain,
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        depositAddress: quote.depositAddress,
        deadline: quote.deadline,
        status: fundInStatus(quote, returnStatus),
        createdAt: quote.createdAt,
      });
}

const quoteUnavailable = new ServiceUnavailable({
  message: "Funding in isn't available right now. Try again in a minute.",
});

/**
 * Takes a firm quote for moving exactly `amount` of USDC from `chain` to the
 * company wallet and saves it. The deposit address is only ever shown from
 * the saved row, so every address a company was given can be traced.
 */
export function createFundIn(input: {
  readonly organizationId: string;
  readonly actor: AuditActor;
  readonly chain: FundInChain;
  /** USDC base units. */
  readonly amount: bigint;
}): Effect.Effect<
  FundInView,
  BadRequest | Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | OneClick | AuditLog
> {
  const { organizationId, actor } = input;
  return Effect.gen(function* () {
    const oneClick = yield* OneClick;
    const audit = yield* AuditLog;

    const [wallet] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select({
            id: wallets.id,
            chain: wallets.chain,
            status: wallets.status,
            address: wallets.address,
          })
          .from(wallets)
          .where(eq(wallets.organizationId, organizationId))
          .limit(1),
      ),
    );
    if (
      wallet?.status !== "active" ||
      wallet.chain !== "near" ||
      wallet.address === null
    ) {
      return yield* Effect.fail(
        new Conflict({
          message: "This company's wallet isn't ready to be funded yet.",
        }),
      );
    }

    const accountId = wallet.address;

    const quote = yield* oneClick
      .quote({
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset: ONE_CLICK_FUND_IN_USDC_ASSET_IDS[input.chain],
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        amount: input.amount,
        recipient: accountId,
        refundTo: accountId,
        refundType: "INTENTS",
        deadline: new Date(Date.now() + FUND_IN_DEADLINE_MS),
        slippageBps: FUND_IN_SLIPPAGE_BPS,
      })
      .pipe(
        Effect.catchTags({
          OneClickRefused: (error) => {
            console.warn(`[fund-in] quote refused: ${error.message}`);
            return Effect.fail(
              new BadRequest({
                message:
                  "That amount can't be funded in from this chain. Try a larger amount.",
              }),
            );
          },
          OneClickOutcomeUnknown: (error) => {
            console.error(`[fund-in] quote unavailable: ${error.message}`);
            return Effect.fail(quoteUnavailable);
          },
          OneClickQuoteUntrusted: (error) => {
            console.error(`[fund-in] quote not trusted: ${error.message}`);
            return Effect.fail(quoteUnavailable);
          },
        }),
      );
    // The app shows an address and an amount, nothing more: a deposit that
    // also needs a memo would be lost to the quote.
    if (quote.dry || quote.depositMemo !== null) {
      console.error("[fund-in] quote came dry or needing a memo; not used");
      return yield* Effect.fail(quoteUnavailable);
    }

    const saved = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          tx
            .insert(intentQuotes)
            .values({
              organizationId,
              walletId: wallet.id,
              quoteKey: `fund-in:${randomUUID()}`,
              purpose: "fund_in",
              swapType: "EXACT_INPUT",
              originAsset: ONE_CLICK_FUND_IN_USDC_ASSET_IDS[input.chain],
              destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
              amountIn: quote.amountIn,
              minAmountIn: quote.minAmountIn,
              amountOut: quote.amountOut,
              minAmountOut: quote.minAmountOut,
              depositAddress: quote.depositAddress,
              recipient: accountId,
              refundTo: accountId,
              refundType: "INTENTS",
              deadline: quote.deadline,
              quoteResponse: quote.signedResponse,
            })
            .returning(),
        );
        if (!row)
          return yield* Effect.dieMessage("fund-in insert returned no row");
        yield* audit.record(tx, {
          actor,
          organizationId,
          action: "fund_in.created",
          entity: { type: "intent_quote", id: row.id },
          after: {
            chain: input.chain,
            amountIn: row.amountIn,
            amountOut: row.amountOut,
            depositAddress: row.depositAddress,
            refundTo: row.refundTo,
            refundType: row.refundType,
            deadline: row.deadline.toISOString(),
          },
        });
        return row;
      }),
    );
    return yield* toView(saved, null);
  });
}

const fundInsOf = (organizationId: string) =>
  and(
    eq(intentQuotes.organizationId, organizationId),
    eq(intentQuotes.purpose, "fund_in"),
  );

const returnQuotes = alias(intentQuotes, "return_quote");

/** Fund-ins matching `where`, each with the status of the quote returning it. */
function fundInRows(
  organizationId: string,
  where: SQL | undefined,
  limit: number,
) {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({ fundIn: intentQuotes, returnStatus: returnQuotes.status })
        .from(intentQuotes)
        .leftJoin(
          returnQuotes,
          and(
            eq(returnQuotes.id, intentQuotes.returnQuoteId),
            eq(returnQuotes.organizationId, intentQuotes.organizationId),
          ),
        )
        .where(and(fundInsOf(organizationId), where))
        .orderBy(desc(intentQuotes.createdAt), desc(intentQuotes.id))
        .limit(limit),
    ),
  );
}

/** The company's latest fund-ins, newest first. */
export function listFundIns(
  organizationId: string,
): Effect.Effect<FundInView[], DatabaseError, DatabaseService> {
  return fundInRows(organizationId, undefined, FUND_INS_LISTED).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, ({ fundIn, returnStatus }) =>
        toView(fundIn, returnStatus),
      ),
    ),
  );
}

export function getFundIn(
  organizationId: string,
  fundInId: string,
): Effect.Effect<FundInView, NotFound | DatabaseError, DatabaseService> {
  return fundInRows(organizationId, eq(intentQuotes.id, fundInId), 1).pipe(
    Effect.flatMap(([row]) =>
      row
        ? toView(row.fundIn, row.returnStatus)
        : Effect.fail(new NotFound({ message: "Fund-in not found" })),
    ),
  );
}

/**
 * Where a fund-in stands given what 1Click last said, or null when it stays
 * as it is. `expired` needs both a passed deadline and 1Click still waiting
 * for a deposit: after the deadline it refunds anything that arrives.
 */
function nextStatus(
  quote: IntentQuote,
  now: Date,
): { readonly status: IntentQuoteStatus; readonly failure?: string } | null {
  switch (quote.oneClickStatus) {
    case "SUCCESS":
      return { status: "succeeded" };
    case "REFUNDED":
      return { status: "refunded" };
    case "FAILED":
      return {
        status: "failed",
        failure: quote.refundReason ?? "1Click reported the fund-in as failed",
      };
    case "PENDING_DEPOSIT":
      return quote.deadline.getTime() < now.getTime()
        ? { status: "expired" }
        : null;
    case "KNOWN_DEPOSIT_TX":
    case "INCOMPLETE_DEPOSIT":
    case "PROCESSING":
      return quote.status === "quoted" ? { status: "depositing" } : null;
    case null:
      return null;
  }
}

const FINAL_STATUSES: readonly IntentQuoteStatus[] = [
  "succeeded",
  "refunded",
  "failed",
  "expired",
];

/**
 * Asks 1Click about one fund-in and moves it to `depositing`, `succeeded`,
 * `refunded`, `failed` or `expired` accordingly. A fund-in that already
 * settled keeps its status. Returns the row as it now stands.
 */
export function refreshFundIn(
  quote: Pick<IntentQuote, "id" | "organizationId" | "depositAddress">,
): Effect.Effect<
  IntentQuote,
  OneClickError | DatabaseError,
  OneClick | DatabaseService
> {
  return Effect.gen(function* () {
    const refreshed = yield* refreshQuoteStatus(quote);
    const next = nextStatus(refreshed, new Date());
    if (refreshed.purpose !== "fund_in" || next === null) return refreshed;
    const [moved] = yield* withScope(
      { organizationId: refreshed.organizationId },
      (tx) =>
        query(() =>
          tx
            .update(intentQuotes)
            .set({
              status: next.status,
              ...(next.failure !== undefined && { failure: next.failure }),
              ...(FINAL_STATUSES.includes(next.status) && {
                settledAt: sql`now()`,
              }),
            })
            .where(
              and(
                eq(intentQuotes.id, refreshed.id),
                fundInsOf(refreshed.organizationId),
                inArray(intentQuotes.status, [
                  ...UNSETTLED_INTENT_QUOTE_STATUSES,
                ]),
              ),
            )
            .returning(),
        ),
    );
    return moved ?? refreshed;
  });
}

interface FundedWallet extends Record<string, unknown> {
  readonly organization_id: string;
}

export interface FundInRefreshSummary {
  readonly checked: number;
  /** Reached succeeded, refunded, failed or expired in this run. */
  readonly settled: number;
  /** 1Click or the database didn't answer; tried again next run. */
  readonly unanswered: number;
}

/**
 * Refreshes every open fund-in. Only a company with an active company
 * wallet can have one, so the job walks those wallets and reads each
 * company's open fund-ins inside its own scope, least recently checked
 * first. It only reads 1Click and updates our records, so it is always safe
 * to run.
 */
export function refreshOpenFundIns(): Effect.Effect<
  FundInRefreshSummary,
  DatabaseError,
  DatabaseService | OneClick
> {
  return Effect.gen(function* () {
    const { rows: funded } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<FundedWallet>(
          sql`SELECT organization_id FROM active_main_chain_wallets()`,
        ),
      ),
    );
    const open: Pick<
      IntentQuote,
      "id" | "organizationId" | "depositAddress"
    >[] = [];
    for (const { organization_id: organizationId } of funded) {
      open.push(
        ...(yield* withScope({ organizationId }, (tx) =>
          query(() =>
            tx
              .select({
                id: intentQuotes.id,
                organizationId: intentQuotes.organizationId,
                depositAddress: intentQuotes.depositAddress,
              })
              .from(intentQuotes)
              .where(
                and(
                  fundInsOf(organizationId),
                  inArray(intentQuotes.status, [
                    ...UNSETTLED_INTENT_QUOTE_STATUSES,
                  ]),
                ),
              )
              .orderBy(
                sql`${intentQuotes.oneClickCheckedAt} NULLS FIRST`,
                asc(intentQuotes.updatedAt),
              )
              .limit(REFRESH_BATCH),
          ),
        )),
      );
    }

    let settled = 0;
    let unanswered = 0;
    for (const quote of open) {
      const exit = yield* Effect.exit(refreshFundIn(quote));
      if (Exit.isFailure(exit)) {
        unanswered += 1;
        console.warn(
          `[fund-in] fund-in ${quote.id} not refreshed`,
          Cause.pretty(exit.cause),
        );
      } else if (FINAL_STATUSES.includes(exit.value.status)) {
        settled += 1;
      }
    }
    return { checked: open.length, settled, unanswered };
  });
}
