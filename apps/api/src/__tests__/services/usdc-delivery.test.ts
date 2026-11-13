import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  organizations,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { approvePayouts } from "../../services/payout/approve.js";
import {
  continueDelivery,
  deliverUsdcPayout,
} from "../../services/payout/delivery.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { randomTxHash } from "../helpers/chain.js";
import { randomAddress, TEST_ORIGIN } from "../helpers/fakes.js";
import {
  createNearPayingCompany,
  makeNearPayoutWorld,
  readQuotes,
} from "../helpers/near-payouts.js";
import {
  allowlistAddress,
  ledgerBalance,
  payClaims,
  readPayout,
  USDC,
} from "../helpers/payouts.js";

const world = makeNearPayoutWorld();
const { runtime, near, oneClick } = world;
let db: Database;
let paying: NearPayingCompany;

const SOLANA_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const AMOUNT = 25n * USDC;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  paying = await createNearPayingCompany(world, db);
});

/** An approved USDC payout to an allowlisted payee, not funded yet. */
async function approved(
  chain: "base" | "solana",
  address: string,
): Promise<Payout> {
  await allowlistAddress(runtime, paying, address, "Supplier", chain);
  const prepared = await runtime.runPromise(
    preparePayouts({
      organizationId: paying.company.organizationId,
      actor: { type: "user", id: paying.company.admin.id },
      requests: [
        {
          subjectType: "bill",
          subjectId: randomUUID(),
          idempotencyKey: `bill:${randomUUID()}:1`,
          recipient: {
            method: "usdc",
            chain,
            address,
            accountName: "Supplier",
          },
          amountUsdc: AMOUNT,
        },
      ],
    }),
  );
  const approval = await runtime.runPromise(
    requestPayoutApproval({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      payoutIds: prepared.map((payout) => payout.id),
    }),
  );
  const [payout] = await runtime.runPromise(
    approvePayouts({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      challengeId: approval.challengeId,
      response: paying.passkey.sign(approval.options, TEST_ORIGIN),
    }),
  );
  if (!payout) throw new Error("nothing approved");
  return payout;
}

const deliver = (payout: Payout) =>
  runtime.runPromise(deliverUsdcPayout(payout));

const resume = (quote: IntentQuote) =>
  runtime.runPromise(continueDelivery(quote));

async function quoteOf(payout: Payout): Promise<IntentQuote> {
  const current = await readPayout(db, paying.company, payout.id);
  const quote = (await readQuotes(db, paying.company)).find(
    (one) => one.id === current.deliveryQuoteId,
  );
  if (!quote) throw new Error("the payout has no delivery quote");
  return quote;
}

const ledgerRows = () =>
  runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
    tx
      .select({
        type: walletTransactions.type,
        chain: walletTransactions.chain,
        usdcAmount: walletTransactions.usdcAmount,
        txHash: walletTransactions.txHash,
      })
      .from(walletTransactions)
      // Without it Postgres returns rows in heap order, which flips when the
      // debit and the refund were written by different connections.
      .orderBy(asc(walletTransactions.createdAt)),
  );

const companyUsdc = () => near.state.usdcBalanceOf(paying.accountId);

