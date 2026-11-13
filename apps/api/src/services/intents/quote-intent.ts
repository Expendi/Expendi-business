import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";

import type { IntentQuote } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { NearSigningWallet } from "../wallet/privy-wallets.js";
import type { FeeCoverDeps } from "./fee-cover.js";
import type { OneClickSession, OneClickSignedIntent } from "./one-click.js";
import type { DepositGate } from "./quote-deposit.js";
import { DatabaseService } from "../../db/client.js";
import { intentQuotes, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { ConfidentialAccounts } from "./confidential-account.js";
import { recordedExpendiSurplus } from "./expendi-surplus.js";
import { OneClick } from "./one-click.js";
import {
  DEPOSIT_MARGIN_MS,
  moveQuote,
  orCurrent,
  quoteById,
  settleFromOneClick,
} from "./quote-settle.js";

/**
 * Paying a NEAR Intents quote out of the company's confidential account
 * (docs/decisions/confidential-accounts.md, "Signing"). Nothing moves on
 * chain: 1Click writes a message that transfers the quote's amount in to its
 * deposit address, the company wallet's key signs it, and 1Click runs it.
 * Privy checks nothing about what is signed, so the quote's own row carries
 * what a company wallet send's row does for an on-chain deposit:
 *
 * 1. the message is signed by `ConfidentialAccounts.signIntent`, the only
 *    thing that asks Privy to sign, and saved on the row (`signed_intent`,
 *    `intent_deadline`) before anything is submitted;
 * 2. `intent_submitted_at` is set before the saved bytes go to 1Click, and
 *    `intent_hash` is saved from its answer;
 * 3. 1Click's status settles the quote.
 *
 * A retry submits the saved bytes and never asks Privy to sign again. This
 * file is not reachable from staff code (`internal-routes.test.ts`).
 */

/**
 * What a quote's steps need, with what the fee cover gate needs on top
 * (today the database, which every step reads too).
 */
export type IntentQuoteDeps = OneClick | ConfidentialAccounts | FeeCoverDeps;

/** Whether a quote is paid out of a confidential account, by a signed message. */
export const isIntentPaid = (q: Pick<IntentQuote, "depositType">): boolean =>
  q.depositType === "CONFIDENTIAL_INTENTS";

/** Distinguishes the per-quote signing lock from every other advisory lock. */
const SIGN_LOCK_CLASS = 72_060;

/**
 * How long past its own deadline a signed message that 1Click still shows
 * unpaid is left, so a late run of it can't be mistaken for one that never
 * ran.
 */
const MESSAGE_DEADLINE_GRACE_MS = 5 * 60_000;

const SIGNED_INTENT = z.strictObject({
  standard: z.literal("nep413"),
  payload: z.strictObject({
    message: z.string(),
    nonce: z.string(),
    recipient: z.string(),
  }),
  public_key: z.string(),
  signature: z.string(),
});

const FEE_COVERED_PURPOSES: readonly IntentQuote["purpose"][] = [
  "base_hop",
  "usdc_payout",
];

interface CompanyWallet {
  readonly company: NearSigningWallet;
  readonly spendCap: bigint;
}

/**
 * The company wallet that pays `quote`, read as it is now. Null unless it is
 * active, is the account the quote refunds to and can sign.
 */
const companyWalletFor = (
  quote: IntentQuote,
): Effect.Effect<CompanyWallet | null, DatabaseError, DatabaseService> =>
  withScope({ organizationId: quote.organizationId }, (tx) =>
    query(() =>
      tx
        .select({
          status: wallets.status,
          address: wallets.address,
          privyWalletId: wallets.privyWalletId,
          perTransactionMaxUsdc: wallets.perTransactionMaxUsdc,
        })
        .from(wallets)
        .where(eq(wallets.id, quote.walletId))
        .limit(1),
    ),
  ).pipe(
    Effect.map(([wallet]) =>
      wallet?.status === "active" &&
      wallet.address === quote.refundTo &&
      wallet.privyWalletId !== null
        ? {
            company: {
              privyWalletId: wallet.privyWalletId,
              accountId: wallet.address,
            },
            spendCap: wallet.perTransactionMaxUsdc,
          }
        : null,
    ),
  );

/**
 * What the wallet's other quotes paid out of the account are still to take
 * from it: those the account may not have been debited for yet.
 */
const takenByOthers = (
  tx: Transaction,
  quote: IntentQuote,
): Effect.Effect<bigint, DatabaseError> =>
  query(() =>
    tx
      .select({
        total: sql<string>`coalesce(sum(${intentQuotes.amountIn}), 0)::text`,
      })
      .from(intentQuotes)
      .where(
        and(
          eq(intentQuotes.walletId, quote.walletId),
          eq(intentQuotes.depositType, "CONFIDENTIAL_INTENTS"),
          inArray(intentQuotes.status, ["depositing", "needs_review"]),
          ne(intentQuotes.id, quote.id),
        ),
      ),
  ).pipe(Effect.map(([row]) => BigInt(row?.total ?? "0")));

/**
 * Runs `work` as the only signer of this quote, here or in any other API
 * instance, or returns null at once if another already is: a request and the
 * job must never both ask Privy to sign for one quote.
 */
function asOnlySigner<A, E, R>(
  quoteId: string,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A | null, E, R | DatabaseService> {
  return Effect.scoped(
    Effect.gen(function* () {
      const { pool } = yield* DatabaseService;
      const client = yield* Effect.acquireRelease(
        Effect.promise(() => pool.connect()),
        (connection) => Effect.sync(() => connection.release()),
      );
      const { rows } = yield* Effect.promise(() =>
        client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked",
          [SIGN_LOCK_CLASS, quoteId],
        ),
      );
      if (!rows[0]?.locked) return null;
      return yield* work.pipe(
        Effect.ensuring(
          Effect.promise(() =>
            client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
              SIGN_LOCK_CLASS,
              quoteId,
            ]),
          ),
        ),
      );
    }),
  );
}

