import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuotePurpose } from "../../db/schema/index.js";
import type { WalletBalanceHome } from "../../db/schema/wallets.js";
import type { DatabaseError } from "../../errors.js";
import type { BaseRpc } from "../chain/base-rpc.js";
import {
  companyWalletSends,
  intentQuotes,
  payouts,
  treasuryMoves,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { baseUsdcBalance } from "../chain/base-rpc.js";
import { NearRpc } from "../chain/near-rpc.js";
import { ConfidentialAccounts } from "../intents/confidential-account.js";
import { recordedExpendiSurplus } from "../intents/expendi-surplus.js";
import { ledgerBalance } from "./ledger.js";

/**
 * A Treasury move that settled this recently may still be waiting to be
 * credited.
 */
export const CREDIT_WINDOW_MINUTES = 30;

/**
 * A `quoted` delivery into a confidential account that 1Click reported as
 * still waiting for its deposit this recently has taken no money. Without
 * this an open pay link, which stays open for hours, would silence the
 * comparison for as long.
 */
export const QUOTE_CHECK_FRESH_MINUTES = 2;

/**
 * A delivery into a confidential account is credited by a job that runs every
 * 30 seconds. One still uncredited this long after it settled is not on its
 * way: it is overdue, and no longer explains a difference.
 */
export const CREDIT_DUE_MINUTES = 10;

/**
 * A quote that settled or a ledger row written this recently may not be in
 * the balances yet, or may be about to change them.
 */
export const RECENT_ACTIVITY_MINUTES = 5;

/**
 * The quotes whose delivery to a confidential account is credited to the
 * ledger when it succeeds. A `move_in` and a `fee_cover` also deliver there,
 * but they are not ledger entries.
 */
const CREDITED_DELIVERY_PURPOSES = [
  "fund_in",
  "invoice_payment",
  "fund_in_return",
  "from_treasury",
] as const satisfies readonly IntentQuotePurpose[];

/**
 * A company's ledger against what its company wallet, its transit wallet and
 * (when it keeps its USDC there) its confidential account hold. The ledger
 * is the single source of the balance; the chains and 1Click are what it is
 * checked against (docs/decisions/confidential-accounts.md).
 */
export interface BalanceReconciliation {
  readonly balanceHome: WalletBalanceHome;
  readonly ledgerUsdc: bigint;
  /** What the company wallet holds on NEAR now. */
  readonly nearUsdc: bigint | null;
  /** What the transit wallet holds on Base now. */
  readonly baseUsdc: bigint | null;
  /** Null unless the balance is kept in a confidential account, or it couldn't be read. */
  readonly confidentialUsdc: bigint | null;
  /**
   * Expendi's own USDC the records say sits in the company's wallets: the
   * surplus in the company wallet plus the float in the confidential account.
   * Negative when sweeps and hops cost more than the float held.
   */
  readonly expendiSurplusUsdc: bigint;
  /** The part of it in the company wallet, which a move-in leaves there. */
  readonly companyWalletSurplusUsdc: bigint;
  /** What is held less the ledger; null if any balance that counts couldn't be read. */
  readonly differenceUsdc: bigint | null;
  /** Reasons the two can legitimately differ right now. */
  readonly inFlight: readonly string[];
  /**
   * Quotes 1Click reports delivered to the confidential account that the
   * ledger still doesn't hold, more than `CREDIT_DUE_MINUTES` after they
   * settled. They explain nothing: someone has to look.
   */
  readonly overdueCredits: readonly string[];
  /** Whether a quote settled or a ledger row was written in the last 5 minutes. */
  readonly recentActivity: boolean;
  readonly errors: readonly string[];
}

interface OpenQuote {
  readonly settledRecently: boolean;
  readonly purpose: IntentQuotePurpose;
  readonly status: string;
  readonly recipientType: string;
  readonly depositType: string;
  readonly oneClickStatus: string | null;
  readonly checkedRecently: boolean;
}

/**
 * Why this quote may leave the balances out of step with the ledger right
 * now, or null if it can't. A quote's own columns decide, never the
 * company's current `balance_home`. A quote paid out of the confidential
 * account moves nothing until its message is signed, so it is in flight only
 * once its deposit has started.
 */
function quoteInFlightReason(quote: OpenQuote): string | null {
  const { purpose, status } = quote;
  if (quote.depositType === "CONFIDENTIAL_INTENTS") {
    return status === "depositing" || status === "needs_review"
      ? `a ${purpose} quote paid out of the confidential account is ${status}`
      : null;
  }
  if (quote.recipientType !== "CONFIDENTIAL_INTENTS") {
    return status === "quoted" || status === "depositing"
      ? `a ${purpose} quote is ${status}`
      : null;
  }
  if (purpose === "move_in" || purpose === "fee_cover") {
    return status === "depositing" || status === "needs_review"
      ? `a ${purpose} quote is ${status}`
      : null;
  }
  switch (status) {
    case "depositing":
    case "needs_review":
      return `a ${purpose} quote to the confidential account is ${status}`;
    case "succeeded":
      return quote.settledRecently
        ? `a ${purpose} quote was delivered to the confidential account and isn't credited yet`
        : null;
    case "quoted":
      return quote.oneClickStatus === "PENDING_DEPOSIT" && quote.checkedRecently
        ? null
        : `a ${purpose} quote to the confidential account may have received a deposit`;
    default:
      return null;
  }
}

/**
 * Reads the company's wallet, then every balance that counts toward its
 * ledger, and only then, in one snapshot, the ledger and what may explain a
 * difference. Null when the company has no active company wallet. A balance
 * that can't be read is named in `errors` and leaves `differenceUsdc` null;
 * a company that keeps its USDC in the company wallet costs no sign-in and no
 * confidential read.
 *
 * The order matters. Whatever moves money between the balances and the
 * ledger (a move-in starting, a delivery settling, a credit being written)
 * does so while the balances are being read. Read last, the snapshot shows
 * it as in flight or as recent activity, so a difference it causes is never
 * reported as a mismatch. Read first, a move-in that began in between would
 * show a shortfall that nothing in the snapshot explains.
 *
 * `now` only sets the window of `recentActivity`.
 */
export function reconcileBalances(
  organizationId: string,
  now: Date = new Date(),
): Effect.Effect<
  BalanceReconciliation | null,
  DatabaseError,
  DatabaseService | NearRpc | BaseRpc | ConfidentialAccounts
> {
  return Effect.gen(function* () {
    const wallet = yield* readWallet(organizationId);
    if (wallet === null) return null;

    const errors: string[] = [];
    const nearUsdc = wallet.address
      ? yield* NearRpc.pipe(
          Effect.flatMap((rpc) => rpc.usdcBalance(wallet.address ?? "")),
          Effect.catchAll((error) => {
            errors.push(`NEAR balance not read: ${error.message}`);
            return Effect.succeed(null);
          }),
        )
      : null;
    const baseUsdc = wallet.transitAddress
      ? yield* baseUsdcBalance(wallet.transitAddress).pipe(
          Effect.catchAll((error) => {
            errors.push(`Base balance not read: ${error.message}`);
            return Effect.succeed(null);
          }),
        )
      : null;
    const keepsConfidentialAccount =
      wallet.balanceHome === "confidential_account";
    const confidentialUsdc =
      keepsConfidentialAccount && wallet.privyWalletId && wallet.address
        ? yield* ConfidentialAccounts.pipe(
            Effect.flatMap((accounts) =>
              accounts.usdcBalance({
                privyWalletId: wallet.privyWalletId ?? "",
                accountId: wallet.address ?? "",
              }),
            ),
            Effect.catchAll((error) => {
              errors.push(
                `Confidential account balance not read: ${error.message}`,
              );
              return Effect.succeed(null);
            }),
          )
        : null;

    const records = yield* readRecords(wallet.id, organizationId, now);
    const unreadable =
      nearUsdc === null ||
      baseUsdc === null ||
      (keepsConfidentialAccount && confidentialUsdc === null);
    return {
      balanceHome: wallet.balanceHome,
      ledgerUsdc: records.ledger,
      nearUsdc,
      baseUsdc,
      confidentialUsdc,
      expendiSurplusUsdc:
        records.companyWalletSurplus + records.confidentialSurplus,
      companyWalletSurplusUsdc: records.companyWalletSurplus,
      differenceUsdc: unreadable
        ? null
        : nearUsdc + baseUsdc + (confidentialUsdc ?? 0n) - records.ledger,
      inFlight: records.inFlight,
      overdueCredits: records.overdueCredits,
      recentActivity: records.recentActivity,
      errors,
    };
  });
}

function readWallet(organizationId: string) {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(wallets)
        .where(
          and(
            eq(wallets.organizationId, organizationId),
            eq(wallets.status, "active"),
          ),
        ),
    ).pipe(Effect.map(([wallet]) => wallet ?? null)),
  );
}