describe("a USDC payout to a payee on another chain", () => {
  const payees: readonly (readonly ["base" | "solana", () => string])[] = [
    ["base", randomAddress],
    ["solana", () => SOLANA_ADDRESS],
  ];

  it.each(payees)(
    "is delivered to a %s address through a quote paid by the company wallet",
    async (chain, addressOf) => {
      // #given an approved 25 USDC payout to an allowlisted payee
      const address = addressOf();
      const payout = await approved(chain, address);

      // #when it is funded
      const sent = await deliver(payout);

      // #then the company wallet paid a quote that delivers exactly the
      // approved USDC to the payee, the relayer covered the rest, and the
      // ledger was debited the approved amount once the deposit ran
      const quote = await quoteOf(payout);
      expect({
        payout: {
          status: sent.status,
          txHash: sent.txHash,
          to: sent.depositAddress,
        },
        quote: {
          purpose: quote.purpose,
          status: quote.status,
          amountOut: quote.amountOut,
          recipient: quote.recipient,
          refundTo: quote.refundTo,
          feeCover: quote.feeCoverUsdc,
        },
        depositAddressHolds: near.state.usdcBalanceOf(quote.depositAddress),
        companyHolds: companyUsdc(),
        ledger: await ledgerBalance(db, paying.company),
      }).toEqual({
        payout: { status: "paying", txHash: quote.depositTxHash, to: address },
        quote: {
          purpose: "usdc_payout",
          status: "depositing",
          amountOut: AMOUNT,
          recipient: address,
          refundTo: paying.accountId,
          feeCover: quote.amountIn - AMOUNT,
        },
        depositAddressHolds: quote.amountIn,
        companyHolds: 100n * USDC - AMOUNT,
        ledger: 100n * USDC - AMOUNT,
      });

      // #when 1Click reports the delivery on the payee chain
      const destinationTx = chain === "base" ? randomTxHash() : "5VERv8NMvz";
      oneClick.state.setStatus(quote.depositAddress, {
        status: "SUCCESS",
        amountOut: AMOUNT,
        destinationChainTxHashes: [destinationTx],
      });
      const paid = await resume(quote);

      // #then the payout is paid, with that transaction as its reference
      expect({
        status: paid?.status,
        reference: paid?.providerReference,
        ledger: await ledgerBalance(db, paying.company),
      }).toEqual({
        status: "paid",
        reference: destinationTx,
        ledger: 100n * USDC - AMOUNT,
      });
    },
  );

  it("is started by Approve & pay, through the payout engine", async () => {
    // #given an allowlisted Base payee
    const address = randomAddress();
    await allowlistAddress(runtime, paying, address, "Supplier", "base");

    // #when the admin approves and pays a 25 USDC bill to it
    const [payout] = await payClaims(runtime, db, paying, [
      {
        subjectType: "bill",
        subjectId: randomUUID(),
        idempotencyKey: `bill:${randomUUID()}:1`,
        recipient: {
          method: "usdc",
          chain: "base",
          address,
          accountName: "Supplier",
        },
        amountUsdc: AMOUNT,
      },
    ]);
    if (!payout) throw new Error("no payout");

    // #then the engine delivered it through a quote of its own
    const quote = await quoteOf(payout);
    expect({
      status: payout.status,
      quoteKey: quote.quoteKey,
      recipient: quote.recipient,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "paying",
      quoteKey: `delivery:${payout.id}`,
      recipient: address,
      ledger: 100n * USDC - AMOUNT,
    });
  });

  it("fails with nothing sent when 1Click refuses the quote", async () => {
    // #given 1Click refusing quotes
    const payout = await approved("base", randomAddress());
    oneClick.state.failNextQuotes("refused");

    // #when it is funded
    const failed = await deliver(payout);

    // #then no quote exists and nothing left the wallet or the ledger
    expect({
      status: failed.status,
      quote: failed.deliveryQuoteId,
      companyHolds: companyUsdc(),
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "failed",
      quote: null,
      companyHolds: 100n * USDC,
      ledger: 100n * USDC,
    });
  });

  it("fails with nothing sent when the company wallet's send is refused", async () => {
    // #given a company wallet that holds too little on chain
    const payout = await approved("base", randomAddress());
    near.state.balances.set(paying.accountId, 1n * USDC);

    // #when it is funded
    const failed = await deliver(payout);

    // #then the quote and the payout failed and the ledger wasn't debited
    const quote = await quoteOf(payout);
    expect({
      quote: quote.status,
      status: failed.status,
      reason: failed.failureReason,
      depositAddressHolds: near.state.usdcBalanceOf(quote.depositAddress),
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      quote: "failed",
      status: "failed",
      reason: expect.stringContaining("Nothing was sent.") as string,
      depositAddressHolds: 0n,
      ledger: 100n * USDC,
    });
  });

  it("doesn't deposit once payouts are paused", async () => {
    // #given a saved quote whose deposit hasn't started, then a pause
    const payout = await approved("base", randomAddress());
    near.state.failNext("usdcStorageRegistered");
    const waiting = await deliver(payout);
    expect(waiting.status).toBe("approved");
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .update(organizations)
          .set({ payoutsPaused: true })
          .where(eq(organizations.id, paying.company.organizationId)),
    );

    // #when the job resumes it
    const quote = await quoteOf(payout);
    const failed = await resume(quote);

    // #then nothing was deposited and the payout failed
    expect({
      status: failed?.status,
      quote: (await quoteOf(payout)).status,
      depositAddressHolds: near.state.usdcBalanceOf(quote.depositAddress),
    }).toEqual({ status: "failed", quote: "expired", depositAddressHolds: 0n });
  });

  it("waits in funding while the company wallet is busy, then is debited once", async () => {
    // #given the company wallet holding another send in flight
    const payout = await approved("base", randomAddress());
    const [blocker] = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .insert(companyWalletSends)
          .values({
            organizationId: paying.company.organizationId,
            walletId: paying.wallet.id,
            sendKey: `other-${randomUUID()}`,
            kind: "transfer",
            senderAccountId: paying.accountId,
            receiverAccountId: "someone.near",
            usdcAmount: 1n,
            nonce: 9_999n,
            maxBlockHeight: near.state.height + 10_000n,
          })
          .returning({ id: companyWalletSends.id }),
    );

    // #when it is funded
    const waiting = await deliver(payout);

    // #then the barrier is taken and nothing is debited yet
    expect({
      status: waiting.status,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({ status: "funding", ledger: 100n * USDC });

    // #when the wallet is free and the job resumes it, twice
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .update(companyWalletSends)
          .set({ status: "expired" })
          .where(eq(companyWalletSends.id, blocker?.id ?? "")),
    );
    const quote = await quoteOf(payout);
    await resume(quote);
    const sent = await resume(quote);

    // #then one deposit ran and the ledger holds one debit
    expect({
      status: sent?.status,
      depositAddressHolds: near.state.usdcBalanceOf(quote.depositAddress),
      debits: (await ledgerRows()).filter((row) => row.type === "payout"),
    }).toEqual({
      status: "paying",
      depositAddressHolds: quote.amountIn,
      debits: [
        {
          type: "payout",
          chain: "near",
          usdcAmount: -AMOUNT,
          txHash: sent?.txHash,
        },
      ],
    });
  });

  it("follows up a deposit whose outcome wasn't known, without sending twice", async () => {
    // #given a deposit the chain ran but hasn't reported yet
    const payout = await approved("solana", SOLANA_ADDRESS);
    near.state.nextBroadcasts("run", "run", "withhold");
    const unknown = await deliver(payout);
    expect(unknown.status).toBe("funding");

    // #when the chain reports it and the job resumes
    near.state.release();
    const quote = await quoteOf(payout);
    const sent = await resume(quote);

    // #then the one deposit is recorded and debited
    expect({
      status: sent?.status,
      depositAddressHolds: near.state.usdcBalanceOf(quote.depositAddress),
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "paying",
      depositAddressHolds: quote.amountIn,
      ledger: 100n * USDC - AMOUNT,
    });
  });

  it("fails and credits the ledger back when 1Click refunds the deposit", async () => {
    // #given a payout whose deposit ran and was debited
    const payout = await approved("base", randomAddress());
    await deliver(payout);
    const quote = await quoteOf(payout);

    // #when 1Click refunds it to the company wallet, and the job runs twice
    oneClick.state.setStatus(quote.depositAddress, {
      status: "REFUNDED",
      refundedAmount: quote.amountIn,
      refundReason: "deadline",
    });
    await resume(quote);
    const failed = await resume(quote);

    // #then the payout failed and the ledger is whole again, credited once
    expect({
      status: failed?.status,
      quote: (await quoteOf(payout)).status,
      rows: (await ledgerRows())
        .filter((row) => row.type !== "deposit")
        .map((row) => [row.type, row.usdcAmount]),
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "failed",
      quote: "refunded",
      rows: [
        ["payout", -AMOUNT],
        ["refund", AMOUNT],
      ],
      ledger: 100n * USDC,
    });
  });

  it("goes to a person when 1Click reports FAILED after the deposit", async () => {
    // #given a payout whose deposit ran
    const payout = await approved("base", randomAddress());
    await deliver(payout);
    const quote = await quoteOf(payout);

    // #when 1Click gives up on it
    oneClick.state.setStatus(quote.depositAddress, { status: "FAILED" });
    const reviewed = await resume(quote);

    // #then the payout and the quote are under review, still debited
    expect({
      status: reviewed?.status,
      quote: (await quoteOf(payout)).status,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "needs_review",
      quote: "needs_review",
      ledger: 100n * USDC - AMOUNT,
    });
  });
});
