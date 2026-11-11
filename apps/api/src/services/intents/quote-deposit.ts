import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { BaseRpc } from "../chain/base-rpc.js";
import type { CompanyWalletSendDeps } from "../wallet/company-wallet-send.js";
import {
  companyWalletSends,
  intentQuotes,
  payouts,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { baseUsdcBalance } from "../chain/base-rpc.js";
import { NearRelayer } from "../chain/near-relayer.js";
import { NearRpc } from "../chain/near-rpc.js";
import { isImplicitNearAccount } from "../chain/near.js";
import {
  sendUsdcFromCompanyWallet,
  settleCompanyWalletSend,
} from "../wallet/company-wallet-send.js";
import { ledgerBalance } from "../wallet/ledger.js";
import { ONE_CLICK_USDC_ASSET_IDS, OneClick } from "./one-click.js";
import {
  moveQuote,
  orCurrent,
  quoteById,
  quoteSendKey,
  settleFromOneClick,
} from "./quote-settle.js";

/**
 * Paying a NEAR Intents quote from a company wallet: a Base hop, or a USDC
 * payout to a payee on Base or Solana (docs/decisions/near-main-chain.md,
 * "Base hop"). Every step is saved on the quote's row before the next one
 * starts, so a run that stops anywhere is picked up from the row alone:
 *
 * 1. a firm `EXACT_OUTPUT` quote, saved (`openCompanyQuote`);
 * 2. the gas relayer registers the quote's deposit address with USDC;
 * 3. the gas relayer sends the company wallet what the quote costs beyond
 *    what it delivers, less Expendi's surplus already there;
 * 4. the company wallet sends the quote's amount in to the deposit address;
 * 5. 1Click is told which transaction that was;
 * 6. 1Click's status settles the quote.
 *
 * Money leaves the company wallet only in step 4, once, through
 * `sendUsdcFromCompanyWallet`, which also enforces the spend cap. None of
 * this is a ledger entry: the caller debits the ledger for what it pays.
 */

/** How long a quote stays open for its deposit. */
export const COMPANY_QUOTE_TTL_MS = 10 * 60_000;

/**
 * No deposit is started with less than this left before the deadline: a
 * company wallet send stays valid for about two minutes, and one that lands
 * after the deadline is only refunded.
 */
export const DEPOSIT_MARGIN_MS = 3 * 60_000;

/**
 * 0.1%. USDC to USDC barely moves, and with `EXACT_OUTPUT` the slippage is
 * a buffer added to the amount in and refunded afterwards, so a tight one
 * keeps what the gas relayer has to cover small.
 */
export const STABLECOIN_SLIPPAGE_BPS = 10;

/**
 * The most a quote may cost beyond what it delivers: 2% plus 1 USDC, far
 * above a real USDC route (under a cent to Base, about 0.21 USDC for a new
 * Solana token account). A quote asking more is refused, so a bad quote
 * can't draw on the gas relayer.
 */
export function maxQuoteCost(amountOut: bigint): bigint {
  return amountOut / 50n + 1_000_000n;
}

/** A send still unresolved this long after the deadline is for a person. */
const SEND_FOLLOW_UP_MS = 5 * 60_000;

export const COMPANY_QUOTE_PURPOSES = ["base_hop", "usdc_payout"] as const;
export type CompanyQuotePurpose = (typeof COMPANY_QUOTE_PURPOSES)[number];

/**
 * No quote was saved and nothing moved: 1Click refused or didn't answer,
 * its quote failed our checks, or the company has no wallet to pay it from.
 */
export class QuoteNotOpened extends Data.TaggedError("QuoteNotOpened")<{
  readonly reason: "no_wallet" | "one_click" | "untrusted" | "over_cap";
  readonly message: string;
}> {}

export type DepositGate =
  | { readonly kind: "go" }
  | { readonly kind: "abandon"; readonly reason: string };

export type QuoteDepositDeps =
  CompanyWalletSendDeps | OneClick | BaseRpc | DatabaseService;

/**
 * Takes a firm `EXACT_OUTPUT` quote that delivers exactly `amountOut` USDC
 * to `recipient`, refunding to the company wallet, and saves it. `link`
 * runs in the same transaction as the insert, so what the quote is for
 * (its payouts) is linked to it or the quote isn't saved at all. The same
 * key returns the quote already saved under it and asks 1Click nothing.
 */
export function openCompanyQuote(input: {
  readonly organizationId: string;
  readonly quoteKey: string;
  readonly purpose: CompanyQuotePurpose;
  readonly destinationChain: "base" | "solana";
  readonly recipient: string;
  readonly amountOut: bigint;
  readonly link: (
    tx: Transaction,
    quote: IntentQuote,
  ) => Effect.Effect<void, DatabaseError>;
}): Effect.Effect<
  IntentQuote,
  QuoteNotOpened | DatabaseError,
  OneClick | DatabaseService
> {
  const { organizationId } = input;
  const byKey = withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            eq(intentQuotes.quoteKey, input.quoteKey),
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map(([quote]) => quote ?? null));

  return Effect.gen(function* () {
    const existing = yield* byKey;
    if (existing) return existing;

    const [wallet] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select()
          .from(wallets)
          .where(eq(wallets.organizationId, organizationId))
          .limit(1),
      ),
    );
    if (
      wallet?.status !== "active" ||
      wallet.chain !== "near" ||
      wallet.address === null ||
      !isImplicitNearAccount(wallet.address)
    ) {
      return yield* Effect.fail(
        new QuoteNotOpened({
          reason: "no_wallet",
          message: "The company has no active company wallet on NEAR.",
        }),
      );
    }

    const oneClick = yield* OneClick;
    const quoted = yield* oneClick
      .quote({
        dry: false,
        swapType: "EXACT_OUTPUT",
        originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS[input.destinationChain],
        amount: input.amountOut,
        recipient: input.recipient,
        refundTo: wallet.address,
        deadline: new Date(Date.now() + COMPANY_QUOTE_TTL_MS),
        slippageBps: STABLECOIN_SLIPPAGE_BPS,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new QuoteNotOpened({
              reason:
                error._tag === "OneClickQuoteUntrusted"
                  ? "untrusted"
                  : "one_click",
              message: error.message,
            }),
        ),
      );
    const untrusted = (message: string) =>
      Effect.fail(new QuoteNotOpened({ reason: "untrusted", message }));
    if (quoted.dry)
      return yield* untrusted("1Click answered with a dry quote.");
    // A plain ft_transfer carries no memo, and only a 64-hex account can be
    // registered and paid the way step 2 and step 4 do.
    if (
      quoted.depositMemo !== null ||
      !isImplicitNearAccount(quoted.depositAddress)
    ) {
      return yield* untrusted(
        "1Click's deposit address can't be paid with a plain USDC transfer.",
      );
    }
    if (
      quoted.amountOut !== input.amountOut ||
      quoted.amountIn < quoted.amountOut ||
      quoted.amountIn - quoted.amountOut > maxQuoteCost(quoted.amountOut)
    ) {
      return yield* untrusted(
        `1Click asks ${quoted.amountIn} to deliver ${quoted.amountOut} USDC base units, which is more than a USDC route costs.`,
      );
    }
    if (quoted.amountIn > wallet.perTransactionMaxUsdc) {
      return yield* Effect.fail(
        new QuoteNotOpened({
          reason: "over_cap",
          message: `The quote needs ${quoted.amountIn} USDC base units in one transfer, over the wallet's per-transaction maximum of ${wallet.perTransactionMaxUsdc}.`,
        }),
      );
    }

    const inserted = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          tx
            .insert(intentQuotes)
            .values({
              organizationId,
              walletId: wallet.id,
              quoteKey: input.quoteKey,
              purpose: input.purpose,
              swapType: "EXACT_OUTPUT",
              originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
              destinationAsset:
                ONE_CLICK_USDC_ASSET_IDS[input.destinationChain],
              amountIn: quoted.amountIn,
              minAmountIn: quoted.minAmountIn,
              amountOut: quoted.amountOut,
              depositAddress: quoted.depositAddress,
              recipient: input.recipient,
              refundTo: wallet.address ?? "",
              deadline: quoted.deadline,
              quoteResponse: quoted.signedResponse,
            })
            .onConflictDoNothing({
              target: [intentQuotes.organizationId, intentQuotes.quoteKey],
            })
            .returning(),
        );
        if (row) yield* input.link(tx, row);
        return row ?? null;
      }),
    );
    if (inserted) return inserted;
    const raced = yield* byKey;
    return raced ?? (yield* Effect.dieMessage("intent quote insert vanished"));
  });
}