/**
 * Moves a saved quote that is paid out of a confidential account as far as
 * it can go right now and returns it as it then stands. Safe to call at any
 * time, any number of times, from any process: each call reads the row and
 * does only the next step that hasn't been done.
 *
 * `beforeDeposit` is asked immediately before the row records that the
 * deposit is starting, as for a quote paid on chain. `ensureFeeCover` is
 * asked first for a quote whose cost Expendi covers.
 *
 * What each failure leaves behind:
 * - the deadline too close before anything started: `expired`, nothing moved;
 * - the fee cover or the balance not there yet: unchanged;
 * - the deadline too close before anything was signed: `failed`, nothing
 *   moved;
 * - 1Click can't generate the message, or Privy can't say: unchanged, the
 *   next call tries again;
 * - a message that fails `checkCompanyIntent`, or Privy refusing: `failed`,
 *   nothing was signed;
 * - a message signed and saved: submitted again, the same bytes, on every
 *   call until 1Click has taken it or the deadline is too close;
 * - 1Click `SUCCESS` or `REFUNDED`: settled, `FAILED` or silence long past
 *   the deadline: `needs_review`, as for a quote paid on chain;
 * - the signed message's own deadline long past with 1Click still waiting
 *   for its deposit: `failed`. Nothing moved, and the message is dead.
 */
