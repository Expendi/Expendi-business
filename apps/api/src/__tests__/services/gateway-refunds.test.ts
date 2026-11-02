import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TransactionReceipt } from "../../services/chain/base.js";
import type { PaycrestOrder } from "../../services/paycrest/paycrest-client.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { DatabaseService } from "../../db/client.js";
import { walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { syncPayoutOrder } from "../../services/payout/sync.js";
import { creditUsdcDeposits } from "../../services/wallet/deposits.js";
import {
  makeFakeBaseRpc,
  makeFakePaycrest,
  makeFakePrivyWallets,
  randomAddress,
} from "../helpers/fakes.js";
import {
  gatewayRefundReceipt,
  LIVE_GATEWAY_ORDER_ID,
  setGatewayOrder,
} from "../helpers/gateway-receipts.js";
import {
  claimRequest,
  createPayingCompany,
  ledgerBalance,
  payClaims,
  readPayout,
  updatePayout,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const ALCHEMY = { type: "system", id: "alchemy-webhook" } as const;
const OTHER_ORDER_ID = `0x${"c3".repeat(32)}`;

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const rpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let paying: PayingCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    baseRpc: rpc.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  rpc.state.callResults.clear();
  paying = await createPayingCompany(runtime, db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function payingPayout(company = paying): Promise<Payout> {
  const [payout] = await payClaims(runtime, db, company, [claimRequest()]);
  if (payout?.status !== "paying") throw new Error("payout isn't paying");
  return payout;
}

/** What Paycrest refunds: the order amount (we never add a sender fee). */
const refundOf = (payout: Payout): bigint => {
  if (payout.usdcAmount === null) throw new Error("payout has no amount");
  return payout.usdcAmount;
};

/** Paycrest's order now carries `transactionLogs`, as fetched live. */
function logOrder(
  payout: Payout,
  transactionLogs: PaycrestOrder["transactionLogs"],
): void {
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no order for payout");
  paycrest.state.orders.set(order.id, { ...order, transactionLogs });
}

const createdOn = (gatewayId: string): PaycrestOrder["transactionLogs"] => [
  {
    id: "log-1",
    status: "crypto_deposited",
    tx_hash: `0x${"d4".repeat(32)}`,
    gateway_id: "",
    created_at: "2026-11-01T21:48:26Z",
  },
  {
    id: "log-2",
    status: "order_created",
    tx_hash: `0x${"e5".repeat(32)}`,
    gateway_id: gatewayId,
    created_at: "2026-11-01T21:48:33Z",
  },
];

/** Syncs the payout with its order as freshly fetched from Paycrest. */
async function sync(payout: Payout, company = paying): Promise<Payout> {
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no order for payout");
  await runtime.runPromise(
    syncPayoutOrder({
      organizationId: company.company.organizationId,
      payoutId: payout.id,
      order,
      source: "webhook",
      touch: false,
    }),
  );
  return readPayout(db, company.company, payout.id);
}

async function payoutWithGatewayId(
  gatewayId = LIVE_GATEWAY_ORDER_ID,
  company = paying,
): Promise<Payout> {
  const payout = await payingPayout(company);
  logOrder(payout, createdOn(gatewayId));
  return sync(payout, company);
}

function credit(receipt: TransactionReceipt) {
  rpc.state.receipts.set(receipt.transactionHash, receipt);
  return runtime.runPromise(
    creditUsdcDeposits([receipt.transactionHash], ALCHEMY),
  );
}

async function ledgerRows(receipt: TransactionReceipt, company = paying) {
  return runInScope(
    db,
    { organizationId: company.company.organizationId },
    (tx) =>
      tx
        .select({
          type: walletTransactions.type,
          payoutId: walletTransactions.payoutId,
          usdcAmount: walletTransactions.usdcAmount,
        })
        .from(walletTransactions)
        .where(eq(walletTransactions.txHash, receipt.transactionHash)),
  );
}

describe("USDC from Paycrest's Gateway", () => {
  it("is the refund of the payout whose Gateway order the receipt names", async () => {
    // #given
    const payout = await payoutWithGatewayId();
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId: LIVE_GATEWAY_ORDER_ID,
    });

    // #when
    await credit(receipt);

    // #then
    expect(await ledgerRows(receipt)).toEqual([
      { type: "refund", payoutId: payout.id, usdcAmount: refundOf(payout) },
    ]);
  });

  it("is audited as the payout's refund", async () => {
    // #given
    const payout = await payoutWithGatewayId();
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId: LIVE_GATEWAY_ORDER_ID,
    });

    // #when
    await credit(receipt);

    // #then
    const { rows } = await owner.query<{ action: string; payout: string }>(
      "SELECT action, after->>'payoutId' AS payout FROM audit_log WHERE organization_id = $1 AND after->>'txHash' = $2",
      [paying.company.organizationId, receipt.transactionHash],
    );
    expect(rows).toEqual([
      { action: "wallet.refund_received", payout: payout.id },
    ]);
  });

  it("is credited once when Alchemy delivers it twice", async () => {
    // #given
    const payout = await payoutWithGatewayId();
    const before = await ledgerBalance(db, paying.company);
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId: LIVE_GATEWAY_ORDER_ID,
    });

    // #when
    await credit(receipt);
    const again = await credit(receipt);

    // #then
    expect({
      again,
      rows: (await ledgerRows(receipt)).length,
      credited: (await ledgerBalance(db, paying.company)) - before,
    }).toEqual({
      again: { credited: 0, alreadyCredited: 1 },
      rows: 1,
      credited: refundOf(payout),
    });
  });

  it("is a deposit when no payout has the Gateway order yet, with the balance right", async () => {
    // #given a payout of the same amount under another Gateway order
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const payout = await payoutWithGatewayId();
    const before = await ledgerBalance(db, paying.company);
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId: OTHER_ORDER_ID,
    });

    // #when
    await credit(receipt);

    // #then
    expect({
      rows: await ledgerRows(receipt),
      credited: (await ledgerBalance(db, paying.company)) - before,
    }).toEqual({
      rows: [{ type: "deposit", payoutId: null, usdcAmount: refundOf(payout) }],
      credited: refundOf(payout),
    });
  });

  it("is a deposit when no OrderRefunded event follows it", async () => {
    // #given the payout's own Gateway order and amount, but no event
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const payout = await payoutWithGatewayId();
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId: LIVE_GATEWAY_ORDER_ID,
      withoutEvent: true,
    });

    // #when
    await credit(receipt);

    // #then
    expect(await ledgerRows(receipt)).toEqual([
      { type: "deposit", payoutId: null, usdcAmount: refundOf(payout) },
    ]);
  });

  it("warns with the transaction hash when it can't be linked", async () => {
    // #given
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: 1_000_000n,
      orderId: OTHER_ORDER_ID,
    });

    // #when
    await credit(receipt);

    // #then
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(receipt.transactionHash),
    );
  });

  it("never links to another company's payout", async () => {
    // #given another company's payout has the Gateway order
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const other = await createPayingCompany(runtime, db);
    const theirs = await payoutWithGatewayId(LIVE_GATEWAY_ORDER_ID, other);
    const theirBalance = await ledgerBalance(db, other.company);
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(theirs),
      orderId: LIVE_GATEWAY_ORDER_ID,
    });

    // #when
    await credit(receipt);

    // #then
    expect({
      ours: await ledgerRows(receipt),
      theirs: await ledgerRows(receipt, other),
      theirBalance: await ledgerBalance(db, other.company),
    }).toEqual({
      ours: [{ type: "deposit", payoutId: null, usdcAmount: refundOf(theirs) }],
      theirs: [],
      theirBalance,
    });
  });
});

