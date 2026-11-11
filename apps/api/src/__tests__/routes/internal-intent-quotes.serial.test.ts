import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntentQuoteResolution } from "@expendi-business/shared";
import {
  companyDetailSchema,
  intentQuoteEvidenceSchema,
  intentQuoteQueueResponseSchema,
  intentQuoteResolveConfirmedSchema,
  intentQuoteResolvePreparedSchema,
  payoutQueueResponseSchema,
  staffIntentQuoteDetailSchema,
  staffPayoutDetailSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { UsdcPayoutRequest } from "../../services/payout/payout-service.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  quoteSendKey,
  UNSETTLED_REVIEW_MS,
} from "../../services/intents/quote-settle.js";
import {
  advanceSweep,
  sweepTransitWallet,
} from "../../services/intents/sweep.js";
import { continueDelivery } from "../../services/payout/delivery.js";
import { continueBaseHop } from "../../services/payout/fund.js";
import { advanceOutboundQuotes } from "../../services/payout/outbound-quotes.js";
import { transferReceipt } from "../helpers/chain.js";
import { randomAddress } from "../helpers/fakes.js";
import {
  createNearPayingCompany,
  makeNearPayoutWorld,
  readQuotes,
  updateQuote,
} from "../helpers/near-payouts.js";
import {
  ftTransferLog,
  nearOutcome,
  randomNearTxHash,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";
import {
  allowlistAddress,
  claimRequest,
  ledgerBalance,
  payClaims,
  readPayout,
  USDC,
} from "../helpers/payouts.js";
import { bearer } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

// Serial: resolving hands payouts back to the outbound quotes job, which
// these run, and the job follows every company's quotes.

const OPENING_BALANCE = 100n * USDC;
const PAYOUT_USDC = 25n * USDC;
const REASON = "Checked the deposit address on Nearblocks and BaseScan.";
const INTENTS = "intents.near";
const SOLVER = "solver-relay.near";

const world = makeNearPayoutWorld();
const { runtime, near, privy, oneClick, base, paycrest, fastNear } = world;
let db: Database;
let app: App;
let owner: pg.Pool;
let admin: TestStaff;
let otherAdmin: TestStaff;
let viewer: TestStaff;
let paying: NearPayingCompany;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  [admin, otherAdmin, viewer] = await Promise.all([
    createStaff(owner, { role: "ops_admin" }),
    createStaff(owner, { role: "ops_admin" }),
    createStaff(owner, { role: "ops_viewer" }),
  ]);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paying = await createNearPayingCompany(world, db, {
    balance: OPENING_BALANCE,
  });
});

// Fixtures

const inCompany = <T>(work: Parameters<typeof runInScope<T>>[2]): Promise<T> =>
  runInScope(db, { organizationId: paying.company.organizationId }, work);

const job = () => runtime.runPromise(advanceOutboundQuotes(500));
const reload = (payout: Payout) => readPayout(db, paying.company, payout.id);

async function onlyQuote(): Promise<IntentQuote> {
  const [quote, ...others] = await readQuotes(db, paying.company);
  if (!quote || others.length > 0) throw new Error("expected one quote");
  return quote;
}

/** The quote moving a payout's money: its Base hop or its delivery. */
async function quoteOf(payout: Payout): Promise<IntentQuote> {
  const { baseHopQuoteId, deliveryQuoteId } = await reload(payout);
  const quote = (await readQuotes(db, paying.company)).find(
    ({ id }) => id === (deliveryQuoteId ?? baseHopQuoteId),
  );
  if (!quote) throw new Error(`payout ${payout.id} has no quote`);
  return quote;
}

const ledgerOf = (payout: Payout) =>
  inCompany((tx) =>
    tx
      .select({
        type: walletTransactions.type,
        usdcAmount: walletTransactions.usdcAmount,
      })
      .from(walletTransactions)
      .where(eq(walletTransactions.payoutId, payout.id)),
  );

const sendsOf = (quote: IntentQuote) =>
  inCompany((tx) =>
    tx
      .select()
      .from(companyWalletSends)
      .where(eq(companyWalletSends.sendKey, quoteSendKey(quote.id))),
  );

/** Moves the quote's deadline far enough back that 1Click can no longer settle it unasked. */
const pastReviewMargin = (quote: IntentQuote) =>
  updateQuote(db, paying.company, quote.id, {
    deadline: new Date(Date.now() - UNSETTLED_REVIEW_MS - 60_000),
  });

/** What 1Click reports for the quote from now on, its hashes included. */
const oneClickReports = (
  quote: IntentQuote,
  report: Parameters<typeof oneClick.state.setStatus>[1],
) => oneClick.state.setStatus(quote.depositAddress, report);