/**
 * Expendi's own USDC already sitting in the company wallet: what the gas
 * relayer sent for earlier quotes, less what those quotes turned out to
 * cost. An `EXACT_OUTPUT` quote refunds its unused buffer to the company
 * wallet, so each covered quote leaves a little behind for the next.
 *
 * It is worked out from the quotes' own rows, so a deposit the watcher
 * hasn't credited yet can never be mistaken for it, and it is only used
 * when the chain agrees: with nothing else of the company's in flight, the
 * company wallet must hold at least that much above what the ledger says
 * it should. Whenever that can't be shown, the answer is 0 and the relayer
 * covers the full difference.
 */
function expendiSurplus(
  quote: IntentQuote,
): Effect.Effect<bigint, never, DatabaseService | NearRpc | BaseRpc> {
  const scope = { organizationId: quote.organizationId };
  return Effect.gen(function* () {
    const recorded = yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const [sums] = yield* query(() =>
          tx
            .select({
              surplus: sql<string>`coalesce(sum(
                coalesce(${intentQuotes.feeCoverUsdc}, 0) - CASE
                  WHEN ${intentQuotes.status} = 'succeeded' THEN
                    least(greatest(coalesce(${intentQuotes.swappedAmountIn}, ${intentQuotes.amountIn}), ${intentQuotes.amountOut}), ${intentQuotes.amountIn}) - ${intentQuotes.amountOut}
                  WHEN ${intentQuotes.status} = 'refunded' THEN
                    ${intentQuotes.amountIn} - least(coalesce(${intentQuotes.refundedAmount}, ${intentQuotes.amountIn}), ${intentQuotes.amountIn})
                  WHEN ${intentQuotes.status} = 'failed' AND ${intentQuotes.companyWalletSendId} IS NULL THEN 0
                  ELSE ${intentQuotes.amountIn} - ${intentQuotes.amountOut}
                END), 0)::text`,
            })
            .from(intentQuotes)
            .where(
              and(
                eq(intentQuotes.walletId, quote.walletId),
                ne(intentQuotes.id, quote.id),
                inArray(intentQuotes.purpose, [...COMPANY_QUOTE_PURPOSES]),
                sql`${intentQuotes.depositStartedAt} IS NOT NULL`,
              ),
            ),
        );
        const surplus = BigInt(sums?.surplus ?? "0");
        if (surplus <= 0n) return null;

        const [busyQuote] = yield* query(() =>
          tx
            .select({ id: intentQuotes.id })
            .from(intentQuotes)
            .where(
              and(
                eq(intentQuotes.organizationId, quote.organizationId),
                ne(intentQuotes.id, quote.id),
                inArray(intentQuotes.status, [
                  ...UNSETTLED_INTENT_QUOTE_STATUSES,
                ]),
              ),
            )
            .limit(1),
        );
        const [busyPayout] = yield* query(() =>
          tx
            .select({ id: payouts.id })
            .from(payouts)
            .where(
              and(
                eq(payouts.walletId, quote.walletId),
                eq(payouts.status, "funding"),
              ),
            )
            .limit(1),
        );
        const [busySend] = yield* query(() =>
          tx
            .select({ id: companyWalletSends.id })
            .from(companyWalletSends)
            .where(
              and(
                eq(companyWalletSends.walletId, quote.walletId),
                inArray(companyWalletSends.status, ["reserved", "signed"]),
              ),
            )
            .limit(1),
        );
        if (busyQuote || busyPayout || busySend) return null;

        const [wallet] = yield* query(() =>
          tx
            .select({
              address: wallets.address,
              transitAddress: wallets.transitAddress,
            })
            .from(wallets)
            .where(eq(wallets.id, quote.walletId)),
        );
        if (!wallet?.address || !wallet.transitAddress) return null;
        return {
          surplus,
          ledger: yield* ledgerBalance(tx, quote.walletId),
          address: wallet.address,
          transitAddress: wallet.transitAddress,
        };
      }),
    );
    if (recorded === null) return 0n;

    const rpc = yield* NearRpc;
    const [held, inTransit] = yield* Effect.all([
      rpc.usdcBalance(recorded.address),
      baseUsdcBalance(recorded.transitAddress),
    ]);
    const aboveLedger = held - (recorded.ledger - inTransit);
    if (aboveLedger <= 0n) return 0n;
    return recorded.surplus < aboveLedger ? recorded.surplus : aboveLedger;
  }).pipe(
    Effect.catchAll((error) => {
      console.warn(
        `[intents] couldn't work out Expendi's surplus for quote ${quote.id}; covering the full difference`,
        error._tag,
      );
      return Effect.succeed(0n);
    }),
  );
}