const randomOrderId = (): string => `0x${randomBytes(32).toString("hex")}`;

/** The Gateway holds `orderId` as created from the payout's deposit address. */
function createdOnGateway(
  orderId: string,
  payout: Payout,
  overrides: { sender?: string; refundAddress?: string; amount?: bigint } = {},
): void {
  setGatewayOrder(rpc.state.callResults, orderId, {
    sender: overrides.sender ?? payout.depositAddress ?? "",
    refundAddress: overrides.refundAddress ?? paying.wallet.address,
    amount: overrides.amount ?? refundOf(payout),
  });
}

describe("a Gateway refund that lands before sync has its Gateway order", () => {
  it("is linked to the payout whose deposit address created the order on the Gateway", async () => {
    // #given sync hasn't seen the order's Gateway ID (Paycrest 404s it)
    const payout = await payingPayout();
    const orderId = randomOrderId();
    createdOnGateway(orderId, payout);
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId,
    });

    // #when
    await credit(receipt);

    // #then
    expect(await ledgerRows(receipt)).toEqual([
      { type: "refund", payoutId: payout.id, usdcAmount: refundOf(payout) },
    ]);
  });

  it("saves the Gateway order on that payout", async () => {
    // #given
    const payout = await payingPayout();
    const orderId = randomOrderId();
    createdOnGateway(orderId, payout);

    // #when
    await credit(
      gatewayRefundReceipt({
        to: paying.wallet.address,
        amount: refundOf(payout),
        orderId,
      }),
    );

    // #then
    expect(
      (await readPayout(db, paying.company, payout.id)).gatewayOrderId,
    ).toBe(orderId);
  });

  it("agrees with a later sync that logs the same Gateway order", async () => {
    // #given the refund linked the order before Paycrest's logs arrived
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const payout = await payingPayout();
    const orderId = randomOrderId();
    createdOnGateway(orderId, payout);
    await credit(
      gatewayRefundReceipt({
        to: paying.wallet.address,
        amount: refundOf(payout),
        orderId,
      }),
    );
    logOrder(payout, createdOn(orderId));

    // #when
    const synced = await sync(payout);

    // #then
    expect({ saved: synced.gatewayOrderId, errors: error.mock.calls }).toEqual({
      saved: orderId,
      errors: [],
    });
  });

  it("is a deposit when the Gateway's order was created by another address", async () => {
    // #given a payout of the same amount, but its deposit address didn't create the order
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const payout = await payingPayout();
    const orderId = randomOrderId();
    createdOnGateway(orderId, payout, { sender: randomAddress() });
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId,
    });

    // #when
    await credit(receipt);

    // #then
    expect(await ledgerRows(receipt)).toEqual([
      { type: "deposit", payoutId: null, usdcAmount: refundOf(payout) },
    ]);
  });

  it("is a deposit when the Gateway's order is for another amount", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const payout = await payingPayout();
    const orderId = randomOrderId();
    createdOnGateway(orderId, payout, { amount: refundOf(payout) + 1n });
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId,
    });

    // #when
    await credit(receipt);

    // #then
    expect((await ledgerRows(receipt)).map((row) => row.type)).toEqual([
      "deposit",
    ]);
  });

  it("is a deposit when the Gateway's order refunds to another wallet", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const payout = await payingPayout();
    const orderId = randomOrderId();
    createdOnGateway(orderId, payout, { refundAddress: randomAddress() });
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId,
    });

    // #when
    await credit(receipt);

    // #then
    expect((await ledgerRows(receipt)).map((row) => row.type)).toEqual([
      "deposit",
    ]);
  });

  it("is a deposit when the order was created by another company's payout", async () => {
    // #given another company's deposit address created the order
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const other = await createPayingCompany(runtime, db);
    const theirs = await payingPayout(other);
    const orderId = randomOrderId();
    createdOnGateway(orderId, theirs);
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(theirs),
      orderId,
    });

    // #when
    await credit(receipt);

    // #then
    expect({
      ours: await ledgerRows(receipt),
      theirGatewayOrder: (await readPayout(db, other.company, theirs.id))
        .gatewayOrderId,
    }).toEqual({
      ours: [{ type: "deposit", payoutId: null, usdcAmount: refundOf(theirs) }],
      theirGatewayOrder: null,
    });
  });

  it("never replaces another Gateway order already saved on the payout", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const payout = await payoutWithGatewayId(OTHER_ORDER_ID);
    const orderId = randomOrderId();
    createdOnGateway(orderId, payout);
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId,
    });

    // #when
    await credit(receipt);

    // #then
    expect({
      type: (await ledgerRows(receipt)).map((row) => row.type),
      saved: (await readPayout(db, paying.company, payout.id)).gatewayOrderId,
    }).toEqual({ type: ["deposit"], saved: OTHER_ORDER_ID });
  });

  it("is a deposit, credited once, when the Gateway can't be read", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const payout = await payingPayout();
    const before = await ledgerBalance(db, paying.company);
    const orderId = randomOrderId();
    createdOnGateway(orderId, payout);
    rpc.state.failNextCalls(1);
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId,
    });

    // #when
    const summary = await credit(receipt);

    // #then
    expect({
      summary,
      rows: await ledgerRows(receipt),
      credited: (await ledgerBalance(db, paying.company)) - before,
    }).toEqual({
      summary: { credited: 1, alreadyCredited: 0 },
      rows: [{ type: "deposit", payoutId: null, usdcAmount: refundOf(payout) }],
      credited: refundOf(payout),
    });
  });

  it("isn't credited again when Alchemy redelivers it after a failed read", async () => {
    // #given the first delivery couldn't read the Gateway
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const payout = await payingPayout();
    const before = await ledgerBalance(db, paying.company);
    const orderId = randomOrderId();
    createdOnGateway(orderId, payout);
    rpc.state.failNextCalls(1);
    const receipt = gatewayRefundReceipt({
      to: paying.wallet.address,
      amount: refundOf(payout),
      orderId,
    });
    await credit(receipt);

    // #when the redelivery can read it
    const again = await credit(receipt);

    // #then
    expect({
      again,
      rows: (await ledgerRows(receipt)).length,
      credited: (await ledgerBalance(db, paying.company)) - before,
    }).toEqual({
      again: { credited: 0, alreadyCredited: 1 },
      rows: 1,
      credited: refundOf(payout),
    });
  });
});