/** A Base transaction moving `amount` USDC to `to`. Its hash. */
function onBase(to: string, amount: bigint, from?: string): string {
  const receipt = transferReceipt([{ to, amount, ...(from && { from }) }]);
  base.state.receipts.set(receipt.transactionHash.toLowerCase(), receipt);
  return receipt.transactionHash;
}

/**
 * A NEAR transaction in which NEAR Intents pays `amount` USDC to `to`, as
 * the chain and the transfers indexer would show it. Its hash.
 */
function fromIntentsOnNear(to: string, amount: bigint): string {
  const outcome = nearOutcome(
    [
      { executorId: INTENTS },
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [ftTransferLog([{ from: INTENTS, to, amount }])],
      },
    ],
    { signerId: SOLVER, receiverId: INTENTS },
  );
  near.state.outcomes.set(outcome.txHash, outcome);
  fastNear.state.index(to, outcome);
  return outcome.txHash;
}

/**
 * A cash-out whose Base hop 1Click reports FAILED after the deposit: the
 * job put the hop and the payout under review, and the review margin has
 * passed.
 */
async function hopUnderReview(): Promise<{ hop: IntentQuote; payout: Payout }> {
  const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
  if (!payout) throw new Error("no payout");
  const depositing = await quoteOf(payout);
  oneClickReports(depositing, { status: "FAILED" });
  await runtime.runPromise(continueBaseHop(depositing));
  await pastReviewMargin(depositing);
  const hop = await quoteOf(payout);
  const reviewed = await reload(payout);
  if (hop.status !== "needs_review" || reviewed.status !== "needs_review") {
    throw new Error(`expected review, got ${hop.status}/${reviewed.status}`);
  }
  return { hop, payout: reviewed };
}

/**
 * Leaves the next company wallet deposit signed and relayed but never on
 * chain, then moves the chain and the wallet's nonce past it: nothing can
 * say whether it ran, so the job hands its quote to a person.
 */
const dropTheDeposit = () => near.state.nextBroadcasts("run", "run", "drop");

async function deposited(quote: IntentQuote): Promise<void> {
  near.state.height += 1_000n;
  near.state.accounts.set(paying.accountId, 50_000n);
  await updateQuote(db, paying.company, quote.id, {
    deadline: new Date(Date.now() - 10 * 60_000),
  });
}

async function hopWithLostDeposit(
  whatTheChainDid: "never_included" | "ran_unseen" = "never_included",
): Promise<{
  hop: IntentQuote;
  payout: Payout;
}> {
  if (whatTheChainDid === "never_included") {
    dropTheDeposit();
  } else {
    near.state.nextBroadcasts("run", "run", "withhold");
  }
  const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
  if (!payout) throw new Error("no payout");
  const depositing = await onlyQuote();
  await deposited(depositing);
  await runtime.runPromise(continueBaseHop(depositing));
  await pastReviewMargin(depositing);
  const hop = await onlyQuote();
  if (hop.status !== "needs_review") throw new Error(`hop is ${hop.status}`);
  return { hop, payout: await reload(payout) };
}

const usdcBill = (
  chain: "base" | "solana",
  address: string,
): UsdcPayoutRequest => ({
  subjectType: "bill",
  subjectId: randomUUID(),
  idempotencyKey: `bill:${randomUUID()}:1`,
  recipient: { method: "usdc", chain, address, accountName: "Supplier" },
  amountUsdc: PAYOUT_USDC,
});

/** A USDC payout to Base or Solana whose delivery quote is under review. */
async function deliveryUnderReview(
  chain: "base" | "solana",
  deposit: "ran" | "lost" = "ran",
): Promise<{ quote: IntentQuote; payout: Payout; payee: string }> {
  const payee = chain === "base" ? randomAddress() : randomNearTxHash();
  await allowlistAddress(runtime, paying, payee, "Supplier", chain);
  if (deposit === "lost") dropTheDeposit();
  const [payout] = await payClaims(runtime, db, paying, [
    usdcBill(chain, payee),
  ]);
  if (!payout) throw new Error("no payout");
  const depositing = await quoteOf(payout);
  if (deposit === "lost") {
    await deposited(depositing);
  } else {
    oneClickReports(depositing, { status: "FAILED" });
  }
  await runtime.runPromise(continueDelivery(depositing));
  await pastReviewMargin(depositing);
  const quote = await quoteOf(payout);
  const reviewed = await reload(payout);
  if (quote.status !== "needs_review" || reviewed.status !== "needs_review") {
    throw new Error(`expected review, got ${quote.status}/${reviewed.status}`);
  }
  return { quote, payout: reviewed, payee };
}