/** Everything that can explain a difference, in one transaction. */
function readRecords(walletId: string, organizationId: string, now: Date) {
  const activeSince = new Date(
    now.getTime() - RECENT_ACTIVITY_MINUTES * 60_000,
  );
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const quotes = yield* query(() =>
        tx
          .select({
            id: intentQuotes.id,
            purpose: intentQuotes.purpose,
            status: intentQuotes.status,
            recipientType: intentQuotes.recipientType,
            depositType: intentQuotes.depositType,
            oneClickStatus: intentQuotes.oneClickStatus,
            checkedRecently: sql<boolean>`coalesce(${intentQuotes.oneClickCheckedAt} > now() - make_interval(mins => ${QUOTE_CHECK_FRESH_MINUTES}), false)`,
            settledRecently: sql<boolean>`coalesce(${intentQuotes.settledAt} > now() - make_interval(mins => ${CREDIT_DUE_MINUTES}), false)`,
          })
          .from(intentQuotes)
          .where(
            and(
              eq(intentQuotes.walletId, walletId),
              or(
                inArray(intentQuotes.status, [
                  "quoted",
                  "depositing",
                  "needs_review",
                ]),
                and(
                  eq(intentQuotes.status, "succeeded"),
                  eq(intentQuotes.recipientType, "CONFIDENTIAL_INTENTS"),
                  inArray(intentQuotes.purpose, [
                    ...CREDITED_DELIVERY_PURPOSES,
                  ]),
                  isNull(intentQuotes.ledgerCreditedAt),
                ),
              ),
            ),
          ),
      );
      const sends = yield* query(() =>
        tx
          .select({ id: companyWalletSends.id })
          .from(companyWalletSends)
          .where(
            and(
              eq(companyWalletSends.walletId, walletId),
              inArray(companyWalletSends.status, ["reserved", "signed"]),
            ),
          ),
      );
      const funding = yield* query(() =>
        tx
          .select({ id: payouts.id })
          .from(payouts)
          .where(
            and(eq(payouts.walletId, walletId), eq(payouts.status, "funding")),
          ),
      );
      const recentMoves = yield* query(() =>
        tx
          .select({ id: treasuryMoves.id, status: treasuryMoves.status })
          .from(treasuryMoves)
          .where(
            and(
              eq(treasuryMoves.walletId, walletId),
              or(
                inArray(treasuryMoves.status, ["open", "needs_review"]),
                gt(
                  treasuryMoves.settledAt,
                  sql`now() - make_interval(mins => ${CREDIT_WINDOW_MINUTES})`,
                ),
              ),
            ),
          ),
      );
      const [settled] = yield* query(() =>
        tx
          .select({ id: intentQuotes.id })
          .from(intentQuotes)
          .where(
            and(
              eq(intentQuotes.walletId, walletId),
              gt(intentQuotes.settledAt, activeSince),
            ),
          )
          .limit(1),
      );
      const [written] = yield* query(() =>
        tx
          .select({ id: walletTransactions.id })
          .from(walletTransactions)
          .where(
            and(
              eq(walletTransactions.walletId, walletId),
              gt(walletTransactions.createdAt, activeSince),
            ),
          )
          .limit(1),
      );
      return {
        ledger: yield* ledgerBalance(tx, walletId),
        companyWalletSurplus: yield* recordedExpendiSurplus(tx, walletId),
        confidentialSurplus: yield* recordedExpendiSurplus(
          tx,
          walletId,
          undefined,
          "confidential_account",
        ),
        inFlight: [
          ...quotes.flatMap((quote) => quoteInFlightReason(quote) ?? []),
          ...sends.map(() => "a company wallet send is not final"),
          ...funding.map(() => "a payout is being funded"),
          ...recentMoves.map((move) =>
            move.status === "open" || move.status === "needs_review"
              ? `a Treasury move is ${move.status}`
              : `a Treasury move settled in the last ${CREDIT_WINDOW_MINUTES} minutes`,
          ),
        ],
        overdueCredits: quotes
          .filter(
            (quote) =>
              quote.status === "succeeded" &&
              quote.recipientType === "CONFIDENTIAL_INTENTS" &&
              !quote.settledRecently,
          )
          .map((quote) => quote.id),
        recentActivity: settled !== undefined || written !== undefined,
      };
    }),
  );
}
