import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { KesPayoutRequest } from "../../services/payout/payout-service.js";
import type { FundedCompany } from "../helpers/money-in.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  payouts,
  payrollRuns,
} from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { COMPANY_QUOTE_TTL_MS } from "../../services/intents/quote-deposit.js";
import { quoteSendKey } from "../../services/intents/quote-settle.js";
import { approvePayouts } from "../../services/payout/approve.js";
import {
  advanceBaseHop,
  hopBudget,
  packIntoHops,
  planBaseHops,
} from "../../services/payout/base-hop.js";
import { continueBaseHop } from "../../services/payout/fund.js";
import {
  preparePayouts,
  requestPayoutApproval,
  retryPayout,
} from "../../services/payout/payout-service.js";
import { sendUsdcFromCompanyWallet } from "../../services/wallet/company-wallet-send.js";
import { availableUsdc } from "../../services/wallet/ledger.js";
import { randomAddress, TEST_ORIGIN } from "../helpers/fakes.js";
import { ledgerOf, saveQuote, saveTreasuryMove } from "../helpers/money-in.js";
import {
  createNearPayingCompany,
  deliverHop,
  makeNearPayoutWorld,
  readQuotes,
  updateQuote,
} from "../helpers/near-payouts.js";
import {
  claimRequest,
  ledgerBalance,
  payClaims,
  readPayout,
  USDC,
} from "../helpers/payouts.js";

const world = makeNearPayoutWorld();
const { runtime, near, privy, paycrest, oneClick } = world;
let db: Database;
let paying: NearPayingCompany;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  paying = await createNearPayingCompany(world, db);
});

const pay = (...requests: KesPayoutRequest[]) =>
  payClaims(runtime, db, paying, requests);

const hops = async (): Promise<IntentQuote[]> =>
  (await readQuotes(db, paying.company)).filter(
    (quote) => quote.purpose === "base_hop",
  );

async function onlyHop(): Promise<IntentQuote> {
  const [hop, ...others] = await hops();
  if (!hop || others.length > 0) throw new Error("expected exactly one hop");
  return hop;
}

const resume = (quote: IntentQuote) =>
  runtime.runPromise(continueBaseHop(quote));

const reread = (payout: Payout) => readPayout(db, paying.company, payout.id);

const ordersFor = (payout: Payout) =>
  paycrest.state.created.filter((order) => order.reference === payout.id);

const transitSends = () =>
  privy.state.sends.filter(
    (send) => send.privyWalletId === paying.transitPrivyWalletId,
  );

const companyUsdc = () => near.state.usdcBalanceOf(paying.accountId);
const relayerUsdc = () => near.state.usdcBalanceOf(world.relayer.accountId);

/** Approves without funding, as a crash right after the approval leaves it. */
async function approveOnly(...requests: KesPayoutRequest[]): Promise<Payout[]> {
  const prepared = await runtime.runPromise(
    preparePayouts({
      organizationId: paying.company.organizationId,
      actor: { type: "user", id: paying.company.admin.id },
      requests,
    }),
  );
  const approval = await runtime.runPromise(
    requestPayoutApproval({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      payoutIds: prepared.map((payout) => payout.id),
    }),
  );
  return runtime.runPromise(
    approvePayouts({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      challengeId: approval.challengeId,
      response: paying.passkey.sign(approval.options, TEST_ORIGIN),
    }),
  );
}

const plan = (batch: readonly Payout[]) =>
  runtime.runPromise(
    planBaseHops({
      organizationId: paying.company.organizationId,
      payoutIds: batch.map((payout) => payout.id),
    }),
  );