/** A sweep of the transit wallet under review. */
async function sweepUnderReview(
  privyAnswer: "sent" | "lost",
): Promise<IntentQuote> {
  world.setBaseUsdc(paying.transitAddress, 5n * USDC);
  if (privyAnswer === "lost") privy.state.nextSends("unknown");
  const started = await runtime.runPromise(
    sweepTransitWallet({ organizationId: paying.company.organizationId }),
  );
  if (!started) throw new Error("no sweep");
  if (privyAnswer === "sent") {
    const receipt = transferReceipt(
      [
        {
          from: paying.transitAddress,
          to: started.depositAddress,
          amount: started.amountIn,
        },
      ],
      started.depositTxHash ? { txHash: started.depositTxHash } : {},
    );
    base.state.receipts.set(receipt.transactionHash.toLowerCase(), receipt);
    oneClickReports(started, { status: "FAILED" });
    await runtime.runPromise(advanceSweep(started));
  }
  await pastReviewMargin(started);
  const sweep = await onlyQuote();
  if (sweep.status !== "needs_review")
    throw new Error(`sweep is ${sweep.status}`);
  return sweep;
}

// HTTP

async function post(path: string, staff: TestStaff, body: unknown = {}) {
  return app.request(path, {
    method: "POST",
    headers: {
      ...bearer(staff.privyUserId),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const get = (path: string, staff: TestStaff = viewer) =>
  app.request(path, { headers: bearer(staff.privyUserId) });

async function dataOf<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data: T };
  return body.data;
}

async function messageOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { message: string } };
  return body.error.message;
}

const prepare = (
  quote: IntentQuote,
  outcome: IntentQuoteResolution,
  staff = admin,
) =>
  post(`/internal/intent-quotes/${quote.id}/resolve/prepare`, staff, {
    outcome,
    reason: REASON,
  });

async function preparedToken(
  quote: IntentQuote,
  outcome: IntentQuoteResolution,
) {
  const response = await prepare(quote, outcome);
  if (response.status !== 201) {
    throw new Error(`prepare refused: ${await messageOf(response)}`);
  }
  return intentQuoteResolvePreparedSchema.parse(await dataOf(response));
}

const confirm = (quote: IntentQuote, token: string, staff = admin) =>
  post(`/internal/intent-quotes/${quote.id}/resolve/confirm`, staff, {
    token,
  });

async function resolve(quote: IntentQuote, outcome: IntentQuoteResolution) {
  const prepared = await preparedToken(quote, outcome);
  const response = await confirm(quote, prepared.token);
  if (response.status !== 200) {
    throw new Error(`confirm refused: ${await messageOf(response)}`);
  }
  return {
    prepared,
    confirmed: intentQuoteResolveConfirmedSchema.parse(await dataOf(response)),
  };
}

async function auditEntries(entityType: string, entityId: string) {
  const { rows } = await owner.query<{
    action: string;
    actor_type: string;
    actor_id: string;
    after: Record<string, unknown>;
  }>(
    `SELECT action, actor_type, actor_id, after FROM audit_log
     WHERE entity_type = $1 AND entity_id = $2 AND actor_type = 'staff'`,
    [entityType, entityId],
  );
  return rows;
}

/** Everything that would show something was signed, sent or ordered. */
const moneyMoves = () => ({
  nearSignings: privy.state.nearSigningRequestsFor(
    [...privy.state.nearWallets.values()].find(
      (wallet) => wallet.address === paying.accountId,
    )?.id ?? "",
  ),
  privySends: privy.state.sends.length,
  broadcasts: near.state.broadcasts.length,
  orders: paycrest.state.created.length,
  oneClickQuotes: oneClick.state.quoteRequests.length,
});

describe("GET /internal/intent-quotes", () => {
  it("lists a quote under review with the payouts it holds, for a viewer", async () => {
    // #given
    const { hop } = await hopUnderReview();

    // #when
    const response = await get(
      `/internal/intent-quotes?companyId=${paying.company.organizationId}`,
    );

    // #then
    const page = intentQuoteQueueResponseSchema.parse(await dataOf(response));
    expect({ status: response.status, quotes: page.quotes }).toMatchObject({
      status: 200,
      quotes: [
        {
          id: hop.id,
          purpose: "base_hop",
          status: "needs_review",
          oneClickStatus: "FAILED",
          payoutsInReview: 1,
          openSends: 0,
        },
      ],
    });
  });

  it("lists a quote 1Click settled while a payout and a send it holds were left open", async () => {
    // #given a hop whose deposit ran unseen, which 1Click then reported
    // delivered to the job
    const { hop } = await hopWithLostDeposit("ran_unseen");
    near.state.release();
    oneClickReports(hop, {
      status: "SUCCESS",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut)],
    });
    await runtime.runPromise(continueBaseHop(hop));

    // #when
    const response = await get(
      `/internal/intent-quotes?companyId=${paying.company.organizationId}`,
    );

    // #then
    const page = intentQuoteQueueResponseSchema.parse(await dataOf(response));
    expect(page.quotes).toMatchObject([
      { id: hop.id, status: "succeeded", payoutsInReview: 1, openSends: 1 },
    ]);
  });

  it("drops the quote once it is resolved", async () => {
    // #given
    const { hop } = await hopUnderReview();
    oneClickReports(hop, {
      status: "FAILED",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut)],
    });
    await resolve(hop, "delivered");

    // #when
    const response = await get(
      `/internal/intent-quotes?companyId=${paying.company.organizationId}`,
    );

    // #then
    const page = intentQuoteQueueResponseSchema.parse(await dataOf(response));
    expect(page.quotes).toEqual([]);
  });

  it("refuses someone who isn't staff", async () => {
    // #when
    const response = await app.request("/internal/intent-quotes", {
      headers: bearer(paying.company.admin.privyUserId),
    });

    // #then
    expect(response.status).toBe(403);
  });
});

