import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import {
  intentQuotes,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { isImplicitNearAccount } from "../chain/near.js";
import { sessionForQuote } from "./company-session.js";
import { ConfidentialAccounts } from "./confidential-account.js";
import { recordedExpendiSurplus } from "./expendi-surplus.js";
import { ONE_CLICK_USDC_ASSET_IDS, OneClick } from "./one-click.js";
import { advanceCompanyQuote, COMPANY_QUOTE_TTL_MS } from "./quote-deposit.js";

/**
 * A durable turn-off. New quote/send/payout admission is fenced by the
 * wallet's transition flag. One free, capped quote at a time moves the whole
 * balance, including Expendi's float, back to the same public NEAR account.
 * No ledger entry: the deposit watcher recognises move_out as internal.
 */
export function moveOut(organizationId: string) {
  return Effect.gen(function* () {
    const [wallet] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select()
          .from(wallets)
          .where(eq(wallets.organizationId, organizationId)),
      ),
    );
    if (
      !wallet?.balanceHomeChanging ||
      wallet.balanceHome !== "confidential_account" ||
      !wallet.address ||
      !wallet.privyWalletId
    )
      return null;
    const address = wallet.address;

    const [open] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select()
          .from(intentQuotes)
          .where(
            and(
              eq(intentQuotes.walletId, wallet.id),
              eq(intentQuotes.purpose, "move_out"),
              inArray(intentQuotes.status, [
                ...UNSETTLED_INTENT_QUOTE_STATUSES,
              ]),
            ),
          ),
      ),
    );
    const advance = (quote: typeof intentQuotes.$inferSelect) =>
      Effect.gen(function* () {
        const session = yield* sessionForQuote(quote).pipe(Effect.either);
        if (session._tag === "Left") return quote;
        return yield* advanceCompanyQuote({
          quote,
          session: session.right,
          beforeDeposit: () =>
            withScope({ organizationId }, (tx) =>
              query(() =>
                tx
                  .select({ changing: wallets.balanceHomeChanging })
                  .from(wallets)
                  .where(eq(wallets.id, wallet.id)),
              ),
            ).pipe(
              Effect.map(([current]) =>
                current?.changing
                  ? { kind: "go" as const }
                  : {
                      kind: "abandon" as const,
                      reason:
                        "The move-out is no longer requested. Nothing moved.",
                    },
              ),
            ),
        });
      });
    if (open) return yield* advance(open);

    const accounts = yield* ConfidentialAccounts;
    const company = {
      accountId: wallet.address,
      privyWalletId: wallet.privyWalletId,
    };
    const balance = yield* accounts.usdcBalance(company).pipe(Effect.either);
    if (balance._tag === "Left") return null;
    if (balance.right === 0n) {
      yield* withScope({ organizationId }, (tx) =>
        Effect.gen(function* () {
          const [current] = yield* query(() =>
            tx
              .select()
              .from(wallets)
              .where(eq(wallets.id, wallet.id))
              .for("update"),
          );
          if (!current?.balanceHomeChanging) return;
          const [pending] = yield* query(() =>
            tx
              .select({ id: intentQuotes.id })
              .from(intentQuotes)
              .where(
                and(
                  eq(intentQuotes.walletId, wallet.id),
                  inArray(intentQuotes.status, [
                    ...UNSETTLED_INTENT_QUOTE_STATUSES,
                  ]),
                ),
              ),
          );
          if (pending) return;
          // Re-read under the lock; stale zero must never complete a drain.
          const held = yield* accounts.usdcBalance(company).pipe(Effect.either);
          if (held._tag === "Left" || held.right !== 0n) return;
          const float = yield* recordedExpendiSurplus(
            tx,
            wallet.id,
            undefined,
            "confidential_account",
          );
          // The account is empty and nothing is in flight, so any float still
          // recorded isn't there. Waiting would keep the company's payments
          // paused for good: write it off, finish, and say so loudly.
          if (float !== 0n) {
            console.error(
              `[move-out] ${organizationId}: the emptied confidential account was ${float} base units short of the recorded fee float; written off`,
            );
          }
          yield* query(() =>
            tx
              .update(wallets)
              .set({
                balanceHome: "company_wallet",
                balanceHomeChanging: false,
                balanceHomeChangedAt: new Date(),
                confidentialUsdc: 0n,
                confidentialUsdcReadAt: new Date(),
                confidentialFloatWrittenOffUsdc:
                  current.confidentialFloatWrittenOffUsdc + float,
              })
              .where(eq(wallets.id, wallet.id)),
          );
          const audit = yield* AuditLog;
          yield* audit.record(tx, {
            actor: { type: "system", id: "move-out" },
            organizationId,
            action: "wallet.balance_home_changed",
            entity: { type: "wallet", id: wallet.id },
            before: { balanceHome: "confidential_account" },
            after: {
              balanceHome: "company_wallet",
              ...(float !== 0n ? { floatWrittenOffUsdc: float } : {}),
            },
          });
        }),
      );
      return null;
    }
    // Even parts avoid a tiny remainder. If the provider refuses dust, keep
    // the transition pending and visible; never pretend the account is empty.
    const parts =
      (balance.right + wallet.perTransactionMaxUsdc - 1n) /
      wallet.perTransactionMaxUsdc;
    const amount = (balance.right + parts - 1n) / parts;
    const session = yield* accounts.session(company).pipe(Effect.either);
    if (session._tag === "Left") return null;
    const oneClick = yield* OneClick;
    const quoted = yield* oneClick
      .quote(
        {
          dry: false,
          swapType: "EXACT_INPUT",
          originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
          destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
          amount,
          depositType: "CONFIDENTIAL_INTENTS",
          recipient: wallet.address,
          recipientType: "DESTINATION_CHAIN",
          refundTo: wallet.address,
          refundType: "CONFIDENTIAL_INTENTS",
          deadline: new Date(Date.now() + COMPANY_QUOTE_TTL_MS),
          slippageBps: 0,
        },
        session.right,
      )
      .pipe(Effect.either);
    if (quoted._tag === "Left") return null;
    const q = quoted.right;
    if (
      q.dry ||
      q.depositMemo !== null ||
      !isImplicitNearAccount(q.depositAddress) ||
      q.depositAddress === wallet.address ||
      q.amountIn !== amount ||
      q.amountOut !== amount ||
      (q.minAmountOut !== null && q.minAmountOut !== amount)
    )
      return null;

    const saved = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [current] = yield* query(() =>
          tx
            .select()
            .from(wallets)
            .where(eq(wallets.id, wallet.id))
            .for("update"),
        );
        if (!current?.balanceHomeChanging) return null;
        const [previous] = yield* query(() =>
          tx
            .select()
            .from(intentQuotes)
            .where(
              and(
                eq(intentQuotes.walletId, wallet.id),
                eq(intentQuotes.purpose, "move_out"),
              ),
            )
            .orderBy(desc(intentQuotes.createdAt))
            .limit(1),
        );
        // The open-quote check is repeated under the lock; simultaneous ticks
        // may ask for quotes, but only one can ever be saved or signed.
        const [pending] = yield* query(() =>
          tx
            .select({ id: intentQuotes.id })
            .from(intentQuotes)
            .where(
              and(
                eq(intentQuotes.walletId, wallet.id),
                inArray(intentQuotes.status, [
                  ...UNSETTLED_INTENT_QUOTE_STATUSES,
                ]),
              ),
            ),
        );
        if (pending) return null;
        if (
          previous &&
          ["refunded", "failed", "expired"].includes(previous.status) &&
          previous.settledAt &&
          previous.settledAt.getTime() > Date.now() - 30 * 60_000
        )
          return null;
        const float = yield* recordedExpendiSurplus(
          tx,
          wallet.id,
          undefined,
          "confidential_account",
        );
        const movedSurplusUsdc =
          float <= 0n ? 0n : float < amount ? float : amount;
        const [row] = yield* query(() =>
          tx
            .insert(intentQuotes)
            .values({
              organizationId,
              walletId: wallet.id,
              purpose: "move_out",
              quoteKey: `move-out:${randomUUID()}`,
              swapType: "EXACT_INPUT",
              originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
              destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
              amountIn: amount,
              amountOut: amount,
              minAmountOut: q.minAmountOut,
              depositAddress: q.depositAddress,
              depositType: "CONFIDENTIAL_INTENTS",
              recipient: address,
              recipientType: "DESTINATION_CHAIN",
              refundTo: address,
              refundType: "CONFIDENTIAL_INTENTS",
              deadline: q.deadline,
              quoteResponse: q.signedResponse,
              movedSurplusUsdc,
            })
            .returning(),
        );
        if (!row)
          return yield* Effect.dieMessage("move-out insert returned no row");
        const audit = yield* AuditLog;
        yield* audit.record(tx, {
          actor: { type: "system", id: "move-out" },
          organizationId,
          action: "move_out.created",
          entity: { type: "intent_quote", id: row.id },
          after: { amount, movedSurplusUsdc },
        });
        return row;
      }),
    );
    return saved ? yield* advance(saved) : null;
  });
}