/** A send of another payout that holds the company wallet. */
async function holdCompanyWallet(): Promise<string> {
  const [send] = await runInScope(
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
  if (!send) throw new Error("send insert returned no row");
  return send.id;
}

describe("a cash-out for a company whose money is on NEAR", () => {
  it("starts with a Base hop and orders nothing from Paycrest yet", async () => {
    // #given a company with 100 USDC in its company wallet
    const relayerBefore = relayerUsdc();

    // #when its admin approves a claim
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");

    // #then the payout waits, approved, for a hop that delivers its approved
    // maximum to the transit wallet
    const hop = await onlyHop();
    expect({
      payout: {
        status: payout.status,
        hop: payout.baseHopQuoteId,
        orderRequested: payout.orderRequestedAt,
      },
      hop: {
        status: hop.status,
        swapType: hop.swapType,
        amountOut: hop.amountOut,
        recipient: hop.recipient,
        refundTo: hop.refundTo,
        feeCover: hop.feeCoverUsdc,
      },
      orders: ordersFor(payout).length,
    }).toEqual({
      payout: { status: "approved", hop: hop.id, orderRequested: null },
      hop: {
        status: "depositing",
        swapType: "EXACT_OUTPUT",
        amountOut: payout.maxDebitUsdc,
        recipient: paying.transitAddress,
        refundTo: paying.accountId,
        feeCover: hop.amountIn - hop.amountOut,
      },
      orders: 0,
    });

    // #then the relayer registered the deposit address and covered the
    // hop's cost, the company wallet paid the amount in, 1Click was told,
    // and the ledger didn't move: a hop is internal
    expect({
      registered: near.state.registered.has(hop.depositAddress),
      depositAddressHolds: near.state.usdcBalanceOf(hop.depositAddress),
      relayerPaid: relayerBefore - relayerUsdc(),
      companyHolds: companyUsdc(),
      told: oneClick.state.submitted.filter(
        (deposit) => deposit.depositAddress === hop.depositAddress,
      ),
      ledger: await ledgerBalance(db, paying.company),
      everyStepSaved: [
        hop.depositRegistrationTxHash,
        hop.feeCoverTxHash,
        hop.depositStartedAt,
        hop.companyWalletSendId,
        hop.depositTxHash,
        hop.depositSubmittedAt,
      ].every((saved) => saved !== null),
    }).toEqual({
      registered: true,
      depositAddressHolds: hop.amountIn,
      relayerPaid: hop.amountIn - hop.amountOut,
      companyHolds: 100n * USDC - hop.amountOut,
      told: [{ depositAddress: hop.depositAddress, txHash: hop.depositTxHash }],
      ledger: 100n * USDC,
      everyStepSaved: true,
    });
  });

  it("orders and funds from the transit wallet once the hop delivers", async () => {
    // #given a cash-out whose hop is under way
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();

    // #when 1Click delivers to the transit wallet and the job runs
    deliverHop(world, paying, hop);
    const settled = await resume(hop);

    // #then the Paycrest order refunds to the transit wallet, exactly its
    // amount is sent from the transit wallet, and the ledger is debited now
    const paid = await reread(payout);
    const [order] = ordersFor(payout);
    expect({
      hop: settled.status,
      payout: paid.status,
      refundAddress: order?.source.refundAddress,
      sends: transitSends().map((send) => ({
        to: send.to,
        amount: send.amount,
        key: send.idempotencyKey,
      })),
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      hop: "succeeded",
      payout: "paying",
      refundAddress: paying.transitAddress,
      sends: [
        {
          to: paid.depositAddress,
          amount: paid.amountToTransferUsdc,
          key: `payout-${payout.id}`,
        },
      ],
      ledger: 100n * USDC - (paid.amountToTransferUsdc ?? 0n),
    });
  });

  it("does nothing more however often the job runs after funding", async () => {
    // #given a cash-out funded after its hop
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();
    deliverHop(world, paying, hop);
    await resume(hop);
    const broadcasts = near.state.broadcasts.length;

    // #when the hop is resumed twice more
    await resume(hop);
    await resume(hop);

    // #then nothing was sent again anywhere
    expect({
      broadcasts: near.state.broadcasts.length - broadcasts,
      orders: ordersFor(payout).length,
      sends: transitSends().length,
    }).toEqual({ broadcasts: 0, orders: 1, sends: 1 });
  });
});

describe("a Base hop that can't complete", () => {
  it("fails the payout with nothing moved when 1Click refuses the quote", async () => {
    // #given 1Click refusing quotes
    oneClick.state.failNextQuotes("refused");

    // #when a claim is approved
    const [payout] = await pay(claimRequest());

    // #then no quote is saved, the payout failed and no USDC moved
    expect({
      status: payout?.status,
      reason: payout?.failureReason,
      hops: (await hops()).length,
      companyHolds: companyUsdc(),
    }).toEqual({
      status: "failed",
      reason: expect.stringContaining("Nothing was sent.") as string,
      hops: 0,
      companyHolds: 100n * USDC,
    });
  });

  it("never uses a quote that fails 1Click's signature check", async () => {
    // #given a quote that isn't signed by 1Click
    oneClick.state.failNextQuotes("untrusted");

    // #when a claim is approved
    const [payout] = await pay(claimRequest());

    // #then nothing is saved or sent
    expect({ status: payout?.status, hops: (await hops()).length }).toEqual({
      status: "failed",
      hops: 0,
    });
  });

  it("expires with nothing moved when the deadline comes before the deposit", async () => {
    // #given a hop whose deposit address couldn't be registered yet
    near.state.failNext("usdcStorageRegistered");
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();
    expect(hop.status).toBe("quoted");

    // #when its deadline is nearly here and the job runs
    await updateQuote(db, paying.company, hop.id, {
      deadline: new Date(Date.now() + 60_000),
    });
    const settled = await resume(hop);

    // #then the quote expired, the payout failed and nothing left the wallet
    const failed = await reread(payout);
    expect({
      hop: settled.status,
      depositStarted: settled.depositStartedAt,
      payout: failed.status,
      companyHolds: companyUsdc(),
      orders: ordersFor(payout).length,
    }).toEqual({
      hop: "expired",
      depositStarted: null,
      payout: "failed",
      companyHolds: 100n * USDC,
      orders: 0,
    });
  });

  it("waits, without failing, while the company wallet is busy with another send", async () => {
    // #given the company wallet holding another send in flight
    const blockerId = await holdCompanyWallet();

    // #when a claim is approved
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const waiting = await onlyHop();

    // #then the hop is ready to deposit and nothing has failed
    expect({
      hop: waiting.status,
      send: waiting.companyWalletSendId,
      payout: payout.status,
      depositAddressHolds: near.state.usdcBalanceOf(waiting.depositAddress),
    }).toEqual({
      hop: "depositing",
      send: null,
      payout: "approved",
      depositAddressHolds: 0n,
    });

    // #when the other send is over and the job runs
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .update(companyWalletSends)
          .set({ status: "expired" })
          .where(eq(companyWalletSends.id, blockerId)),
    );
    const deposited = await resume(waiting);

    // #then the deposit went out once
    expect({
      send: deposited.companyWalletSendId !== null,
      depositAddressHolds: near.state.usdcBalanceOf(waiting.depositAddress),
    }).toEqual({ send: true, depositAddressHolds: waiting.amountIn });
  });

  it("fails with nothing moved when the company wallet's send is refused", async () => {
    // #given a company wallet that holds less on chain than its ledger says
    near.state.balances.set(paying.accountId, 1n * USDC);

    // #when a claim is approved
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");

    // #then the hop and the payout failed, and the deposit address got nothing
    const hop = await onlyHop();
    expect({
      hop: hop.status,
      payout: payout.status,
      reason: payout.failureReason,
      depositAddressHolds: near.state.usdcBalanceOf(hop.depositAddress),
      orders: ordersFor(payout).length,
    }).toEqual({
      hop: "failed",
      payout: "failed",
      reason: expect.stringContaining("Nothing was sent.") as string,
      depositAddressHolds: 0n,
      orders: 0,
    });
  });

  it("follows up a deposit whose outcome wasn't known, without sending twice", async () => {
    // #given a deposit the chain ran but hasn't reported yet
    near.state.nextBroadcasts("run", "run", "withhold");
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const unknown = await onlyHop();
    expect({
      hop: unknown.status,
      send: unknown.companyWalletSendId,
      payout: payout.status,
    }).toEqual({ hop: "depositing", send: null, payout: "approved" });

    // #when the chain reports it and the job runs
    near.state.release();
    const deposited = await resume(unknown);

    // #then the one deposit is recorded
    expect({
      send: deposited.companyWalletSendId !== null,
      depositAddressHolds: near.state.usdcBalanceOf(unknown.depositAddress),
      companyHolds: companyUsdc(),
    }).toEqual({
      send: true,
      depositAddressHolds: unknown.amountIn,
      companyHolds: 100n * USDC - unknown.amountOut,
    });
  });

  it("hands the hop and its payout to a person when the deposit stays unknown past the deadline", async () => {
    // #given a signed deposit that never showed on chain, although the
    // wallet's nonce moved past it
    near.state.nextBroadcasts("run", "run", "drop");
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const unknown = await onlyHop();
    near.state.height += 1_000n;
    near.state.accounts.set(paying.accountId, 50_000n);
    await updateQuote(db, paying.company, unknown.id, {
      deadline: new Date(Date.now() - 10 * 60_000),
    });

    // #when the job runs
    const settled = await resume(unknown);

    // #then both are under review, the USDC stays reserved, and no new
    // quote is taken for the payout
    const reviewed = await reread(payout);
    await resume(settled);
    expect({
      hop: settled.status,
      payout: reviewed.status,
      hops: (await hops()).length,
      orders: ordersFor(payout).length,
    }).toEqual({
      hop: "needs_review",
      payout: "needs_review",
      hops: 1,
      orders: 0,
    });
  });

  it("fails the payout when 1Click refunds the hop, and a retry takes a new quote", async () => {
    // #given a hop 1Click refunded to the company wallet
    const request = claimRequest();
    const [payout] = await pay(request);
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();
    oneClick.state.setStatus(hop.depositAddress, {
      status: "REFUNDED",
      refundedAmount: hop.amountIn,
      refundReason: "deadline",
    });

    // #when the job runs
    const settled = await resume(hop);

    // #then the payout failed with nothing sent to Paycrest
    const failed = await reread(payout);
    expect({
      hop: settled.status,
      payout: failed.status,
      orders: ordersFor(payout).length,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      hop: "refunded",
      payout: "failed",
      orders: 0,
      ledger: 100n * USDC,
    });

    // #when the admin retries and approves again
    const retry = await runtime.runPromise(
      retryPayout({
        organizationId: paying.company.organizationId,
        failedPayoutId: payout.id,
        idempotencyKey: `${request.idempotencyKey}:retry`,
        actor: { type: "user", id: paying.company.admin.id },
      }),
    );
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        payoutIds: [retry.id],
      }),
    );
    await runtime.runPromise(
      approvePayouts({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        challengeId: approval.challengeId,
        response: paying.passkey.sign(approval.options, TEST_ORIGIN),
      }),
    );
    await plan([retry]);

    // #then the retry has its own quote under a new key
    const keys = (await hops()).map((quote) => quote.quoteKey);
    expect(keys).toEqual([`base-hop:${payout.id}`, `base-hop:${retry.id}`]);
  });

  it("hands the hop and its payout to a person when 1Click reports FAILED", async () => {
    // #given a hop 1Click gave up on after the deposit
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();
    oneClick.state.setStatus(hop.depositAddress, { status: "FAILED" });

    // #when the job runs
    const settled = await resume(hop);

    // #then both are under review and nothing was ordered
    const reviewed = await reread(payout);
    expect({
      hop: settled.status,
      payout: reviewed.status,
      orders: ordersFor(payout).length,
    }).toEqual({ hop: "needs_review", payout: "needs_review", orders: 0 });
  });

  it("lets 1Click's later SUCCESS settle a hop that was under review", async () => {
    // #given a hop under review after 1Click reported FAILED
    await pay(claimRequest());
    const hop = await onlyHop();
    oneClick.state.setStatus(hop.depositAddress, { status: "FAILED" });
    const reviewed = await resume(hop);

    // #when 1Click later reports the delivery
    deliverHop(world, paying, hop);
    const settled = await resume(reviewed);

    // #then the quote is settled, so it no longer holds up deposits
    expect(settled.status).toBe("succeeded");
  });

  it("doesn't start the deposit once payouts are paused, and fails the payout", async () => {
    // #given an approved cash-out whose hop is saved but not started
    const batch = await approveOnly(claimRequest());
    await plan(batch);
    const hop = await onlyHop();
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx.execute(
          `UPDATE organizations SET payouts_paused = true WHERE id = '${paying.company.organizationId}'`,
        ),
    );

    // #when the job runs
    const settled = await resume(hop);

    // #then the hop was abandoned with nothing deposited
    const [payout] = batch;
    if (!payout) throw new Error("no payout");
    expect({
      hop: settled.status,
      payout: (await reread(payout)).status,
      depositAddressHolds: near.state.usdcBalanceOf(hop.depositAddress),
    }).toEqual({ hop: "expired", payout: "failed", depositAddressHolds: 0n });
  });
});

