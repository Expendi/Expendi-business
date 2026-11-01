import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  makeFakePaycrest,
  makeFakePrivyWallets,
  signPaycrestBody,
} from "../helpers/fakes.js";
import {
  claimRequest,
  createPayingCompany,
  payClaims,
  readPayout,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let paying: PayingCompany;
let payout: Payout;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  paying = await createPayingCompany(runtime, db);
  const [paid] = await payClaims(runtime, db, paying, [claimRequest()]);
  if (paid?.status !== "paying") throw new Error("payout isn't paying");
  payout = paid;
});

function settleOrder(status = "settled"): void {
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no order");
  paycrest.state.orders.set(order.id, {
    ...order,
    status,
    paymentReference: "SKL3ABCDEF",
  });
}

/** Paycrest's real shape: webhookVersion "1" and no data.direction. */
function delivery(
  overrides: { event?: string; orderId?: string; direction?: string } = {},
): string {
  return JSON.stringify({
    event: overrides.event ?? "payment_order.settled",
    webhookVersion: "1",
    data: {
      id: overrides.orderId ?? payout.providerOrderId,
      status: "settled",
      ...(overrides.direction && { direction: overrides.direction }),
    },
  });
}

async function deliver(
  body: string,
  signature: string | null = signPaycrestBody(body),
): Promise<Response> {
  return app.request("/webhooks/paycrest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature !== null && { "x-paycrest-signature": signature }),
    },
    body,
  });
}

const status = async () =>
  (await readPayout(db, paying.company, payout.id)).status;

describe("POST /webhooks/paycrest", () => {
  it("marks the payout paid from a signed v1 delivery with no direction", async () => {
    // #given
    settleOrder();

    // #when
    const response = await deliver(delivery());

    // #then
    expect({ http: response.status, status: await status() }).toEqual({
      http: 200,
      status: "paid",
    });
  });

  it("updates the payout once when the same delivery arrives twice", async () => {
    // #given
    settleOrder();
    await deliver(delivery());

    // #when
    await deliver(delivery());

    // #then
    const { rows } = await owner.query(
      "SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'payout.paid'",
      [payout.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("trusts Paycrest's order, not the delivery's body", async () => {
    // #given the delivery says settled but Paycrest still reports pending
    settleOrder("pending");

    // #when
    await deliver(delivery());

    // #then
    expect(await status()).toBe("paying");
  });

  it("rejects and logs a bad signature, changing nothing", async () => {
    // #given
    settleOrder();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = delivery();

    try {
      // #when
      const response = await deliver(body, signPaycrestBody(`${body} `));

      // #then
      expect({
        http: response.status,
        status: await status(),
        logged: warn.mock.calls.some(([message]) =>
          String(message).includes("bad signature"),
        ),
      }).toEqual({ http: 401, status: "paying", logged: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects a delivery with no signature", async () => {
    // #when
    const response = await deliver(delivery(), null);

    // #then
    expect(response.status).toBe(401);
  });

  it("ignores an order it doesn't know", async () => {
    // #when
    const response = await deliver(delivery({ orderId: "order-unknown" }));

    // #then
    expect(await response.json()).toEqual({ ignored: true });
  });

  it("ignores an on-ramp order", async () => {
    // #given
    settleOrder();

    // #when
    const response = await deliver(delivery({ direction: "onramp" }));

    // #then
    expect({ body: await response.json(), status: await status() }).toEqual({
      body: { ignored: true },
      status: "paying",
    });
  });

  it("asks Paycrest to retry when it can't re-fetch the order", async () => {
    // #given
    paycrest.state.failGetOrder = true;

    // #when
    const response = await deliver(delivery());

    // #then
    expect(response.status).toBe(500);
  });

  it("rejects malformed JSON", async () => {
    // #when
    const response = await deliver("{not json");

    // #then
    expect(response.status).toBe(400);
  });
});