describe("GET /internal/intent-quotes/:id and its evidence", () => {
  it("shows the quote, its payouts with their chain, and what 1Click and the chains show, changing nothing", async () => {
    // #given
    const { hop, payout } = await hopUnderReview();
    const delivery = onBase(hop.recipient, hop.amountOut);
    oneClickReports(hop, {
      status: "FAILED",
      destinationChainTxHashes: [delivery],
    });

    // #when
    const detail = await get(`/internal/intent-quotes/${hop.id}`);
    const evidence = await get(`/internal/intent-quotes/${hop.id}/evidence`);

    // #then
    const shownDetail = staffIntentQuoteDetailSchema.parse(
      await dataOf(detail),
    );
    const shownEvidence = intentQuoteEvidenceSchema.parse(
      await dataOf(evidence),
    );
    expect({
      statuses: [detail.status, evidence.status],
      detail: {
        originChain: shownDetail.originChain,
        destinationChain: shownDetail.destinationChain,
        depositTxHash: shownDetail.depositTxHash,
        payouts: shownDetail.payouts.map((row) => [row.id, row.chain]),
      },
      evidence: {
        oneClickStatus: shownEvidence.oneClickStatus,
        deposits: shownEvidence.deposits.map((row) => [row.chain, row.txHash]),
        deliveries: shownEvidence.deliveries.map((row) => row.txHash),
        sends: shownEvidence.companyWalletSends.map((send) => send.status),
      },
      saved: (await onlyQuote()).destinationChainTxHashes,
    }).toEqual({
      statuses: [200, 200],
      detail: {
        originChain: "near",
        destinationChain: "base",
        depositTxHash: hop.depositTxHash,
        payouts: [[payout.id, "base"]],
      },
      evidence: {
        oneClickStatus: "FAILED",
        deposits: [["near", hop.depositTxHash]],
        deliveries: [delivery.toLowerCase()],
        sends: ["executed"],
      },
      saved: [],
    });
  });

  it("answers 503 when 1Click doesn't answer", async () => {
    // #given
    const { hop } = await hopUnderReview();
    oneClick.state.failNextStatus();

    // #when
    const response = await get(`/internal/intent-quotes/${hop.id}/evidence`);

    // #then
    expect(response.status).toBe(503);
  });

  it("answers 404 for a quote that doesn't exist", async () => {
    // #when
    const response = await get(`/internal/intent-quotes/${randomUUID()}`);

    // #then
    expect(response.status).toBe(404);
  });
});