describe("the gas relayer's fee cover", () => {
  it("is never paid twice when its transaction's outcome is unknown", async () => {
    // #given a fee cover whose transaction the node refused after its hash
    // was saved
    near.state.nextBroadcasts("run", "reject");
    const relayerBefore = relayerUsdc();
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const waiting = await onlyHop();
    const broadcasts = near.state.broadcasts.length;

    // #when the job runs again and again
    await resume(waiting);
    const still = await resume(waiting);

    // #then no second cover is built and the deposit hasn't started
    expect({
      hop: still.status,
      coverSaved: still.feeCoverTxHash === waiting.feeCoverTxHash,
      broadcasts: near.state.broadcasts.length - broadcasts,
      relayerPaid: relayerBefore - relayerUsdc(),
      depositStarted: still.depositStartedAt,
    }).toEqual({
      hop: "quoted",
      coverSaved: true,
      broadcasts: 0,
      relayerPaid: 0n,
      depositStarted: null,
    });

    // #when the deadline comes
    await updateQuote(db, paying.company, waiting.id, {
      deadline: new Date(Date.now() + 60_000),
    });
    const expired = await resume(waiting);

    // #then the quote expires and the payout fails with nothing moved
    expect({
      hop: expired.status,
      payout: (await reread(payout)).status,
      companyHolds: companyUsdc(),
    }).toEqual({
      hop: "expired",
      payout: "failed",
      companyHolds: 100n * USDC,
    });
  });

  it("is sent again only after the chain shows the first one failed", async () => {
    // #given a relayer with no USDC, so its fee cover fails on chain
    const relayerHeld = relayerUsdc();
    near.state.balances.set(world.relayer.accountId, 0n);
    await pay(claimRequest());
    const waiting = await onlyHop();
    expect({
      hop: waiting.status,
      cover: waiting.feeCoverTxHash !== null,
    }).toEqual({ hop: "quoted", cover: true });

    // #when the relayer is funded and the job runs
    near.state.balances.set(world.relayer.accountId, relayerHeld);
    const deposited = await resume(waiting);

    // #then exactly one cover arrived, under a new transaction, and the
    // deposit went out
    expect({
      hop: deposited.status,
      newCover: deposited.feeCoverTxHash !== waiting.feeCoverTxHash,
      relayerPaid: relayerHeld - relayerUsdc(),
      companyHolds: companyUsdc(),
    }).toEqual({
      hop: "depositing",
      newCover: true,
      relayerPaid: deposited.amountIn - deposited.amountOut,
      companyHolds: 100n * USDC - deposited.amountOut,
    });
  });

  it("is reduced by what earlier hops' refunded buffers left in the company wallet", async () => {
    // #given a finished hop whose unused buffer 1Click refunded to the
    // company wallet
    const [first] = await pay(claimRequest());
    if (!first) throw new Error("no payout");
    const firstHop = await onlyHop();
    deliverHop(world, paying, firstHop);
    await resume(firstHop);
    const funded = await reread(first);
    const buffer = firstHop.amountIn - (firstHop.minAmountIn ?? 0n);
    near.state.balances.set(paying.accountId, companyUsdc() + buffer);
    world.setBaseUsdc(
      paying.transitAddress,
      firstHop.amountOut - (funded.amountToTransferUsdc ?? 0n),
    );

    // #when the next cash-out hops
    await pay(claimRequest());
    const [, secondHop] = await hops();
    if (!secondHop) throw new Error("no second hop");

    // #then the relayer covers only what that surplus doesn't
    expect(secondHop.feeCoverUsdc).toBe(
      secondHop.amountIn - secondHop.amountOut - buffer,
    );
  });
});