/**
 * Step 3. The amount is saved before anything is sent and the relayer
 * transaction's hash before it is broadcast, and a second transaction is
 * built only when the first is known to have failed on chain. A saved hash
 * whose outcome the chain doesn't show holds the quote where it is: it is
 * never paid a second time on a guess. `covered` only once the chain shows
 * the cover arrived, or none was needed.
 */
function coverFee(
  quote: IntentQuote,
): Effect.Effect<
  "covered" | "waiting",
  DatabaseError,
  DatabaseService | NearRpc | NearRelayer | BaseRpc
> {
  return Effect.gen(function* () {
    const rpc = yield* NearRpc;
    const relayer = yield* NearRelayer;
    const untouched = and(
      eq(intentQuotes.status, "quoted"),
      isNull(intentQuotes.depositStartedAt),
    );
    let current = quote;

    if (current.feeCoverTxHash !== null) {
      const sentHash = current.feeCoverTxHash;
      const outcome = yield* rpc
        .transactionOutcome(sentHash, relayer.accountId)
        .pipe(Effect.orElseSucceed(() => null));
      if (outcome === null) return "waiting";
      if (outcome.succeeded) return "covered";
      const cleared = yield* moveQuote(
        current,
        and(untouched, eq(intentQuotes.feeCoverTxHash, sentHash)),
        { feeCoverTxHash: null },
      );
      if (cleared === null) return "waiting";
      current = cleared;
    }

    let amount = current.feeCoverUsdc;
    if (amount === null) {
      const difference = current.amountIn - current.amountOut;
      const surplus = yield* expendiSurplus(current);
      amount = difference > surplus ? difference - surplus : 0n;
      if (amount === 0n) return "covered";
      const saved = yield* moveQuote(
        current,
        and(untouched, isNull(intentQuotes.feeCoverUsdc)),
        { feeCoverUsdc: amount },
      );
      if (saved === null) return "waiting";
      current = saved;
    }

    const sent = yield* relayer
      .sendUsdc({
        to: current.refundTo,
        amount,
        beforeBroadcast: (txHash) =>
          moveQuote(
            current,
            and(untouched, isNull(intentQuotes.feeCoverTxHash)),
            { feeCoverTxHash: txHash },
          ).pipe(
            Effect.flatMap((saved) =>
              saved
                ? Effect.void
                : Effect.dieMessage(
                    `quote ${current.id} moved while its fee cover was being sent`,
                  ),
            ),
          ),
      })
      .pipe(Effect.either);
    if (sent._tag === "Left") {
      console.warn(
        `[intents] the fee cover for quote ${current.id} wasn't sent`,
        sent.left.message,
      );
      return "waiting";
    }
    const outcome = yield* relayer
      .awaitOutcome(sent.right.txHash)
      .pipe(Effect.orElseSucceed(() => null));
    return outcome?.succeeded === true ? "covered" : "waiting";
  });
}

