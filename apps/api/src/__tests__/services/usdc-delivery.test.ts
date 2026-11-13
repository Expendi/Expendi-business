import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  organizations,
  payouts,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { approvePayouts } from "../../services/payout/approve.js";
import {
  continueDelivery,
  deliverUsdcPayout,
} from "../../services/payout/delivery.js";
import { fundOnchainPayout } from "../../services/payout/onchain.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { availableUsdc } from "../../services/wallet/ledger.js";
import { randomTxHash } from "../helpers/chain.js";
import { settleOpenQuotes } from "../helpers/confidential-delivery.js";
import { randomAddress, TEST_ORIGIN } from "../helpers/fakes.js";
import { saveQuote } from "../helpers/money-in.js";
import {
  createNearPayingCompany,
  makeNearPayoutWorld,
  readQuotes,
} from "../helpers/near-payouts.js";
import { followPayout } from "../helpers/near-usdc-payouts.js";
import { randomNearAccount } from "../helpers/near.js";
import {
  allowlistAddress,
  ledgerBalance,
  payClaims,
  readPayout,
  updatePayout,
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
  chain: "base" | "solana" | "near",
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

describe("a USDC payout out of a confidential account", () => {
  const FLOAT = 1n * USDC;
  const funded: {
    company: NearPayingCompany["company"];
    walletId: string;
    accountId: string;
    transitAddress: string;
  }[] = [];

  /**
   * A company whose USDC is in a confidential account, with Expendi's float
   * there to cover what a payout costs beyond what the payee receives.
   */
  async function confidentialCompany(
    options: { readonly cap?: bigint } = {},
  ): Promise<void> {
    paying = await createNearPayingCompany(world, db, {
      balanceHome: "confidential_account",
      ...(options.cap !== undefined && {
        perTransactionMaxUsdc: options.cap,
      }),
    });
    const company = {
      company: paying.company,
      walletId: paying.wallet.id,
      accountId: paying.accountId,
      transitAddress: paying.transitAddress,
    };
    funded.push(company);
    oneClick.state.fundConfidential(paying.accountId, 100n * USDC);
    await saveQuote(runtime, db, company, "fee_cover", {
      row: {
        status: "succeeded",
        settledAt: new Date(),
        swappedAmountOut: FLOAT,
      },
    });
  }

  let intentsBefore = 0;
  const submittedIntents = () =>
    oneClick.state.submittedIntents.length - intentsBefore;

  const inAccount = () =>
    oneClick.state.confidentialBalances.get(paying.accountId) ?? 0n;

  const registeredPayee = (): string => {
    const account = randomNearAccount();
    near.state.fundWithUsdc(account, 0n);
    return account;
  };

  const payoutLedger = (payout: Payout) =>
    runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
      tx
        .select({
          type: walletTransactions.type,
          chain: walletTransactions.chain,
          usdcAmount: walletTransactions.usdcAmount,
          txHash: walletTransactions.txHash,
          blockNumber: walletTransactions.blockNumber,
        })
        .from(walletTransactions)
        .where(eq(walletTransactions.payoutId, payout.id)),
    );

  const available = () =>
    runtime.runPromise(
      withScope({ organizationId: paying.company.organizationId }, (tx) =>
        availableUsdc(tx, paying.wallet.id),
      ),
    );

  const moveMoneyTo = (
    balanceHome: "company_wallet" | "confidential_account",
  ) =>
    runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
      tx
        .update(wallets)
        .set({ balanceHome })
        .where(eq(wallets.id, paying.wallet.id)),
    );

  const setCap = (cap: bigint) =>
    runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
      tx
        .update(wallets)
        .set({ perTransactionMaxUsdc: cap })
        .where(eq(wallets.id, paying.wallet.id)),
    );

  beforeEach(() => {
    oneClick.state.costPerQuote = 0n;
    intentsBefore = oneClick.state.submittedIntents.length;
  });

  afterEach(async () => {
    oneClick.state.costPerQuote = 4_465n;
    for (const company of funded.splice(0)) {
      await settleOpenQuotes(db, company);
      await runInScope(
        db,
        { organizationId: company.company.organizationId },
        (tx) =>
          tx
            .update(payouts)
            .set({ status: "failed", failureReason: "The test is over." })
            .where(
              and(
                eq(payouts.organizationId, company.company.organizationId),
                inArray(payouts.status, [
                  "approved",
                  "funding",
                  "paying",
                  "needs_review",
                ]),
              ),
            ),
      );
    }
  });

  describe("to a payee on NEAR", () => {
    it("is quoted exact-amount-in, paid by a signed message, and debited and marked paid together when 1Click delivers", async () => {
      // #given a registered NEAR payee and an approved 25 USDC payout
      await confidentialCompany();
      const payee = registeredPayee();
      const payout = await approved("near", payee);

      // #when it is funded
      const funding = await deliver(payout);

      // #then the quote is out of the account, free, and its message was
      // signed, saved and submitted: nothing is debited or paid yet, and
      // nothing went through the company wallet
      const quote = await quoteOf(payout);
      const [request] = oneClick.state.quoteRequests.slice(-1);
      expect({
        request: {
          swapType: request?.swapType,
          amount: request?.amount,
          depositType: request?.depositType,
          refundType: request?.refundType,
          recipient: request?.recipient,
        },
        quote: {
          purpose: quote.purpose,
          status: quote.status,
          amountIn: quote.amountIn,
          amountOut: quote.amountOut,
          depositType: quote.depositType,
          signed: quote.signedIntent !== null,
          submitted: quote.intentHash !== null,
        },
        payout: { status: funding.status, txHash: funding.txHash },
        submitted: submittedIntents(),
        inAccount: inAccount(),
        ledger: await ledgerBalance(db, paying.company),
        sends: await runInScope(
          db,
          { organizationId: paying.company.organizationId },
          (tx) => tx.select().from(companyWalletSends),
        ),
      }).toEqual({
        request: {
          swapType: "EXACT_INPUT",
          amount: AMOUNT,
          depositType: "CONFIDENTIAL_INTENTS",
          refundType: "CONFIDENTIAL_INTENTS",
          recipient: payee,
        },
        quote: {
          purpose: "usdc_payout",
          status: "depositing",
          amountIn: AMOUNT,
          amountOut: AMOUNT,
          depositType: "CONFIDENTIAL_INTENTS",
          signed: true,
          submitted: true,
        },
        payout: { status: "funding", txHash: null },
        submitted: 1,
        inAccount: 100n * USDC - AMOUNT,
        ledger: 100n * USDC,
        sends: [],
      });

      // #when 1Click delivers it and the job runs twice
      const destinationTx = "7RbN3sKd9vYhTq2mWx";
      oneClick.state.deliverIntentPayout(quote.depositAddress);
      oneClick.state.setStatus(quote.depositAddress, {
        destinationChainTxHashes: [destinationTx],
      });
      const paid = await resume(quote);
      await resume(quote);

      // #then the payout is paid with the payee chain's transaction as its
      // reference, and the ledger holds one debit of exactly the approved
      // USDC with no hash of the company's
      const settled = await readPayout(db, paying.company, payout.id);
      expect({
        returned: paid?.status,
        status: settled.status,
        reference: settled.providerReference,
        txHash: settled.txHash,
        ledger: await payoutLedger(payout),
        balance: await ledgerBalance(db, paying.company),
        submitted: submittedIntents(),
      }).toEqual({
        returned: "paid",
        status: "paid",
        reference: destinationTx,
        txHash: null,
        ledger: [
          {
            type: "payout",
            chain: "near",
            usdcAmount: -AMOUNT,
            txHash: null,
            blockNumber: null,
          },
        ],
        balance: 100n * USDC - AMOUNT,
        submitted: 1,
      });
    });

    it("debits a withdrawal as a withdrawal", async () => {
      // #given a withdrawal to a registered NEAR address
      await confidentialCompany();
      const payee = registeredPayee();
      await allowlistAddress(runtime, paying, payee, "Treasury", "near");
      const [payout] = await payClaims(runtime, db, paying, [
        {
          subjectType: "withdrawal",
          subjectId: randomUUID(),
          idempotencyKey: `withdrawal:${randomUUID()}:1`,
          recipient: {
            method: "usdc",
            chain: "near",
            address: payee,
            accountName: "Treasury",
          },
          amountUsdc: AMOUNT,
        },
      ]);
      if (!payout) throw new Error("no payout");

      // #when 1Click delivers it
      const quote = await quoteOf(payout);
      oneClick.state.deliverIntentPayout(quote.depositAddress);
      await resume(quote);

      // #then the debit is a withdrawal
      expect({
        status: (await readPayout(db, paying.company, payout.id)).status,
        ledger: (await payoutLedger(payout)).map((row) => row.type),
      }).toEqual({ status: "paid", ledger: ["withdrawal"] });
    });

    it("registers an implicit account that doesn't exist yet, and pays it", async () => {
      // #given a payee that is a new implicit account
      await confidentialCompany();
      const payee = "b".repeat(64);
      const payout = await approved("near", payee);

      // #when it is funded and 1Click delivers
      await deliver(payout);
      const quote = await quoteOf(payout);
      oneClick.state.deliverIntentPayout(quote.depositAddress);
      await resume(quote);

      // #then the relayer registered the payee first, and the payout is paid
      expect({
        registered: near.state.registered.has(payee),
        status: (await readPayout(db, paying.company, payout.id)).status,
      }).toEqual({ registered: true, status: "paid" });
    });

    it("fails a named payee that can't receive USDC before anything is signed", async () => {
      // #given a named account that exists but isn't registered with USDC
      await confidentialCompany();
      const payee = "supplier.near";
      near.state.createAccount(payee);
      const payout = await approved("near", payee);
      const quotesBefore = oneClick.state.quoteRequests.length;

      // #when it is funded
      const failed = await deliver(payout);

      // #then it failed with today's message, no quote was asked for, and
      // nothing was signed or submitted
      expect({
        status: failed.status,
        reason: failed.failureReason,
        quote: failed.deliveryQuoteId,
        quotesAsked: oneClick.state.quoteRequests.length - quotesBefore,
        submitted: submittedIntents(),
        inAccount: inAccount(),
        ledger: await ledgerBalance(db, paying.company),
      }).toEqual({
        status: "failed",
        reason: `${payee} can't receive USDC yet: it isn't registered with the USDC contract on NEAR. Ask the recipient to register it (receiving USDC from an exchange or a wallet does this), then pay again. Nothing was sent.`,
        quote: null,
        quotesAsked: 0,
        submitted: 0,
        inAccount: 100n * USDC,
        ledger: 100n * USDC,
      });
    });

    it("fails a named payee that doesn't exist", async () => {
      // #given a named account that doesn't exist
      await confidentialCompany();
      const payout = await approved("near", "nobody-here.near");

      // #when it is funded
      const failed = await deliver(payout);

      // #then
      expect({
        status: failed.status,
        reason: failed.failureReason,
        submitted: submittedIntents(),
      }).toEqual({
        status: "failed",
        reason:
          "The NEAR account nobody-here.near doesn't exist, and a named account can't be created for someone else. Check the account with the recipient, correct it and pay again. Nothing was sent.",
        submitted: 0,
      });
    });
  });

  describe("to a payee on Base", () => {
    it("debits exactly the approved USDC, whatever the swap took", async () => {
      // #given a Base payee, a quote that costs Expendi something and a float
      oneClick.state.costPerQuote = 4_800n;
      await confidentialCompany();
      const payout = await approved("base", randomAddress());
      await deliver(payout);
      const quote = await quoteOf(payout);
      expect(quote.amountIn).toBeGreaterThan(AMOUNT);

      // #when 1Click delivers, taking a little less than the quote's amount in
      const took = AMOUNT + 4_900n;
      oneClick.state.deliverIntentPayout(quote.depositAddress, {
        swappedAmountIn: took,
      });
      oneClick.state.returnUnused(quote.depositAddress);
      await resume(quote);

      // #then the payout is paid and debited the approved USDC, not what the
      // quote took; the unused buffer is back in the account
      expect({
        status: (await readPayout(db, paying.company, payout.id)).status,
        ledger: (await payoutLedger(payout)).map((row) => row.usdcAmount),
        inAccount: inAccount(),
      }).toEqual({
        status: "paid",
        ledger: [-AMOUNT],
        inAccount: 100n * USDC - took,
      });
    });
  });

  describe("when the quote doesn't succeed", () => {
    it("fails the payout, with no ledger row at all, when 1Click refunds it", async () => {
      // #given a payout whose message was accepted
      await confidentialCompany();
      const payout = await approved("near", registeredPayee());
      await deliver(payout);
      const quote = await quoteOf(payout);

      // #when 1Click refunds it into the account and the job runs twice
      oneClick.state.refundIntentPayout(quote.depositAddress);
      await resume(quote);
      const failed = await resume(quote);

      // #then the payout failed, no row was written for it, the ledger is
      // whole and the money is back in the account
      expect({
        status: failed?.status,
        reason: failed?.failureReason,
        quote: (await quoteOf(payout)).status,
        rows: await payoutLedger(payout),
        ledger: await ledgerBalance(db, paying.company),
        inAccount: inAccount(),
        available: await available(),
      }).toEqual({
        status: "failed",
        reason:
          "NEAR Intents refunded the payment: the USDC is back in the company's account. Nothing was sent.",
        quote: "refunded",
        rows: [],
        ledger: 100n * USDC,
        inAccount: 100n * USDC,
        available: 100n * USDC,
      });
    });

    it("keeps the payout reserving, undebited, while its quote is under review", async () => {
      // #given a payout whose message was accepted
      await confidentialCompany();
      const payout = await approved("near", registeredPayee());
      await deliver(payout);
      const quote = await quoteOf(payout);
      const before = await readPayout(db, paying.company, payout.id);

      // #when 1Click gives up on it
      oneClick.state.setStatus(quote.depositAddress, { status: "FAILED" });
      const reviewed = await resume(quote);

      // #then the payout and the quote are under review, nothing is debited
      // and the payout's USDC is still reserved
      expect({
        status: reviewed?.status,
        quote: (await quoteOf(payout)).status,
        rows: await payoutLedger(payout),
        ledger: await ledgerBalance(db, paying.company),
        available: await available(),
      }).toEqual({
        status: "needs_review",
        quote: "needs_review",
        rows: [],
        ledger: 100n * USDC,
        available: 100n * USDC - before.maxDebitUsdc,
      });
    });

    it("doesn't debit a payout under review when 1Click's SUCCESS arrives late, until it is handed back", async () => {
      // #given a payout and a quote under review
      await confidentialCompany();
      const payout = await approved("near", registeredPayee());
      await deliver(payout);
      const quote = await quoteOf(payout);
      oneClick.state.setStatus(quote.depositAddress, { status: "FAILED" });
      await resume(quote);

      // #when 1Click reports SUCCESS after all
      oneClick.state.deliverIntentPayout(quote.depositAddress);
      const late = await resume(quote);

      // #then the quote settled but the payout is still under review and
      // undebited: it is for a person to hand back
      expect({
        quote: (await quoteOf(payout)).status,
        status: late?.status,
        rows: await payoutLedger(payout),
      }).toEqual({ quote: "succeeded", status: "needs_review", rows: [] });

      // #when it is handed back to funding, as staff do
      await updatePayout(db, paying.company, payout.id, {
        status: "funding",
        failureReason: null,
      });
      const handedBack = await resume(await quoteOf(payout));

      // #then it is debited and paid, once
      expect({
        status: handedBack?.status,
        rows: (await payoutLedger(payout)).map((row) => row.usdcAmount),
      }).toEqual({ status: "paid", rows: [-AMOUNT] });
    });

    it("pays nothing and debits nothing when the debit can't be written", async () => {
      // #given a payout whose delivery is reported but whose debit row can't
      // be inserted
      await confidentialCompany();
      const payout = await approved("near", registeredPayee());
      await deliver(payout);
      const quote = await quoteOf(payout);
      await runInScope(
        db,
        { organizationId: paying.company.organizationId },
        (tx) =>
          tx.insert(walletTransactions).values({
            organizationId: paying.company.organizationId,
            walletId: paying.wallet.id,
            type: "payout",
            chain: "near",
            usdcAmount: -AMOUNT,
            payoutId: payout.id,
          }),
      );
      oneClick.state.deliverIntentPayout(quote.depositAddress);

      // #when the job settles it
      await resume(quote).catch(() => undefined);

      // #then the payout wasn't marked paid without its debit
      expect((await readPayout(db, paying.company, payout.id)).status).toBe(
        "funding",
      );
    });
  });

  describe("the spend cap", () => {
    it("fails a payout above the cap when the quote is taken, before anything is signed", async () => {
      // #given a payout approved, then the wallet's cap lowered under it
      await confidentialCompany();
      const payout = await approved("near", registeredPayee());
      await setCap(10n * USDC);

      // #when it is funded
      const failed = await deliver(payout);

      // #then it failed cleanly with nothing signed or debited
      expect({
        status: failed.status,
        reason: failed.failureReason,
        submitted: submittedIntents(),
        ledger: await ledgerBalance(db, paying.company),
      }).toEqual({
        status: "failed",
        reason: expect.stringContaining("Nothing was sent.") as string,
        submitted: 0,
        ledger: 100n * USDC,
      });
    });

    it("fails a payout whose message the cap refuses to sign, rather than leaving it in review", async () => {
      // #given a quote taken under the cap whose message hasn't been generated
      await confidentialCompany();
      const payout = await approved("near", registeredPayee());
      oneClick.state.failNextGenerate();
      const funding = await deliver(payout);
      expect(funding.status).toBe("funding");

      // #when the cap is lowered under it and the job runs
      await setCap(10n * USDC);
      const failed = await resume(await quoteOf(payout));

      // #then signing refused: the quote and the payout failed, nothing was
      // signed, submitted or debited
      const quote = await quoteOf(payout);
      expect({
        quote: quote.status,
        signed: quote.signedIntent !== null,
        status: failed?.status,
        submitted: submittedIntents(),
        rows: await payoutLedger(payout),
        inAccount: inAccount(),
      }).toEqual({
        quote: "failed",
        signed: false,
        status: "failed",
        submitted: 0,
        rows: [],
        inAccount: 100n * USDC,
      });
    });
  });

  describe("when the company is switched meanwhile", () => {
    it("pays a quote opened for a company wallet through the company wallet, never the account", async () => {
      // #given a Base payout whose quote was opened for the company wallet
      paying = await createNearPayingCompany(world, db);
      const payout = await approved("base", randomAddress());
      near.state.failNext("usdcStorageRegistered");
      await deliver(payout);
      const quote = await quoteOf(payout);
      expect({
        depositType: quote.depositType,
        status: quote.status,
      }).toEqual({ depositType: "ORIGIN_CHAIN", status: "quoted" });

      // #when the company is switched to a confidential account and the job
      // resumes the quote
      funded.push({
        company: paying.company,
        walletId: paying.wallet.id,
        accountId: paying.accountId,
        transitAddress: paying.transitAddress,
      });
      await moveMoneyTo("confidential_account");
      oneClick.state.fundConfidential(paying.accountId, 100n * USDC);
      const sent = await resume(quote);

      // #then the company wallet paid it on chain and debited once, and no
      // message was signed
      expect({
        status: sent?.status,
        depositAddressHolds: near.state.usdcBalanceOf(quote.depositAddress),
        debits: (await payoutLedger(payout)).length,
        submitted: submittedIntents(),
        inAccount: inAccount(),
      }).toEqual({
        status: "paying",
        depositAddressHolds: quote.amountIn,
        debits: 1,
        submitted: 0,
        inAccount: 100n * USDC,
      });

      // #when 1Click delivers
      oneClick.state.setStatus(quote.depositAddress, {
        status: "SUCCESS",
        amountOut: AMOUNT,
        destinationChainTxHashes: [randomTxHash()],
      });
      await resume(quote);

      // #then it is paid, with that one debit
      expect({
        status: (await readPayout(db, paying.company, payout.id)).status,
        debits: (await payoutLedger(payout)).length,
      }).toEqual({ status: "paid", debits: 1 });
    });

    it("pays a quote opened out of the account through the account, once, after the company is switched back", async () => {
      // #given a payout whose message hasn't been generated yet
      await confidentialCompany();
      const payout = await approved("near", registeredPayee());
      oneClick.state.failNextGenerate();
      await deliver(payout);

      // #when the company is switched back to its company wallet and the
      // job resumes the quote, then 1Click delivers
      await moveMoneyTo("company_wallet");
      const quote = await quoteOf(payout);
      await resume(quote);
      oneClick.state.deliverIntentPayout(quote.depositAddress);
      await resume(quote);

      // #then the account paid it, by one message, and the company wallet
      // sent nothing; the ledger holds one debit
      expect({
        status: (await readPayout(db, paying.company, payout.id)).status,
        submitted: submittedIntents(),
        sends: (
          await runInScope(
            db,
            { organizationId: paying.company.organizationId },
            (tx) => tx.select().from(companyWalletSends),
          )
        ).length,
        debits: (await payoutLedger(payout)).length,
        companyHolds: companyUsdc(),
      }).toEqual({
        status: "paid",
        submitted: 1,
        sends: 0,
        debits: 1,
        companyHolds: 100n * USDC,
      });
    });

    it("keeps following a direct NEAR send after the company is switched, never opening a quote", async () => {
      // #given a company wallet payout to a NEAR payee waiting its turn
      // behind another send
      paying = await createNearPayingCompany(world, db);
      funded.push({
        company: paying.company,
        walletId: paying.wallet.id,
        accountId: paying.accountId,
        transitAddress: paying.transitAddress,
      });
      const payee = registeredPayee();
      const payout = await approved("near", payee);
      await runInScope(
        db,
        { organizationId: paying.company.organizationId },
        (tx) =>
          tx.insert(companyWalletSends).values({
            organizationId: paying.company.organizationId,
            walletId: paying.wallet.id,
            sendKey: `other-${randomUUID()}`,
            kind: "transfer",
            senderAccountId: paying.accountId,
            receiverAccountId: "someone.near",
            usdcAmount: 1n,
            nonce: 9_999n,
            maxBlockHeight: near.state.height + 10_000n,
          }),
      );
      const waiting = await runtime.runPromise(
        fundOnchainPayout({
          organizationId: paying.company.organizationId,
          payoutId: payout.id,
        }),
      );
      expect(waiting.status).toBe("funding");

      // #when the company is switched and the wallet frees up
      await moveMoneyTo("confidential_account");
      oneClick.state.fundConfidential(paying.accountId, 100n * USDC);
      await runInScope(
        db,
        { organizationId: paying.company.organizationId },
        (tx) =>
          tx
            .update(companyWalletSends)
            .set({ status: "expired" })
            .where(eq(companyWalletSends.nonce, 9_999n)),
      );
      const requestsBefore = oneClick.state.quoteRequests.length;
      await followPayout(runtime, waiting);

      // #then the saved send path paid it directly: a debit with the
      // chain's hash, no quote, and nothing asked of 1Click
      const sent = await readPayout(db, paying.company, payout.id);
      expect({
        status: sent.status,
        quotes: (await readQuotes(db, paying.company)).length,
        quotesAsked: oneClick.state.quoteRequests.length - requestsBefore,
        submitted: submittedIntents(),
        debits: (await payoutLedger(payout)).map((row) => row.txHash),
        payeeHolds: near.state.usdcBalanceOf(payee),
      }).toEqual({
        status: "paid",
        quotes: 0,
        quotesAsked: 0,
        submitted: 0,
        debits: [sent.txHash],
        payeeHolds: AMOUNT,
      });
    });
  });
});
