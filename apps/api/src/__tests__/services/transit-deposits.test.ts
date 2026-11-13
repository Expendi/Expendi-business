import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TransferLogInput } from "../helpers/chain.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { payouts } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { USDC_BASE_ADDRESS } from "../../services/chain/base.js";
import { creditUsdcDeposits } from "../../services/wallet/deposits.js";
import { randomTxHash, transferReceipt } from "../helpers/chain.js";
import { createDeliveryCompany } from "../helpers/confidential-delivery.js";
import {
  makeFakeBaseRpc,
  makeFakePrivyWallets,
  randomAddress,
  signAlchemyBody,
} from "../helpers/fakes.js";
import {
  gatewayRefundReceipt,
  LIVE_GATEWAY_ORDER_ID,
} from "../helpers/gateway-receipts.js";
import {
  createFundedCompany,
  ledgerOf,
  saveQuote,
} from "../helpers/money-in.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const ALCHEMY = { type: "system", id: "alchemy-webhook" } as const;

const rpc = makeFakeBaseRpc();
const oneClick = makeFakeOneClick();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let funded: FundedCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({ baseRpc: rpc.layer, oneClick: oneClick.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

beforeEach(async () => {
  funded = await createFundedCompany(db);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

/** Puts the transaction on the fake chain and returns its hash. */
function mined(transfers: readonly TransferLogInput[]): string {
  const receipt = transferReceipt(transfers);
  rpc.state.receipts.set(receipt.transactionHash, receipt);
  return receipt.transactionHash;
}

const credit = (hash: string) =>
  runtime.runPromise(creditUsdcDeposits([hash], ALCHEMY));

const creditExit = (hash: string) =>
  runtime.runPromise(Effect.either(creditUsdcDeposits([hash], ALCHEMY)));

const ledger = () => ledgerOf(db, funded);

/** A Paycrest payout of the company, funded from its transit wallet. */
async function paycrestPayout(
  fields: Partial<typeof payouts.$inferInsert>,
): Promise<string> {
  const { organizationId } = funded.company;
  const [row] = await runInScope(db, { organizationId }, (tx) =>
    tx
      .insert(payouts)
      .values({
        organizationId,
        walletId: funded.walletId,
        subjectType: "claim",
        subjectId: randomUUID(),
        idempotencyKey: `claim:${randomUUID()}:1`,
        provider: "paycrest",
        method: "mpesa_phone",
        recipient: {
          method: "mpesa_phone",
          phone: "+254712345678",
          accountName: "Jane Wanjiku",
        },
        requestedKesCents: 150_000n,
        amountKes: 150_000n,
        quotedRate: "128.68",
        quotedUsdc: 11_656_823n,
        maxDebitUsdc: 11_965_108n,
        ...fields,
      })
      .returning({ id: payouts.id }),
  );
  if (!row) throw new Error("payout insert returned no row");
  return row.id;
}

async function alerts(hash: string) {
  const { rows } = await owner.query<{
    kind: string;
    subject_key: string;
    organization_id: string;
    occurrences: number;
  }>(
    "SELECT kind, subject_key, organization_id, occurrences FROM ops_alerts WHERE subject_key LIKE $1 ORDER BY opened_at",
    [`${hash.toLowerCase()}:%`],
  );
  return rows;
}

describe("USDC arriving at a transit wallet", () => {
  it("credits a refund from a payout's Paycrest deposit address as that payout's refund", async () => {
    // #given
    const depositAddress = randomAddress();
    const payoutId = await paycrestPayout({ depositAddress });
    const hash = mined([
      {
        from: depositAddress,
        to: funded.transitAddress,
        amount: 11_656_823n,
        logIndex: 3,
      },
    ]);

    // #when
    const summary = await credit(hash);

    // #then
    expect({ summary, ledger: await ledger() }).toEqual({
      summary: { credited: 1, alreadyCredited: 0 },
      ledger: [
        {
          type: "refund",
          chain: "base",
          usdcAmount: 11_656_823n,
          txHash: hash,
          receiptId: null,
          logIndex: 3,
          transferIndex: null,
          blockNumber: 436n,
          counterpartyAddress: depositAddress.toLowerCase(),
          payoutId,
          intentQuoteId: null,
        },
      ],
    });
  });

  it("credits a Gateway refund as the refund of the payout with that Gateway order", async () => {
    // #given
    const orderId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "a")}`;
    const payoutId = await paycrestPayout({ gatewayOrderId: orderId });
    const receipt = gatewayRefundReceipt({
      to: funded.transitAddress,
      amount: 4_000_000n,
      orderId,
    });
    rpc.state.receipts.set(receipt.transactionHash, receipt);

    // #when
    await credit(receipt.transactionHash);

    // #then
    expect(
      (await ledger()).map((row) => ({
        type: row.type,
        usdcAmount: row.usdcAmount,
        payoutId: row.payoutId,
      })),
    ).toEqual([{ type: "refund", usdcAmount: 4_000_000n, payoutId }]);
  });

  it("credits a refund once when it is reported twice", async () => {
    // #given
    const depositAddress = randomAddress();
    await paycrestPayout({ depositAddress });
    const hash = mined([
      { from: depositAddress, to: funded.transitAddress, amount: 2_000_000n },
    ]);
    await credit(hash);

    // #when
    const summary = await credit(hash);

    // #then
    expect({ summary, rows: (await ledger()).length }).toEqual({
      summary: { credited: 0, alreadyCredited: 1 },
      rows: 1,
    });
  });

  it("leaves a Base hop arriving alone: it is the company's own money", async () => {
    // #given
    const hash = mined([{ to: funded.transitAddress, amount: 5_000_000n }]);
    await saveQuote(runtime, db, funded, "base_hop", {
      row: {
        status: "succeeded",
        settledAt: new Date(Date.now() - 60 * 60_000),
        destinationChainTxHashes: [hash.toUpperCase().replace("0X", "0x")],
      },
    });

    // #when
    const summary = await credit(hash);

    // #then
    expect({
      summary,
      ledger: await ledger(),
      alerts: await alerts(hash),
    }).toEqual({
      summary: { credited: 0, alreadyCredited: 0 },
      ledger: [],
      alerts: [],
    });
  });

  it("asks 1Click again before judging, and leaves the hop alone once its status lists the transaction", async () => {
    // #given
    const hop = await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "depositing" },
    });
    const hash = mined([{ to: funded.transitAddress, amount: hop.amountOut }]);
    oneClick.state.setStatus(hop.depositAddress, {
      status: "SUCCESS",
      destinationChainTxHashes: [hash],
    });

    // #when
    const summary = await credit(hash);

    // #then
    expect({
      summary,
      ledger: await ledger(),
      alerts: await alerts(hash),
    }).toEqual({
      summary: { credited: 0, alreadyCredited: 0 },
      ledger: [],
      alerts: [],
    });
  });

  it("asks to be retried while an unsettled hop is due to deliver exactly that amount but 1Click doesn't list it yet", async () => {
    // #given
    const hop = await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "depositing" },
    });
    oneClick.state.setStatus(hop.depositAddress, { status: "PROCESSING" });
    const hash = mined([{ to: funded.transitAddress, amount: hop.amountOut }]);

    // #when
    const outcome = await creditExit(hash);

    // #then
    expect({
      outcome: outcome._tag === "Left" ? outcome.left._tag : "succeeded",
      ledger: await ledger(),
      alerts: await alerts(hash),
    }).toEqual({ outcome: "HopArrivalUnconfirmed", ledger: [], alerts: [] });
  });

  it("answers 500 to Alchemy for a hop arrival it can't confirm yet, so the delivery is retried", async () => {
    // #given
    const hop = await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "depositing" },
    });
    oneClick.state.setStatus(hop.depositAddress, { status: "PROCESSING" });
    const hash = mined([{ to: funded.transitAddress, amount: hop.amountOut }]);
    const body = JSON.stringify({
      webhookId: "wh_test",
      id: `whevt_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      type: "ADDRESS_ACTIVITY",
      event: {
        network: "BASE_MAINNET",
        activity: [
          {
            fromAddress: randomAddress(),
            toAddress: funded.transitAddress,
            hash,
            category: "token",
            asset: "USDC",
            rawContract: { address: USDC_BASE_ADDRESS },
            log: { removed: false },
          },
        ],
      },
    });

    // #when
    const response = await app.request("/webhooks/alchemy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-alchemy-signature": signAlchemyBody(body),
      },
      body,
    });

    // #then
    expect(response.status).toBe(500);
  });

  it("never credits unexpected USDC: it raises it for review", async () => {
    // #given
    const sender = randomAddress();
    const hash = mined([
      {
        from: sender,
        to: funded.transitAddress,
        amount: 75_000_000n,
        logIndex: 6,
      },
    ]);

    // #when
    const summary = await credit(hash);

    // #then
    expect({
      summary,
      ledger: await ledger(),
      alerts: await alerts(hash),
    }).toEqual({
      summary: { credited: 0, alreadyCredited: 0 },
      ledger: [],
      alerts: [
        {
          kind: "unexpected_transit_transfer",
          subject_key: `${hash}:6`,
          organization_id: funded.company.organizationId,
          occurrences: 1,
        },
      ],
    });
  });

  it("keeps one review incident when the unexpected transfer is reported again", async () => {
    // #given
    const hash = mined([{ to: funded.transitAddress, amount: 1_000_000n }]);
    await credit(hash);

    // #when
    await credit(hash);

    // #then
    expect({
      ledger: await ledger(),
      alerts: (await alerts(hash)).map((alert) => alert.occurrences),
    }).toEqual({ ledger: [], alerts: [2] });
  });

  it("raises USDC for review at once when no unsettled hop is due to deliver that amount", async () => {
    // #given
    const hop = await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "depositing" },
    });
    oneClick.state.setStatus(hop.depositAddress, { status: "PROCESSING" });
    const hash = mined([
      { to: funded.transitAddress, amount: hop.amountOut + 1n },
    ]);

    // #when
    const summary = await credit(hash);

    // #then
    expect({
      summary,
      ledger: await ledger(),
      alerts: (await alerts(hash)).length,
    }).toEqual({
      summary: { credited: 0, alreadyCredited: 0 },
      ledger: [],
      alerts: 1,
    });
  });

  it("doesn't credit USDC from Paycrest's Gateway that matches none of the company's payouts", async () => {
    // #given
    const receipt = gatewayRefundReceipt({
      to: funded.transitAddress,
      amount: 4_000_000n,
      orderId: LIVE_GATEWAY_ORDER_ID,
      txHash: randomTxHash(),
    });
    rpc.state.receipts.set(receipt.transactionHash, receipt);

    // #when
    const summary = await credit(receipt.transactionHash);

    // #then
    expect({
      summary,
      ledger: await ledger(),
      alerts: (await alerts(receipt.transactionHash)).length,
    }).toEqual({
      summary: { credited: 0, alreadyCredited: 0 },
      ledger: [],
      alerts: 1,
    });
  });
});