/** Step 4, and following up a send whose outcome wasn't known yet. */
function deposit(
  quote: IntentQuote,
): Effect.Effect<IntentQuote, DatabaseError, QuoteDepositDeps> {
  const sendKey = quoteSendKey(quote.id);
  const unpaid = and(
    eq(intentQuotes.status, "depositing"),
    isNull(intentQuotes.companyWalletSendId),
  );
  const paid = (sendId: string, txHash: string) =>
    moveQuote(quote, unpaid, {
      companyWalletSendId: sendId,
      depositTxHash: txHash,
    }).pipe(Effect.flatMap((moved) => orCurrent(quote, moved)));
  const nothingMoved = (failure: string) =>
    moveQuote(quote, unpaid, {
      status: "failed",
      settledAt: new Date(),
      failure,
    }).pipe(Effect.flatMap((moved) => orCurrent(quote, moved)));
  const unresolved = (failure: string) =>
    Date.now() > quote.deadline.getTime() + SEND_FOLLOW_UP_MS
      ? moveQuote(quote, unpaid, { status: "needs_review", failure }).pipe(
          Effect.flatMap((moved) => orCurrent(quote, moved)),
        )
      : Effect.succeed(quote);

  return Effect.gen(function* () {
    // This close to the deadline a new send would land too late, so only
    // what an earlier one did is read.
    if (quote.deadline.getTime() - Date.now() < DEPOSIT_MARGIN_MS) {
      const earlier = yield* settleCompanyWalletSend({
        organizationId: quote.organizationId,
        sendKey,
      }).pipe(Effect.either);
      if (earlier._tag === "Left") {
        return earlier.left._tag === "SendOutcomeUnknown"
          ? yield* unresolved(
              "The company wallet's deposit may have run, and the chain doesn't say. Check the company wallet's transfers before doing anything.",
            )
          : quote;
      }
      const send = earlier.right;
      if (send?.status === "executed" && send.txHash !== null) {
        return yield* paid(send.id, send.txHash);
      }
      if (send?.status === "reserved" || send?.status === "signed") {
        return yield* unresolved(
          "The company wallet's deposit is signed and the chain doesn't show its outcome. Check the company wallet's transfers before doing anything.",
        );
      }
      return yield* nothingMoved(
        "The deposit was never sent before the quote's deadline. Nothing moved.",
      );
    }

    const sent = yield* sendUsdcFromCompanyWallet({
      organizationId: quote.organizationId,
      sendKey,
      to: quote.depositAddress,
      amount: quote.amountIn,
    }).pipe(Effect.either);
    if (sent._tag === "Right") {
      return yield* paid(sent.right.sendId, sent.right.txHash);
    }
    if (sent.left._tag === "SendRefused") {
      return yield* nothingMoved(sent.left.message);
    }
    if (sent.left._tag !== "CompanyWalletBusy") {
      console.warn(
        `[intents] the deposit for quote ${quote.id} isn't settled yet (${sent.left._tag}); following it up`,
      );
    }
    return quote;
  });
}