describe("a Base hop's fee cover while a Treasury move may have left USDC uncredited", () => {
  it.each([
    ["is open", { status: "open" as const }],
    [
      "settled a minute ago",
      { status: "returned" as const, settledAt: new Date() },
    ],
  ])(
    "doesn't read USDC above the ledger as Expendi's surplus when a move %s",
    async (_name, move) => {
      // #given a finished hop that left a refunded buffer at the company
      // wallet, and a move to Treasury whose refund may be waiting to be credited
      await pay(claimRequest());
      const firstHop = await onlyHop();
      deliverHop(world, paying, firstHop);
      await resume(firstHop);
      const buffer = firstHop.amountIn - (firstHop.minAmountIn ?? 0n);
      near.state.balances.set(paying.accountId, companyUsdc() + buffer);
      await saveTreasuryMove(
        db,
        { company: paying.company, walletId: paying.wallet.id },
        { requestedUsdc: 1n * USDC, ...move },
      );

      // #when the next cash-out hops
      await pay(claimRequest());
      const [, secondHop] = await hops();
      if (!secondHop) throw new Error("no second hop");

      // #then the relayer covers the full difference
      expect(secondHop.feeCoverUsdc).toBe(
        secondHop.amountIn - secondHop.amountOut,
      );
    },
  );
});