describe("resolving a Base hop", () => {
  it("as delivered: settles the hop and hands its cash-out back to the job, which funds it from the transit wallet", async () => {
    // #given 1Click reports FAILED, but Base shows the hop delivered
    const { hop, payout } = await hopUnderReview();
    oneClickReports(hop, {
      status: "FAILED",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut)],
    });

    // #when
    const { confirmed } = await resolve(hop, "delivered");
    const handedBack = (await reload(payout)).status;
    world.setBaseUsdc(paying.transitAddress, hop.amountOut);
    await job();

    // #then
    const funded = await reload(payout);
    expect({
      quote: confirmed.status,
      payouts: confirmed.payouts,
      handedBack,
      after: funded.status,
      reason: funded.failureReason,
      orders: paycrest.state.created.filter(
        (order) => order.reference === payout.id,
      ).length,
      ledger: (await ledgerOf(payout)).map((row) => row.type),
    }).toEqual({
      quote: "succeeded",
      payouts: [{ id: payout.id, status: "approved" }],
      handedBack: "approved",
      after: "paying",
      reason: null,
      orders: 1,
      ledger: ["payout"],
    });
  });

  it("as refunded: the job fails the cash-out with nothing sent, and it can be retried", async () => {
    // #given NEAR shows the deposit back in the company wallet
    const { hop, payout } = await hopUnderReview();
    oneClickReports(hop, {
      status: "FAILED",
      nearTxHashes: [fromIntentsOnNear(hop.refundTo, hop.amountIn)],
    });

    // #when
    const { confirmed } = await resolve(hop, "refunded");
    await job();

    // #then
    const failed = await reload(payout);
    expect({
      quote: confirmed.status,
      payout: failed.status,
      reason: failed.failureReason,
      orders: paycrest.state.created.filter(
        (order) => order.reference === payout.id,
      ).length,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      quote: "refunded",
      payout: "failed",
      reason:
        "NEAR Intents refunded the Base hop: the USDC is back in the company wallet. Nothing was sent.",
      orders: 0,
      ledger: OPENING_BALANCE,
    });
  });

  it("as never deposited: closes the send that can no longer run, and the job fails the cash-out with nothing sent", async () => {
    // #given the hop's deposit was signed, never seen on chain, and has expired
    const { hop, payout } = await hopWithLostDeposit();

    // #when
    const { confirmed } = await resolve(hop, "never_deposited");
    await job();

    // #then
    const [send] = await sendsOf(hop);
    const failed = await reload(payout);
    expect({
      quote: confirmed.status,
      failure: (await onlyQuote()).failure,
      send: send?.status,
      payout: failed.status,
      ledger: await ledgerBalance(db, paying.company),
      companyHolds:
        near.state.usdcBalanceOf(paying.accountId) >= OPENING_BALANCE,
    }).toEqual({
      quote: "failed",
      failure:
        "Closed by Expendi staff: the deposit never left the company wallet. Nothing moved.",
      send: "expired",
      payout: "failed",
      ledger: OPENING_BALANCE,
      companyHolds: true,
    });
  });
});

describe("resolving a USDC payout's delivery", () => {
  it("to Base, as delivered: the delivery code marks the payout paid with the delivery's transaction, debited once", async () => {
    // #given
    const { quote, payout, payee } = await deliveryUnderReview("base");
    const delivery = onBase(payee, quote.amountOut);
    oneClickReports(quote, {
      status: "FAILED",
      destinationChainTxHashes: [delivery],
    });

    // #when
    const { confirmed } = await resolve(quote, "delivered");
    const handedBack = (await reload(payout)).status;
    await job();

    // #then
    const paid = await reload(payout);
    expect({
      quote: confirmed.status,
      handedBack,
      payout: paid.status,
      reference: paid.providerReference,
      ledger: await ledgerOf(payout),
      balance: await ledgerBalance(db, paying.company),
    }).toEqual({
      quote: "succeeded",
      handedBack: "paying",
      payout: "paid",
      reference: delivery,
      ledger: [{ type: "payout", usdcAmount: -PAYOUT_USDC }],
      balance: OPENING_BALANCE - PAYOUT_USDC,
    });
  });

  it("to Solana, as delivered on 1Click's transaction alone, which Solana can't be read for", async () => {
    // #given
    const { quote, payout } = await deliveryUnderReview("solana");
    const delivery = randomNearTxHash();
    oneClickReports(quote, {
      status: "FAILED",
      destinationChainTxHashes: [delivery],
    });

    // #when
    const { prepared } = await resolve(quote, "delivered");
    await job();

    // #then
    const paid = await reload(payout);
    expect({
      payout: paid.status,
      reference: paid.providerReference,
      unread: prepared.evidence.unreadDeliveries,
    }).toEqual({ payout: "paid", reference: delivery, unread: [delivery] });
  });

  it("as refunded: the delivery code fails the payout and credits the refund, so the ledger nets to zero", async () => {
    // #given
    const { quote, payout } = await deliveryUnderReview("base");
    oneClickReports(quote, {
      status: "FAILED",
      nearTxHashes: [fromIntentsOnNear(quote.refundTo, quote.amountIn)],
    });

    // #when
    const { confirmed } = await resolve(quote, "refunded");
    await job();

    // #then
    const failed = await reload(payout);
    expect({
      quote: confirmed.status,
      payout: failed.status,
      ledger: (await ledgerOf(payout)).map((row) => row.usdcAmount),
      balance: await ledgerBalance(db, paying.company),
    }).toEqual({
      quote: "refunded",
      payout: "failed",
      ledger: [-PAYOUT_USDC, PAYOUT_USDC],
      balance: OPENING_BALANCE,
    });
  });

  it("as never deposited: the delivery code fails the undebited payout with nothing sent", async () => {
    // #given
    const { quote, payout } = await deliveryUnderReview("base", "lost");

    // #when
    const { confirmed } = await resolve(quote, "never_deposited");
    const handedBack = (await reload(payout)).status;
    await job();

    // #then
    const failed = await reload(payout);
    expect({
      quote: confirmed.status,
      handedBack,
      payout: failed.status,
      ledger: await ledgerOf(payout),
      send: (await sendsOf(quote))[0]?.status,
    }).toEqual({
      quote: "failed",
      handedBack: "funding",
      payout: "failed",
      ledger: [],
      send: "expired",
    });
  });
});