/** Step 5. 1Click finds a deposit by itself too, so a refusal here only costs time. */
function submitDeposit(
  quote: IntentQuote,
): Effect.Effect<IntentQuote, DatabaseError, OneClick | DatabaseService> {
  return Effect.gen(function* () {
    if (quote.depositTxHash === null || quote.depositSubmittedAt !== null) {
      return quote;
    }
    const oneClick = yield* OneClick;
    const told = yield* oneClick
      .submitDeposit(quote.depositAddress, quote.depositTxHash)
      .pipe(Effect.either);
    if (told._tag === "Left") return quote;
    return yield* orCurrent(
      quote,
      yield* moveQuote(quote, isNull(intentQuotes.depositSubmittedAt), {
        depositSubmittedAt: new Date(),
      }),
    );
  });
}

/**
 * Moves a saved company wallet quote as far as it can go right now and
 * returns it as it then stands. Safe to call at any time, any number of
 * times, from the request that opened the quote or from the job: each call
 * reads the row and does only the next step that hasn't been done.
 *
 * `beforeDeposit` is asked immediately before the row records that the
 * deposit is starting. It is where the caller decides the deposit is still
 * wanted (its payouts are still approved, payouts aren't paused) and takes
 * its own funding barrier; `abandon` ends the quote `expired` with nothing
 * moved. It may be asked again on a later call, so it must answer the same
 * for a barrier it already took.
 *
 * What each failure leaves behind:
 * - the deadline too close before the deposit starts: `expired`, nothing
 *   moved (a fee cover already sent stays in the company wallet as
 *   Expendi's surplus);
 * - `CompanyWalletBusy`, or a relayer or RPC failure: unchanged, the next
 *   call tries again;
 * - `SendRefused`: `failed`, nothing moved;
 * - `SendOutcomeUnknown`: stays `depositing` and is followed up with the
 *   same send key, which never sends twice; `needs_review` if it is still
 *   unknown after the deadline;
 * - 1Click `REFUNDED`: `refunded`, the money is back in the company wallet;
 * - 1Click `FAILED`: `needs_review`.
 */