describe("resuming a Base hop after a crash", () => {
  it("picks up from a saved quote that nothing was done for", async () => {
    // #given payouts approved and their hop saved, then a crash
    const batch = await approveOnly(claimRequest());
    await plan(batch);
    const saved = await onlyHop();
    expect(saved.status).toBe("quoted");

    // #when the job runs
    const deposited = await resume(saved);

    // #then every step ran once
    expect({
      hop: deposited.status,
      depositAddressHolds: near.state.usdcBalanceOf(saved.depositAddress),
    }).toEqual({ hop: "depositing", depositAddressHolds: saved.amountIn });
  });

  it("sends the deposit once when the crash came after the deposit was recorded as starting", async () => {
    // #given a hop marked as depositing, with no send saved
    const batch = await approveOnly(claimRequest());
    await plan(batch);
    const saved = await onlyHop();
    near.state.registered.add(saved.depositAddress);
    await updateQuote(db, paying.company, saved.id, {
      status: "depositing",
      depositStartedAt: new Date(),
    });

    // #when the job runs twice
    await resume(saved);
    const deposited = await resume(saved);

    // #then one deposit went out
    expect({
      send: deposited.companyWalletSendId !== null,
      depositAddressHolds: near.state.usdcBalanceOf(saved.depositAddress),
    }).toEqual({ send: true, depositAddressHolds: saved.amountIn });
  });

  it("records a deposit that ran before the crash instead of sending another", async () => {
    // #given a hop whose company wallet send ran, but the quote never
    // recorded it
    const batch = await approveOnly(claimRequest());
    await plan(batch);
    const saved = await onlyHop();
    near.state.registered.add(saved.depositAddress);
    await updateQuote(db, paying.company, saved.id, {
      status: "depositing",
      depositStartedAt: new Date(),
    });
    const receipt = await runtime.runPromise(
      sendUsdcFromCompanyWallet({
        organizationId: paying.company.organizationId,
        sendKey: quoteSendKey(saved.id),
        to: saved.depositAddress,
        amount: saved.amountIn,
      }),
    );

    // #when the job runs
    const deposited = await resume(saved);

    // #then the quote names that send, and the address was paid once
    expect({
      send: deposited.companyWalletSendId,
      txHash: deposited.depositTxHash,
      depositAddressHolds: near.state.usdcBalanceOf(saved.depositAddress),
    }).toEqual({
      send: receipt.sendId,
      txHash: receipt.txHash,
      depositAddressHolds: saved.amountIn,
    });
  });

  it("funds the payouts of a hop that settled just before the crash", async () => {
    // #given a hop recorded as delivered whose payout was never funded
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();
    deliverHop(world, paying, hop);
    const settled = await runtime.runPromise(advanceBaseHop(hop));
    expect({
      hop: settled.status,
      payout: (await reread(payout)).status,
    }).toEqual({ hop: "succeeded", payout: "approved" });

    // #when the job runs
    await resume(settled);

    // #then the payout is funded, once
    expect({
      payout: (await reread(payout)).status,
      sends: transitSends().length,
    }).toEqual({ payout: "paying", sends: 1 });
  });
});

describe("a payroll run's cash-outs", () => {
  async function payrollRun(): Promise<string> {
    const payrollRunId = randomUUID();
    await runInScope(
      db,
      { organizationId: paying.company.organizationId, role: "admin" },
      (tx) =>
        tx.insert(payrollRuns).values({
          id: payrollRunId,
          organizationId: paying.company.organizationId,
          payDate: "2026-11-25",
          totalKes: 450_000n,
          capKes: 540_000n,
        }),
    );
    return payrollRunId;
  }

  const salary = (payrollRunId: string) =>
    claimRequest({
      subjectType: "bill",
      payrollRunId,
      idempotencyKey: `salary:${randomUUID()}:1`,
      amountKesCents: 150_000n,
    });

  it("hop once for the run's total, then each is funded from the transit wallet", async () => {
    // #given a run of three salaries
    const payrollRunId = await payrollRun();

    // #when the run is approved
    const batch = await pay(
      salary(payrollRunId),
      salary(payrollRunId),
      salary(payrollRunId),
    );

    // #then one hop delivers the sum of their approved maximums
    const hop = await onlyHop();
    const total = batch.reduce((sum, payout) => sum + payout.maxDebitUsdc, 0n);
    expect({
      amountOut: hop.amountOut,
      linked: batch.map((payout) => payout.baseHopQuoteId),
    }).toEqual({ amountOut: total, linked: [hop.id, hop.id, hop.id] });

    // #when the hop delivers
    deliverHop(world, paying, hop);
    await resume(hop);

    // #then each salary has its own order, funded once from the transit
    // wallet
    const funded = await Promise.all(batch.map(reread));
    expect({
      statuses: funded.map((payout) => payout.status),
      sends: transitSends()
        .map((send) => send.idempotencyKey)
        .sort(),
    }).toEqual({
      statuses: ["paying", "paying", "paying"],
      sends: batch.map((payout) => `payout-${payout.id}`).sort(),
    });
  });

  it("split into the fewest hops that fit under the per-transaction cap", async () => {
    // #given a company whose cap fits two salaries in one transfer, not three
    paying = await createNearPayingCompany(world, db, {
      perTransactionMaxUsdc: 30n * USDC,
    });
    const payrollRunId = await payrollRun();

    // #when a run of three is approved
    const batch = await pay(
      salary(payrollRunId),
      salary(payrollRunId),
      salary(payrollRunId),
    );

    // #then two hops carry them, each under the cap, and together they
    // deliver the run's total
    const split = await hops();
    const total = batch.reduce((sum, payout) => sum + payout.maxDebitUsdc, 0n);
    expect({
      hops: split.length,
      underCap: split.every((hop) => hop.amountIn <= 30n * USDC),
      delivered: split.reduce((sum, hop) => sum + hop.amountOut, 0n),
      perHop: split
        .map(
          (hop) =>
            batch.filter((payout) => payout.baseHopQuoteId === hop.id).length,
        )
        .sort(),
    }).toEqual({ hops: 2, underCap: true, delivered: total, perHop: [1, 2] });
  });

  it("all fail, with nothing ordered, when their shared hop is refunded", async () => {
    // #given a run whose hop 1Click refunded
    const payrollRunId = await payrollRun();
    const batch = await pay(salary(payrollRunId), salary(payrollRunId));
    const hop = await onlyHop();
    oneClick.state.setStatus(hop.depositAddress, {
      status: "REFUNDED",
      refundedAmount: hop.amountIn,
    });

    // #when the job runs, twice
    await resume(hop);
    await resume(hop);

    // #then every salary failed, none was ordered or sent, and the ledger
    // is untouched
    expect({
      statuses: (await Promise.all(batch.map(reread))).map(
        (payout) => payout.status,
      ),
      orders: batch.flatMap(ordersFor).length,
      sends: transitSends().length,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      statuses: ["failed", "failed"],
      orders: 0,
      sends: 0,
      ledger: 100n * USDC,
    });
  });

  it("go to a person together when their shared hop FAILED", async () => {
    // #given a run whose hop 1Click gave up on
    const payrollRunId = await payrollRun();
    const batch = await pay(salary(payrollRunId), salary(payrollRunId));
    const hop = await onlyHop();
    oneClick.state.setStatus(hop.depositAddress, { status: "FAILED" });

    // #when the job runs
    await resume(hop);

    // #then both wait for a person, with nothing ordered
    expect({
      statuses: (await Promise.all(batch.map(reread))).map(
        (payout) => payout.status,
      ),
      orders: batch.flatMap(ordersFor).length,
    }).toEqual({ statuses: ["needs_review", "needs_review"], orders: 0 });
  });
});