describe("resolving a sweep", () => {
  it("as delivered when NEAR shows the USDC in the company wallet, leaving the ledger alone", async () => {
    // #given
    const sweep = await sweepUnderReview("sent");
    oneClickReports(sweep, {
      status: "FAILED",
      destinationChainTxHashes: [
        fromIntentsOnNear(sweep.recipient, sweep.amountOut),
      ],
    });

    // #when
    const { confirmed } = await resolve(sweep, "delivered");

    // #then
    expect({
      quote: confirmed.status,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({ quote: "succeeded", ledger: OPENING_BALANCE });
  });

  it("as refunded when Base shows the USDC back in the transit wallet", async () => {
    // #given
    const sweep = await sweepUnderReview("sent");
    oneClickReports(sweep, {
      status: "FAILED",
      originChainTxHashes: [onBase(sweep.refundTo, sweep.amountIn)],
    });

    // #when
    const { confirmed } = await resolve(sweep, "refunded");

    // #then
    expect({
      quote: confirmed.status,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({ quote: "refunded", ledger: OPENING_BALANCE });
  });

  it("as never deposited when Privy's answer was lost and Base shows no transfer, recording nothing", async () => {
    // #given
    const sweep = await sweepUnderReview("lost");

    // #when
    const { confirmed } = await resolve(sweep, "never_deposited");

    // #then
    expect({
      quote: confirmed.status,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({ quote: "failed", ledger: OPENING_BALANCE });
  });
});

describe("a quote 1Click has settled since it went to review", () => {
  it("is settled by the job's own step when asked again, and its cash-out still goes back to be funded", async () => {
    // #given 1Click now reports SUCCESS
    const { hop, payout } = await hopUnderReview();
    oneClickReports(hop, {
      status: "SUCCESS",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut)],
    });

    // #when
    const prepared = await preparedToken(hop, "delivered");
    const afterAsking = (await onlyQuote()).status;
    const response = await confirm(hop, prepared.token);

    // #then
    const confirmed = intentQuoteResolveConfirmedSchema.parse(
      await dataOf(response),
    );
    expect({
      prepared: prepared.status,
      afterAsking,
      quote: confirmed.status,
      payout: (await reload(payout)).status,
    }).toEqual({
      prepared: "succeeded",
      afterAsking: "succeeded",
      quote: "succeeded",
      payout: "approved",
    });
  });

  it("can't be resolved against what 1Click now reports", async () => {
    // #given
    const { hop, payout } = await hopUnderReview();
    oneClickReports(hop, {
      status: "SUCCESS",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut)],
    });

    // #when
    const response = await prepare(hop, "refunded");

    // #then
    expect({
      status: response.status,
      payout: (await reload(payout)).status,
    }).toEqual({ status: 409, payout: "needs_review" });
  });
});

describe("a quote whose deposit ran unseen", () => {
  it("records the deposit and closes the open send as run, so the company wallet can send again", async () => {
    // #given 1Click settled the hop as delivered, but nothing recorded the
    // company wallet's send that paid it
    const { hop, payout } = await hopWithLostDeposit("ran_unseen");
    near.state.release();
    oneClickReports(hop, {
      status: "SUCCESS",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut)],
    });
    await runtime.runPromise(continueBaseHop(hop));
    const relayed = near.state.broadcasts.at(-1);

    // #when
    const { confirmed } = await resolve(hop, "delivered");

    // #then
    const [send] = await sendsOf(hop);
    const settled = await onlyQuote();
    expect({
      quote: confirmed.status,
      send: { status: send?.status, txHash: send?.txHash },
      depositTxHash: settled.depositTxHash,
      companyWalletSendId: settled.companyWalletSendId,
      payout: (await reload(payout)).status,
    }).toEqual({
      quote: "succeeded",
      send: { status: "executed", txHash: relayed },
      depositTxHash: relayed,
      companyWalletSendId: send?.id,
      payout: "approved",
    });
  });
});