export function advanceCompanyQuote<R>(input: {
  readonly quote: IntentQuote;
  readonly beforeDeposit: (
    quote: IntentQuote,
  ) => Effect.Effect<DepositGate, DatabaseError, R>;
}): Effect.Effect<IntentQuote, DatabaseError, QuoteDepositDeps | R> {
  return Effect.gen(function* () {
    let quote = yield* quoteById(input.quote.organizationId, input.quote.id);
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

    if (quote.status === "quoted") {
      if (quote.deadline.getTime() - Date.now() < DEPOSIT_MARGIN_MS) {
        return yield* expire(
          "The quote's deadline came before the deposit could start. Nothing moved.",
        );
      }

      const relayer = yield* NearRelayer;
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
          `[intents] the deposit address of quote ${quote.id} isn't registered with USDC yet`,
          registered.left.message,
        );
        return yield* quoteById(quote.organizationId, quote.id);
      }

      quote = yield* quoteById(quote.organizationId, quote.id);
      if ((yield* coverFee(quote)) === "waiting") {
        return yield* quoteById(quote.organizationId, quote.id);
      }

      quote = yield* quoteById(quote.organizationId, quote.id);
      const gate = yield* input.beforeDeposit(quote);
      if (gate.kind === "abandon") return yield* expire(gate.reason);

      const started = yield* moveQuote(quote, untouched, {
        status: "depositing",
        depositStartedAt: new Date(),
      });
      if (started === null) {
        return yield* quoteById(quote.organizationId, quote.id);
      }
      quote = started;
    }

    if (quote.status === "depositing" && quote.companyWalletSendId === null) {
      quote = yield* deposit(quote);
    }
    // 1Click's word settles a quote under review too, even one whose
    // deposit we lost track of.
    if (quote.status === "needs_review" && quote.depositStartedAt !== null) {
      return yield* settleFromOneClick(yield* submitDeposit(quote));
    }
    if (quote.status !== "depositing" || quote.companyWalletSendId === null) {
      return quote;
    }
    quote = yield* submitDeposit(quote);
    return yield* settleFromOneClick(quote);
  });
}