describe("packing payouts into hops", () => {
  const sized = (...amounts: bigint[]) =>
    amounts.map((amount, index) => ({ id: `p${index}`, amount }));

  it("keeps everything that fits in one hop", () => {
    expect(packIntoHops(sized(3n, 4n, 2n), 10n)).toHaveLength(1);
  });

  it("uses two hops where a naive in-order split would use three", () => {
    expect(packIntoHops(sized(6n, 5n, 4n, 5n), 10n)).toHaveLength(2);
  });

  it("gives an amount over the budget a hop of its own", () => {
    expect(packIntoHops(sized(12n, 3n), 10n).map((hop) => hop.length)).toEqual([
      1, 1,
    ]);
  });

  it("leaves room under the cap for the hop's cost", () => {
    expect(hopBudget(3_100n * USDC)).toBe(3_095_900_000n);
  });
});

describe("Paycrest order safety from the transit wallet", () => {
  it("never funds an order that refunds anywhere but the transit wallet", async () => {
    // #given a delivered hop and a Paycrest order refunding elsewhere
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();
    deliverHop(world, paying, hop);
    paycrest.state.nextOrder = (order) => ({
      ...order,
      source: { ...order.source, refundAddress: randomAddress() },
    });

    // #when the job funds the payout
    await resume(hop);

    // #then the payout failed and the transit wallet sent nothing
    const failed = await reread(payout);
    expect({
      status: failed.status,
      reason: failed.failureReason,
      sends: transitSends().length,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "failed",
      reason: expect.stringContaining("Nothing was sent.") as string,
      sends: 0,
      ledger: 100n * USDC,
    });
  });

  it("never funds an order the transit wallet can't cover on chain", async () => {
    // #given a hop 1Click reports delivered, but a transit wallet holding
    // less than the order needs
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();
    deliverHop(world, paying, hop, 1n * USDC);

    // #when the job funds the payout
    await resume(hop);

    // #then the payout failed before the funding barrier, with nothing sent
    const failed = await reread(payout);
    expect({
      status: failed.status,
      fundingStarted: failed.fundingStartedAt,
      sends: transitSends().length,
    }).toEqual({ status: "failed", fundingStarted: null, sends: 0 });
  });

  it("blocks a funding transfer the transit wallet's policy refuses", async () => {
    // #given a delivered hop and a transit wallet whose policy refuses
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();
    deliverHop(world, paying, hop);
    privy.state.nextSends("policy_violation");

    // #when the job funds the payout
    await resume(hop);

    // #then the payout failed with nothing sent and no debit
    expect({
      status: (await reread(payout)).status,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({ status: "failed", ledger: 100n * USDC });
  });

  it("doesn't fund before the hop has delivered", async () => {
    // #given a hop still under way
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();

    // #when the job runs
    await resume(hop);

    // #then no order exists and the payout still waits
    const [waiting] = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) => tx.select().from(payouts).where(eq(payouts.id, payout.id)),
    );
    expect({
      status: waiting?.status,
      orders: ordersFor(payout).length,
      deadlineAhead:
        hop.deadline.getTime() > Date.now() + COMPANY_QUOTE_TTL_MS / 2,
    }).toEqual({ status: "approved", orders: 0, deadlineAhead: true });
  });
});