export function advanceIntentQuote<R>(input: {
  readonly quote: IntentQuote;
  readonly session: OneClickSession;
  readonly beforeDeposit: (
    quote: IntentQuote,
  ) => Effect.Effect<DepositGate, DatabaseError, R>;
  readonly ensureFeeCover: (
    quote: IntentQuote,
  ) => Effect.Effect<"covered" | "waiting", DatabaseError, IntentQuoteDeps>;
}): Effect.Effect<IntentQuote, DatabaseError, IntentQuoteDeps | R> {
  const { session } = input;

  return Effect.gen(function* () {
    let quote = yield* quoteById(input.quote.organizationId, input.quote.id);
    if (!isIntentPaid(quote)) {
      return yield* Effect.dieMessage(
        `quote ${quote.id} isn't paid out of a confidential account`,
      );
    }
    const current = () => quoteById(quote.organizationId, quote.id);

    if (quote.status === "quoted") {
      const started = yield* startDeposit(quote);
      if (started === null) return yield* current();
      quote = started;
    }

    if (quote.status === "depositing" && quote.signedIntent === null) {
      const signed = yield* asOnlySigner(quote.id, signAndSave(quote));
      quote = signed ?? (yield* current());
    }

    if (
      quote.status === "depositing" &&
      quote.signedIntent !== null &&
      quote.intentHash === null
    ) {
      quote = yield* submitSaved(quote);
    }

    if (quote.signedIntent === null) return quote;
    return yield* settle(quote);
  });

  /** S0 to S1: everything that must hold before a message is asked for. */
  function startDeposit(quote: IntentQuote) {
    return Effect.gen(function* () {
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
          "The quote's deadline came before the deposit could start. Nothing moved.",
        );
      }

      if (
        FEE_COVERED_PURPOSES.includes(quote.purpose) &&
        (yield* input.ensureFeeCover(quote)) === "waiting"
      ) {
        return null;
      }

      const wallet = yield* companyWalletFor(quote);
      if (wallet === null) return null;
      const accounts = yield* ConfidentialAccounts;
      const read = yield* accounts
        .usdcBalance(wallet.company)
        .pipe(Effect.either);
      if (read._tag === "Left") {
        console.warn(
          `[intents] couldn't read the balance for quote ${quote.id}; left as it is`,
          read.left.message,
        );
        return null;
      }
      const balance = read.right;
      const inFlight = yield* withScope(
        { organizationId: quote.organizationId },
        (tx) => takenByOthers(tx, quote),
      );
      if (balance < quote.amountIn + inFlight) return null;

      const gate = yield* input.beforeDeposit(quote);
      if (gate.kind === "abandon") return yield* expire(gate.reason);

      return yield* withScope({ organizationId: quote.organizationId }, (tx) =>
        Effect.gen(function* () {
          yield* query(() =>
            tx
              .select({ id: wallets.id })
              .from(wallets)
              .where(eq(wallets.id, quote.walletId))
              .for("update"),
          );
          const others = yield* takenByOthers(tx, quote);
          if (balance < quote.amountIn + others) return null;
          const cost = quote.amountIn - quote.amountOut;
          if (FEE_COVERED_PURPOSES.includes(quote.purpose) && cost > 0n) {
            const float = yield* recordedExpendiSurplus(
              tx,
              quote.walletId,
              quote.id,
              "confidential_account",
            );
            if (float < cost) return null;
          }
          const [row] = yield* query(() =>
            tx
              .update(intentQuotes)
              .set({ status: "depositing", depositStartedAt: new Date() })
              .where(and(eq(intentQuotes.id, quote.id), untouched))
              .returning(),
          );
          return row ?? null;
        }),
      );
    });
  }

  /**
   * S1 to S2: generates the message, has it signed and saves it. Returns the
   * quote as it then stands; the caller holds the quote's signing lock.
   */
  function signAndSave(quote: IntentQuote) {
    return Effect.gen(function* () {
      const unsigned = yield* quoteById(quote.organizationId, quote.id);
      if (unsigned.status !== "depositing" || unsigned.signedIntent !== null) {
        return unsigned;
      }
      const nothingSigned = and(
        eq(intentQuotes.status, "depositing"),
        isNull(intentQuotes.signedIntent),
      );
      const failNothingSigned = (failure: string) =>
        moveQuote(unsigned, nothingSigned, {
          status: "failed",
          settledAt: new Date(),
          failure,
        }).pipe(Effect.flatMap((moved) => orCurrent(unsigned, moved)));

      if (unsigned.deadline.getTime() - Date.now() < DEPOSIT_MARGIN_MS) {
        return yield* failNothingSigned(
          "No message was signed before the quote's deadline. Nothing moved.",
        );
      }

      const oneClick = yield* OneClick;
      const generated = yield* oneClick
        .generateIntent(
          {
            depositAddress: unsigned.depositAddress,
            signerId: unsigned.refundTo,
          },
          session,
        )
        .pipe(Effect.either);
      if (generated._tag === "Left") {
        console.warn(
          `[intents] 1Click didn't generate the message for quote ${unsigned.id}; left as it is`,
          generated.left.message,
        );
        return unsigned;
      }

      const wallet = yield* companyWalletFor(unsigned);
      if (wallet === null) {
        console.warn(
          `[intents] the company wallet for quote ${unsigned.id} isn't the one it was quoted for, or can't sign; left as it is`,
        );
        return unsigned;
      }

      const accounts = yield* ConfidentialAccounts;
      const signed = yield* accounts
        .signIntent({
          company: wallet.company,
          unsigned: generated.right,
          depositAddress: unsigned.depositAddress,
          amountIn: unsigned.amountIn,
          spendCap: wallet.spendCap,
        })
        .pipe(Effect.either);
      if (signed._tag === "Left") {
        const refusal = signed.left;
        if (
          refusal._tag === "CompanyIntentRefused" ||
          refusal._tag === "SendRefused"
        ) {
          console.error(
            `[intents] nothing was signed for quote ${unsigned.id}`,
            refusal._tag,
            refusal._tag === "CompanyIntentRefused"
              ? refusal.reason
              : refusal.message,
          );
          const why =
            refusal._tag === "CompanyIntentRefused"
              ? "1Click's message was refused"
              : "The company wallet refused to sign";
          return yield* failNothingSigned(
            `${why} (${refusal.message}). Nothing was signed, nothing moved.`,
          );
        }
        console.warn(
          `[intents] couldn't tell whether the message for quote ${unsigned.id} was signed; left as it is`,
          refusal.message,
        );
        return unsigned;
      }

      const saved = yield* moveQuote(unsigned, nothingSigned, {
        signedIntent: signed.right.signed,
        intentDeadline: signed.right.deadline,
      });
      return yield* orCurrent(unsigned, saved);
    });
  }

  /** S2 to S3: submits the bytes saved on the row, never a new signature. */
  function submitSaved(quote: IntentQuote) {
    return Effect.gen(function* () {
      if (quote.deadline.getTime() - Date.now() < DEPOSIT_MARGIN_MS) {
        return quote;
      }
      const parsed = SIGNED_INTENT.safeParse(quote.signedIntent);
      if (!parsed.success) {
        return yield* Effect.dieMessage(
          `the saved message of quote ${quote.id} is not a signed intent`,
        );
      }
      const saved: OneClickSignedIntent = parsed.data;
      const accepting = and(
        eq(intentQuotes.status, "depositing"),
        isNotNull(intentQuotes.signedIntent),
        isNull(intentQuotes.intentHash),
      );

      if (quote.intentSubmittedAt === null) {
        const marked = yield* moveQuote(
          quote,
          and(accepting, isNull(intentQuotes.intentSubmittedAt)),
          { intentSubmittedAt: new Date() },
        );
        if (marked === null)
          return yield* quoteById(quote.organizationId, quote.id);
        quote = marked;
      }

      const oneClick = yield* OneClick;
      const submitted = yield* oneClick
        .submitIntent(saved, session)
        .pipe(Effect.either);
      if (submitted._tag === "Right") {
        return yield* orCurrent(
          quote,
          yield* moveQuote(quote, accepting, {
            intentHash: submitted.right.intentHash,
            failure: null,
          }),
        );
      }
      console.warn(
        `[intents] the saved message of quote ${quote.id} wasn't accepted yet (${submitted.left._tag}); it is submitted again`,
        submitted.left.message,
      );
      if (submitted.left._tag === "OneClickRefused") {
        return yield* orCurrent(
          quote,
          yield* moveQuote(quote, accepting, {
            failure: `1Click refused the signed message: ${submitted.left.message}`,
          }),
        );
      }
      return quote;
    });
  }

  /**
   * Settles from 1Click's status as for any quote Expendi pays itself, then
   * applies the one rule that only a signed message has: past its own
   * deadline and still waiting for its deposit, it can never run.
   */
  function settle(quote: IntentQuote) {
    return Effect.gen(function* () {
      const settled = yield* settleFromOneClick(quote, session);
      const heardNow =
        settled.oneClickCheckedAt !== null &&
        settled.oneClickCheckedAt.getTime() !==
          quote.oneClickCheckedAt?.getTime();
      if (
        (settled.status === "depositing" ||
          settled.status === "needs_review") &&
        settled.intentDeadline !== null &&
        Date.now() >
          settled.intentDeadline.getTime() + MESSAGE_DEADLINE_GRACE_MS &&
        heardNow &&
        settled.oneClickStatus === "PENDING_DEPOSIT" &&
        settled.depositedAmount === null
      ) {
        return yield* orCurrent(
          settled,
          yield* moveQuote(
            settled,
            and(
              inArray(intentQuotes.status, ["depositing", "needs_review"]),
              isNotNull(intentQuotes.signedIntent),
            ),
            {
              status: "failed",
              settledAt: new Date(),
              failure: "The signed message expired unused. Nothing moved.",
            },
          ),
        );
      }
      return settled;
    });
  }
}