describe("saving the Gateway order ID", () => {
  it("saves the Gateway order ID Paycrest logs for the order", async () => {
    // #given
    const payout = await payingPayout();
    logOrder(payout, createdOn(LIVE_GATEWAY_ORDER_ID.toUpperCase()));

    // #when
    const synced = await sync(payout);

    // #then
    expect(synced.gatewayOrderId).toBe(LIVE_GATEWAY_ORDER_ID);
  });

  it("never replaces a saved Gateway order ID with a different one", async () => {
    // #given
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const payout = await payoutWithGatewayId();
    logOrder(payout, createdOn(OTHER_ORDER_ID));

    // #when
    const synced = await sync(payout);

    // #then
    expect({
      saved: synced.gatewayOrderId,
      logged: error.mock.calls.some((args) =>
        String(args[0]).includes(OTHER_ORDER_ID),
      ),
    }).toEqual({ saved: LIVE_GATEWAY_ORDER_ID, logged: true });
  });

  it("saves nothing when the order's logs name two Gateway orders", async () => {
    // #given
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const payout = await payingPayout();
    logOrder(payout, [
      ...(createdOn(LIVE_GATEWAY_ORDER_ID) ?? []),
      ...(createdOn(OTHER_ORDER_ID) ?? []),
    ]);

    // #when
    const synced = await sync(payout);

    // #then
    expect(synced.gatewayOrderId).toBeNull();
  });

  it("saves it in the same sync that fails a refunded payout", async () => {
    // #given the order 404'd until Paycrest had refunded it
    const payout = await payingPayout();
    logOrder(payout, createdOn(LIVE_GATEWAY_ORDER_ID));
    const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
    if (!order) throw new Error("no order for payout");
    paycrest.state.orders.set(order.id, { ...order, status: "refunded" });

    // #when
    const synced = await sync(payout);

    // #then
    expect({
      status: synced.status,
      gatewayOrderId: synced.gatewayOrderId,
    }).toEqual({ status: "failed", gatewayOrderId: LIVE_GATEWAY_ORDER_ID });
  });

  it("leaves a payout's Gateway order ID alone on a failed payout's later syncs", async () => {
    // #given
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const payout = await payoutWithGatewayId();
    await updatePayout(db, paying.company, payout.id, { status: "failed" });
    logOrder(payout, createdOn(OTHER_ORDER_ID));

    // #when
    const synced = await sync(payout);

    // #then
    expect(synced.gatewayOrderId).toBe(LIVE_GATEWAY_ORDER_ID);
  });
});