describe("a cash-out for a company whose USDC is in a confidential account", () => {
  let funded: FundedCompany;

  async function confidentialCompany(float = 2n * USDC): Promise<void> {
    paying = await createNearPayingCompany(world, db, {
      balanceHome: "confidential_account",
    });
    oneClick.state.fundConfidential(paying.accountId, 100n * USDC);
    funded = {
      company: paying.company,
      walletId: paying.wallet.id,
      accountId: paying.accountId,
      transitAddress: paying.transitAddress,
    };
    if (float > 0n) {
      await saveQuote(runtime, db, funded, "fee_cover", {
        amount: float,
        row: { status: "succeeded", settledAt: new Date() },
      });
    }
  }

  const requestOf = (hop: IntentQuote) => {
    const known = oneClick.state.quotes.get(hop.depositAddress);
    if (!known) throw new Error("1Click never quoted this hop");
    return known.request;
  };

  const intentsFor = (hop: IntentQuote) =>
    oneClick.state.submittedIntents.filter(
      (intent) => intent.depositAddress === hop.depositAddress,
    );

  const available = () =>
    runtime.runPromise(
      withScope({ organizationId: paying.company.organizationId }, (tx) =>
        availableUsdc(tx, paying.wallet.id),
      ),
    );

  const sendsOfCompanyWallet = () =>
    runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
      tx.select().from(companyWalletSends),
    );

  it("hops out of the account with the company's session, paid by a signed message and not by a transfer", async () => {
    // #given a company whose USDC is in its confidential account
    await confidentialCompany();
    const companyUsdcBefore = companyUsdc();
    const callsBefore = oneClick.state.calls.length;

    // #when its admin approves a cash-out
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");

    // #then the hop was quoted to the transit wallet, out of the account and
    // refunding into it, with the company's session
    const hop = await onlyHop();
    const request = requestOf(hop);
    expect({
      request: {
        swapType: request.swapType,
        recipient: request.recipient,
        recipientType: request.recipientType,
        depositType: request.depositType,
        refundType: request.refundType,
        refundTo: request.refundTo,
        amount: request.amount,
      },
      row: {
        swapType: hop.swapType,
        depositType: hop.depositType,
        refundType: hop.refundType,
        amountOut: hop.amountOut,
      },
      quotedWithSession: oneClick.state.calls
        .slice(callsBefore)
        .some((entry) => entry.call === "quote" && entry.session !== undefined),
    }).toEqual({
      request: {
        swapType: "EXACT_OUTPUT",
        recipient: paying.transitAddress,
        recipientType: undefined,
        depositType: "CONFIDENTIAL_INTENTS",
        refundType: "CONFIDENTIAL_INTENTS",
        refundTo: paying.accountId,
        amount: payout.maxDebitUsdc,
      },
      row: {
        swapType: "EXACT_OUTPUT",
        depositType: "CONFIDENTIAL_INTENTS",
        refundType: "CONFIDENTIAL_INTENTS",
        amountOut: payout.maxDebitUsdc,
      },
      quotedWithSession: true,
    });

    // #then one message for the quote's amount in was submitted, the company
    // wallet sent nothing on chain, the ledger didn't move, the cash-out
    // still waits and Paycrest was not asked
    expect({
      hop: hop.status,
      submitted: intentsFor(hop).length,
      held: oneClick.state.confidentialBalances.get(paying.accountId),
      companySends: (await sendsOfCompanyWallet()).length,
      onChain: companyUsdc() - companyUsdcBefore,
      registered: near.state.registered.has(hop.depositAddress),
      ledger: await ledgerBalance(db, paying.company),
      payout: (await reread(payout)).status,
      orders: ordersFor(payout).length,
    }).toEqual({
      hop: "depositing",
      submitted: 1,
      held: 100n * USDC - hop.amountIn,
      companySends: 0,
      onChain: 0n,
      registered: false,
      ledger: 100n * USDC,
      payout: "approved",
      orders: 0,
    });
  });

  it("funds the cash-out provider from the transit wallet only after the hop succeeded, and once", async () => {
    // #given a cash-out whose hop is paid and not yet delivered
    await confidentialCompany();
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();

    // #when the job runs before 1Click reports anything
    await resume(hop);

    // #then nothing was ordered or sent
    expect({
      orders: ordersFor(payout).length,
      sends: transitSends().length,
    }).toEqual({ orders: 0, sends: 0 });

    // #when 1Click delivers the hop, and the job runs three times
    oneClick.state.deliverIntentPayout(hop.depositAddress);
    world.setBaseUsdc(paying.transitAddress, hop.amountOut);
    const settled = await resume(hop);
    await resume(hop);
    await resume(hop);

    // #then the provider is paid once from the transit wallet, and the
    // ledger is debited by that send alone
    const paid = await reread(payout);
    expect({
      hop: settled.status,
      payout: paid.status,
      orders: ordersFor(payout).length,
      sends: transitSends().map((send) => ({
        amount: send.amount,
        key: send.idempotencyKey,
      })),
      ledger: await ledgerBalance(db, paying.company),
      submitted: intentsFor(hop).length,
    }).toEqual({
      hop: "succeeded",
      payout: "paying",
      orders: 1,
      sends: [
        {
          amount: paid.amountToTransferUsdc,
          key: `payout-${payout.id}`,
        },
      ],
      ledger: 100n * USDC - (paid.amountToTransferUsdc ?? 0n),
      submitted: 1,
    });
  });

  it("fails the cash-out with no ledger row when 1Click refunds the hop", async () => {
    // #given a paid hop that 1Click refunded into the account
    await confidentialCompany();
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();
    oneClick.state.refundIntentPayout(hop.depositAddress);

    // #when the job runs, twice
    const settled = await resume(hop);
    await resume(hop);

    // #then the payout failed, saying where the USDC is, and nothing was
    // ordered, sent or written to the ledger
    const failed = await reread(payout);
    expect({
      hop: settled.status,
      payout: failed.status,
      says: failed.failureReason?.includes("confidential account"),
      orders: ordersFor(payout).length,
      sends: transitSends().length,
      ledger: await ledgerOf(db, funded),
      held: oneClick.state.confidentialBalances.get(paying.accountId),
    }).toEqual({
      hop: "refunded",
      payout: "failed",
      says: true,
      orders: 0,
      sends: 0,
      ledger: [expect.objectContaining({ type: "deposit" })],
      held: 100n * USDC,
    });
  });

  it("keeps the cash-out reserving its USDC, and orders nothing, while the hop is in review", async () => {
    // #given a hop whose outcome 1Click reports as FAILED
    await confidentialCompany();
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();
    const before = await available();
    oneClick.state.setStatus(hop.depositAddress, { status: "FAILED" });

    // #when the job runs
    const settled = await resume(hop);

    // #then both wait for a person, the whole maximum is still reserved, and
    // nothing was ordered
    expect({
      hop: settled.status,
      payout: (await reread(payout)).status,
      available: await available(),
      orders: ordersFor(payout).length,
    }).toEqual({
      hop: "needs_review",
      payout: "needs_review",
      available: before,
      orders: 0,
    });
    expect(before).toBe(100n * USDC - payout.maxDebitUsdc);
  });

  it("hops once for a payroll run's total, then funds each cash-out from the transit wallet", async () => {
    // #given a run of three salaries
    await confidentialCompany();
    const payrollRunId = randomUUID();
    await runInScope(
      db,
      { organizationId: paying.company.organizationId, role: "admin" },
      (tx) =>
        tx.insert(payrollRuns).values({
          id: payrollRunId,
          organizationId: paying.company.organizationId,
          payDate: "2026-11-25",
          totalKes: 450_000n,
          capKes: 540_000n,
        }),
    );
    const salary = () =>
      claimRequest({
        subjectType: "bill",
        payrollRunId,
        idempotencyKey: `salary:${randomUUID()}:1`,
        amountKesCents: 150_000n,
      });

    // #when the run is approved
    const batch = await pay(salary(), salary(), salary());

    // #then one hop out of the account carries the sum, paid by one message
    const hop = await onlyHop();
    const total = batch.reduce((sum, payout) => sum + payout.maxDebitUsdc, 0n);
    expect({
      amountOut: hop.amountOut,
      depositType: hop.depositType,
      linked: batch.map((payout) => payout.baseHopQuoteId),
      submitted: intentsFor(hop).length,
    }).toEqual({
      amountOut: total,
      depositType: "CONFIDENTIAL_INTENTS",
      linked: [hop.id, hop.id, hop.id],
      submitted: 1,
    });

    // #when the hop delivers
    oneClick.state.deliverIntentPayout(hop.depositAddress);
    world.setBaseUsdc(paying.transitAddress, hop.amountOut);
    await resume(hop);

    // #then each salary was funded once from the transit wallet
    expect({
      statuses: (await Promise.all(batch.map(reread))).map(
        (payout) => payout.status,
      ),
      sends: transitSends()
        .map((send) => send.idempotencyKey)
        .sort(),
    }).toEqual({
      statuses: ["paying", "paying", "paying"],
      sends: batch.map((payout) => `payout-${payout.id}`).sort(),
    });
  });

  it("waits, signing nothing, while the float can't cover what the hop costs beyond what it delivers", async () => {
    // #given a company with no float
    await confidentialCompany(0n);
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");
    const hop = await onlyHop();

    // #when the job runs
    const waiting = await resume(hop);

    // #then the hop is still only quoted, nothing was submitted and the
    // cash-out waits
    expect(hop.amountIn).toBeGreaterThan(hop.amountOut);
    expect({
      hop: waiting.status,
      submitted: intentsFor(hop).length,
      held: oneClick.state.confidentialBalances.get(paying.accountId),
      payout: (await reread(payout)).status,
    }).toEqual({
      hop: "quoted",
      submitted: 0,
      held: 100n * USDC,
      payout: "approved",
    });

    // #when a fee cover is delivered into the account
    await saveQuote(runtime, db, funded, "fee_cover", {
      amount: 2n * USDC,
      row: { status: "succeeded", settledAt: new Date() },
    });
    const going = await resume(hop);

    // #then the hop goes ahead
    expect({
      hop: going.status,
      submitted: intentsFor(hop).length,
    }).toEqual({ hop: "depositing", submitted: 1 });
  });

  it("opens the hop exactly as before for a company whose USDC is in its company wallet", async () => {
    // #given a company keeping its USDC in the company wallet (the default)
    const callsBefore = oneClick.state.calls.length;
    const [payout] = await pay(claimRequest());
    if (!payout) throw new Error("no payout");

    // #when its cash-out is hopped
    const hop = await onlyHop();
    const request = requestOf(hop);
    const quoteCalls = oneClick.state.calls
      .slice(callsBefore)
      .filter((entry) => entry.call === "quote");

    // #then 1Click was asked without any confidential field or session, and
    // the company wallet paid on chain
    expect({
      request: {
        swapType: request.swapType,
        recipient: request.recipient,
        refundTo: request.refundTo,
        amount: request.amount,
        depositType: request.depositType,
        refundType: request.refundType,
        recipientType: request.recipientType,
        slippageBps: request.slippageBps,
      },
      sessions: quoteCalls.map((entry) => entry.session),
      row: [hop.depositType, hop.refundType, hop.recipientType],
      intents: intentsFor(hop).length,
      sends: (await sendsOfCompanyWallet()).length,
    }).toEqual({
      request: {
        swapType: "EXACT_OUTPUT",
        recipient: paying.transitAddress,
        refundTo: paying.accountId,
        amount: payout.maxDebitUsdc,
        depositType: undefined,
        refundType: undefined,
        recipientType: undefined,
        slippageBps: 10,
      },
      sessions: [undefined],
      row: ["ORIGIN_CHAIN", "ORIGIN_CHAIN", "DESTINATION_CHAIN"],
      intents: 0,
      sends: 1,
    });
  });
});