describe("refusing a resolution, changing nothing", () => {
  it("while 1Click may still settle the quote unasked", async () => {
    // #given a hop under review whose deadline was only just now
    const { hop, payout } = await hopUnderReview();
    await updateQuote(db, paying.company, hop.id, { deadline: new Date() });
    oneClickReports(hop, {
      status: "FAILED",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut)],
    });

    // #when
    const response = await prepare(hop, "delivered");

    // #then
    expect({
      status: response.status,
      explains: (await messageOf(response)).includes("may still settle"),
      quote: (await onlyQuote()).status,
      payout: (await reload(payout)).status,
    }).toEqual({
      status: 409,
      explains: true,
      quote: "needs_review",
      payout: "needs_review",
    });
  });

  it.each([
    ["delivered", "reaching"],
    ["refunded", "not a refund"],
  ] as const)(
    "as %s with no transaction on chain to show it",
    async (outcome, explanation) => {
      // #given
      const { hop } = await hopUnderReview();

      // #when
      const response = await prepare(hop, outcome);

      // #then
      expect({
        status: response.status,
        explains: (await messageOf(response)).includes(explanation),
        quote: (await onlyQuote()).status,
      }).toEqual({ status: 409, explains: true, quote: "needs_review" });
    },
  );

  it("as delivered when a refund shows on chain as well", async () => {
    // #given
    const { hop } = await hopUnderReview();
    oneClickReports(hop, {
      status: "FAILED",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut)],
      nearTxHashes: [fromIntentsOnNear(hop.refundTo, hop.amountIn)],
    });

    // #when
    const responses = await Promise.all([
      prepare(hop, "delivered"),
      prepare(hop, "refunded"),
    ]);

    // #then
    const messages = await Promise.all(responses.map(messageOf));
    expect({
      statuses: responses.map((response) => response.status),
      explain: messages.map((message) =>
        message.includes("can't both be true"),
      ),
    }).toEqual({ statuses: [409, 409], explain: [true, true] });
  });

  it("as delivered when Base shows less than the quote delivers", async () => {
    // #given
    const { hop } = await hopUnderReview();
    oneClickReports(hop, {
      status: "FAILED",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut - 1n)],
    });

    // #when
    const response = await prepare(hop, "delivered");

    // #then
    expect(response.status).toBe(409);
  });

  it("as never deposited when the chain shows the deposit", async () => {
    // #given
    const { hop } = await hopUnderReview();

    // #when
    const response = await prepare(hop, "never_deposited");

    // #then
    expect({
      status: response.status,
      explains: (await messageOf(response)).includes("did leave"),
    }).toEqual({ status: 409, explains: true });
  });

  it("as never deposited while the lost deposit could still run", async () => {
    // #given an expired-looking quote whose send's expiry the chain hasn't passed by the margin
    const { hop } = await hopWithLostDeposit();
    near.state.height -= 500n;

    // #when
    const response = await prepare(hop, "never_deposited");

    // #then
    expect({
      status: response.status,
      explains: (await messageOf(response)).includes("could run until block"),
      send: (await sendsOf(hop))[0]?.status,
    }).toEqual({ status: 409, explains: true, send: "signed" });
  });

  it("when 1Click doesn't answer", async () => {
    // #given
    const { hop } = await hopUnderReview();
    oneClickReports(hop, {
      status: "FAILED",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut)],
    });
    oneClick.state.failNextStatus();

    // #when
    const response = await prepare(hop, "delivered");

    // #then
    expect({
      status: response.status,
      quote: (await onlyQuote()).status,
    }).toEqual({ status: 503, quote: "needs_review" });
  });

  it("for a quote that isn't under review", async () => {
    // #given a hop still waiting for 1Click
    await payClaims(runtime, db, paying, [claimRequest()]);
    const hop = await onlyQuote();

    // #when
    const response = await prepare(hop, "delivered");

    // #then
    expect(response.status).toBe(409);
  });
});