describe("USDC arriving at the transit wallet of a company whose USDC is in a confidential account", () => {
  const privy = makeFakePrivyWallets();
  let confidential: AppRuntime;
  let company: FundedCompany;

  beforeAll(() => {
    confidential = makeTestRuntime({
      baseRpc: rpc.layer,
      oneClick: oneClick.layer,
      privyWallets: privy.layer,
    });
  });

  afterAll(async () => {
    await confidential.dispose();
  });

  beforeEach(async () => {
    company = await createDeliveryCompany(db, privy);
  });

  const hop = (status: "depositing" | "succeeded") =>
    saveQuote(confidential, db, company, "base_hop", {
      intentPaid: true,
      row: {
        status,
        depositStartedAt: new Date(),
        ...(status === "succeeded" && { settledAt: new Date() }),
      },
    });

  const creditConfidential = (hash: string) =>
    confidential.runPromise(Effect.either(creditUsdcDeposits([hash], ALCHEMY)));

  it("recognises a hop's arrival as internal, asking 1Click with the company's session, and flags nothing", async () => {
    // #given a hop out of the account that 1Click reports delivered to the
    // transit wallet
    const paid = await hop("depositing");
    const hash = mined([
      { to: company.transitAddress, amount: paid.amountOut },
    ]);
    oneClick.state.setStatus(paid.depositAddress, {
      status: "SUCCESS",
      destinationChainTxHashes: [hash],
    });
    const before = oneClick.state.calls.length;

    // #when Alchemy reports the transfer
    const outcome = await creditConfidential(hash);

    // #then it is the company's own money: nothing credited, nothing
    // flagged, and 1Click was asked about the hop with a session
    expect({
      outcome: outcome._tag,
      credited: outcome._tag === "Right" ? outcome.right.credited : null,
      ledger: await ledgerOf(db, company),
      alerts: await alerts(hash),
      statusCalls: oneClick.state.calls
        .slice(before)
        .filter(
          (entry) =>
            entry.call === "status" &&
            entry.depositAddress === paid.depositAddress,
        )
        .map((entry) => entry.session !== undefined),
    }).toEqual({
      outcome: "Right",
      credited: 0,
      ledger: [],
      alerts: [],
      statusCalls: [true],
    });
  });

  it("waits, without flagging, when the company can't be signed in, and recognises the arrival once it can", async () => {
    // #given a hop that settled a moment ago whose transaction 1Click has
    // not listed on our row yet, and a sign-in that Privy refuses
    const paid = await hop("succeeded");
    const hash = mined([
      { to: company.transitAddress, amount: paid.amountOut },
    ]);
    oneClick.state.setStatus(paid.depositAddress, {
      status: "SUCCESS",
      destinationChainTxHashes: [hash],
    });
    privy.state.nextNearSignings("refused");

    // #when Alchemy reports the transfer
    const waiting = await creditConfidential(hash);

    // #then it is to be retried and nothing was flagged or credited
    expect({
      outcome: waiting._tag === "Left" ? waiting.left._tag : "succeeded",
      ledger: await ledgerOf(db, company),
      alerts: await alerts(hash),
    }).toEqual({ outcome: "HopArrivalUnconfirmed", ledger: [], alerts: [] });

    // #when the retry finds sign-in working
    const retried = await creditConfidential(hash);

    // #then the arrival is internal
    expect({
      outcome: retried._tag,
      alerts: await alerts(hash),
    }).toEqual({ outcome: "Right", alerts: [] });
  });

  it("still flags USDC that no hop of the company explains", async () => {
    // #given a settled hop for a different amount than what arrived
    const paid = await hop("succeeded");
    const hash = mined([
      { to: company.transitAddress, amount: paid.amountOut + 1n, logIndex: 3 },
    ]);

    // #when Alchemy reports the transfer
    const outcome = await creditConfidential(hash);

    // #then it is raised for review, not credited
    expect({
      outcome: outcome._tag,
      ledger: await ledgerOf(db, company),
      alerts: (await alerts(hash)).map((alert) => alert.kind),
    }).toEqual({
      outcome: "Right",
      ledger: [],
      alerts: ["unexpected_transit_transfer"],
    });
  });
});