describe("the rules every resolution follows", () => {
  const deliveredHop = async () => {
    const { hop, payout } = await hopUnderReview();
    oneClickReports(hop, {
      status: "FAILED",
      destinationChainTxHashes: [onBase(hop.recipient, hop.amountOut)],
    });
    return { hop, payout };
  };

  it("needs the second confirmation: preparing alone changes nothing", async () => {
    // #given
    const { hop, payout } = await deliveredHop();

    // #when
    const response = await prepare(hop, "delivered");

    // #then
    expect({
      status: response.status,
      quote: (await onlyQuote()).status,
      payout: (await reload(payout)).status,
    }).toEqual({ status: 201, quote: "needs_review", payout: "needs_review" });
  });

  it("refuses an ops viewer, changing nothing", async () => {
    // #given
    const { hop } = await deliveredHop();

    // #when
    const response = await prepare(hop, "delivered", viewer);

    // #then
    expect({
      status: response.status,
      quote: (await onlyQuote()).status,
    }).toEqual({ status: 403, quote: "needs_review" });
  });

  it("refuses a confirmation prepared by another staff member", async () => {
    // #given
    const { hop } = await deliveredHop();
    const { token } = await preparedToken(hop, "delivered");

    // #when
    const response = await confirm(hop, token, otherAdmin);

    // #then
    expect({
      status: response.status,
      quote: (await onlyQuote()).status,
    }).toEqual({ status: 403, quote: "needs_review" });
  });

  it("applies a confirmation once", async () => {
    // #given
    const { hop } = await deliveredHop();
    const { token } = await preparedToken(hop, "delivered");
    await confirm(hop, token);

    // #when
    const again = await confirm(hop, token);

    // #then
    expect(again.status).toBe(410);
  });

  it("audits the resolution as the staff member, with the evidence used, on the quote and on each payout", async () => {
    // #given
    const { hop, payout } = await deliveredHop();

    // #when
    await resolve(hop, "delivered");

    // #then
    const [onQuote] = await auditEntries("intent_quote", hop.id);
    const [onPayout] = await auditEntries("payout", payout.id);
    expect({ onQuote, onPayout }).toMatchObject({
      onQuote: {
        action: "intent_quote.resolved",
        actor_id: admin.staffUserId,
        after: {
          status: "succeeded",
          resolution: "delivered",
          note: REASON,
          oneClickStatus: "FAILED",
          evidence: {
            deposits: [{ chain: "near", txHash: hop.depositTxHash }],
            deliveries: [
              { chain: "base", usdcAmount: hop.amountOut.toString() },
            ],
          },
          payoutsReturned: [{ payoutId: payout.id, status: "approved" }],
        },
      },
      onPayout: {
        action: "payout.quote_resolved",
        actor_id: admin.staffUserId,
        after: {
          status: "approved",
          intentQuoteId: hop.id,
          resolution: "delivered",
          note: REASON,
        },
      },
    });
  });

  it("signs, sends, relays and orders nothing", async () => {
    // #given
    const { hop } = await deliveredHop();
    const before = moneyMoves();

    // #when
    await resolve(hop, "delivered");

    // #then
    expect(moneyMoves()).toEqual(before);
  });

  it("closes a lost deposit as never sent without signing or relaying anything", async () => {
    // #given
    const { hop } = await hopWithLostDeposit();
    const before = moneyMoves();

    // #when
    await resolve(hop, "never_deposited");

    // #then
    expect(moneyMoves()).toEqual(before);
  });
});

describe("the chain staff see for a company on NEAR", () => {
  it("is NEAR for its wallet and a USDC payout, and Base for a cash-out funded from the transit wallet", async () => {
    // #given a cash-out and a USDC payout to Base, both under review
    const { payout: cashOut } = await hopUnderReview();
    const usdcPayout = (await deliveryUnderReview("base")).payout;
    const companyId = paying.company.organizationId;

    // #when
    const [queue, detail, company] = await Promise.all([
      get(`/internal/payouts?companyId=${companyId}&status=needs_review`),
      get(`/internal/payouts/${usdcPayout.id}`),
      get(`/internal/companies/${companyId}`),
    ]);

    // #then
    const queued = payoutQueueResponseSchema.parse(await dataOf(queue));
    const shownCompany = companyDetailSchema.parse(await dataOf(company));
    expect({
      queue: Object.fromEntries(
        queued.payouts.map((payout) => [payout.id, payout.chain]),
      ),
      detail: staffPayoutDetailSchema.parse(await dataOf(detail)).chain,
      wallet: shownCompany.wallet?.chain,
      recent: Object.fromEntries(
        shownCompany.recentPayouts.map((payout) => [payout.id, payout.chain]),
      ),
    }).toEqual({
      queue: { [cashOut.id]: "base", [usdcPayout.id]: "near" },
      detail: "near",
      wallet: "near",
      recent: { [cashOut.id]: "base", [usdcPayout.id]: "near" },
    });
  });
});

describe("resolving a payout a quote holds", () => {
  it("is refused, and the payout points staff at the quote that holds it", async () => {
    // #given
    const { hop, payout } = await hopUnderReview();

    // #when
    const response = await post(
      `/internal/payouts/${payout.id}/resolve/prepare`,
      admin,
      { outcome: "failed", reason: REASON },
    );
    const detail = staffPayoutDetailSchema.parse(
      await dataOf(await get(`/internal/payouts/${payout.id}`)),
    );

    // #then
    expect({
      status: response.status,
      explains: (await messageOf(response)).includes(hop.id),
      payout: (await reload(payout)).status,
      heldBy: detail.heldByIntentQuoteId,
    }).toEqual({
      status: 409,
      explains: true,
      payout: "needs_review",
      heldBy: hop.id,
    });
  });
});
