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

import {
  activityPageSchema,
  cardSimulationResultSchema,
  staffCardSimulationsSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { CardCompany } from "../helpers/card-purchases.js";
import type { CardPaidPayment } from "../helpers/card-simulations.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { LithicSimulatorLive } from "../../services/card-simulations/lithic-simulator.js";
import { createCardCompany } from "../helpers/card-purchases.js";
import {
  cardPaidBill,
  cardPaidPayment,
  earlierSimulation,
  simulationsOf,
} from "../helpers/card-simulations.js";
import { sendJson } from "../helpers/claims.js";
import { makeFakeLithicSimulator } from "../helpers/lithic-simulator.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const simulator = makeFakeLithicSimulator();

let runtime: AppRuntime;
let app: App;
let db: Database;
let owner: pg.Pool;
let opsAdmin: TestStaff;
let opsViewer: TestStaff;
let card: CardCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({ lithicSimulator: simulator.layer });
  app = createApp({ runtime });
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  opsAdmin = await createStaff(owner, { role: "ops_admin" });
  opsViewer = await createStaff(owner, { role: "ops_viewer" });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  simulator.state.reset();
  card = await createCardCompany(db);
});

const path = (organizationId: string = card.company.organizationId) =>
  `/internal/companies/${organizationId}/card-simulations`;

const run = (
  who: { privyUserId: string },
  body: Record<string, unknown>,
  organizationId?: string,
) => sendJson(app, path(organizationId), who, { method: "POST", body });

const panel = (who: { privyUserId: string }) =>
  sendJson(app, path(), who, { method: "GET" });

async function dataOf(response: Response): Promise<unknown> {
  return ((await response.json()) as { data: unknown }).data;
}

async function errorOf(response: Response) {
  return (
    (await response.json()) as { error: { _tag: string; message: string } }
  ).error;
}

const chargedFor = (payment: CardPaidPayment) =>
  simulator.state.authorizations.filter(
    ({ cardToken }) => cardToken === payment.cardToken,
  );

function auditOf(simulationId: string | undefined) {
  return owner
    .query<{
      actor_type: string;
      actor_id: string;
      organization_id: string | null;
      action: string;
      after: Record<string, unknown>;
    }>(
      "SELECT actor_type, actor_id, organization_id, action, after FROM audit_log WHERE entity_type = 'card_simulation' AND entity_id = $1",
      [simulationId],
    )
    .then(({ rows }) => rows);
}

const MINUTE = 60_000;

describe("POST /internal/companies/:organizationId/card-simulations", () => {
  it("makes the pretend merchant's purchase for an ops admin, and audits it under them", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const billId = await cardPaidBill(db, payment);

    // #when
    const response = await run(opsAdmin, { recurringItemId: payment.itemId });

    // #then
    expect(response.status).toBe(201);
    const result = cardSimulationResultSchema.parse(await dataOf(response));
    expect(result).toMatchObject({ result: "approved", merchant: "ANTHROPIC" });
    const [simulation] = await simulationsOf(db, card.company);
    expect(simulation).toMatchObject({
      recurringItemId: payment.itemId,
      billId,
      lithicTransactionToken: result.transactionToken,
      amountUsdCents: 2_000n,
      runByStaff: opsAdmin.staffUserId,
    });
    expect(await auditOf(simulation?.id)).toEqual([
      {
        actor_type: "staff",
        actor_id: opsAdmin.staffUserId,
        organization_id: null,
        action: "card_simulation.made",
        after: {
          organizationId: card.company.organizationId,
          recurringItemId: payment.itemId,
          billId,
          amountUsdCents: "2000",
          merchant: "ANTHROPIC",
          merchantKey: simulation?.merchantKey,
          newMerchant: false,
          transactionToken: result.transactionToken,
        },
      },
    ]);
  });

  it("audits a purchase it couldn't read back, and reports its result as unknown", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    simulator.state.failReadBack = true;

    // #when
    const response = await run(opsAdmin, { recurringItemId: payment.itemId });

    // #then
    expect(response.status).toBe(201);
    const result = cardSimulationResultSchema.parse(await dataOf(response));
    expect(result.result).toBe("unknown");
    const [simulation] = await simulationsOf(db, card.company);
    expect(simulation?.lithicTransactionToken).toBe(result.transactionToken);
    expect(await auditOf(simulation?.id)).toMatchObject([
      {
        action: "card_simulation.made",
        after: { transactionToken: result.transactionToken },
      },
    ]);
  });

  it("audits an attempt Lithic didn't confirm, saying its outcome is unknown", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    simulator.state.failAuthorize = "ambiguous";

    // #when
    const response = await run(opsAdmin, { recurringItemId: payment.itemId });

    // #then
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toBe(
      "Lithic's sandbox didn't answer, so the purchase may or may not have been made. Check the card's purchases before trying again.",
    );
    const [simulation] = await simulationsOf(db, card.company);
    expect(simulation).toMatchObject({
      recurringItemId: payment.itemId,
      runByStaff: opsAdmin.staffUserId,
    });
    expect(await auditOf(simulation?.id)).toEqual([
      {
        actor_type: "staff",
        actor_id: opsAdmin.staffUserId,
        organization_id: null,
        action: "card_simulation.outcome_unknown",
        after: {
          organizationId: card.company.organizationId,
          recurringItemId: payment.itemId,
          billId: null,
          amountUsdCents: "2000",
          merchant: "ANTHROPIC",
          merchantKey: simulation?.merchantKey,
          newMerchant: false,
          outcome: "unknown",
          lithicError: "HTTP_502",
        },
      },
    ]);
    const { payments } = staffCardSimulationsSchema.parse(
      await dataOf(await panel(opsViewer)),
    );
    expect(payments[0]?.lastSimulation?.result).toBe("unknown");
  });

  it("records and audits nothing when Lithic refuses the purchase outright", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    simulator.state.failAuthorize = "refused";

    // #when
    const response = await run(opsAdmin, { recurringItemId: payment.itemId });

    // #then
    expect(response.status).toBe(503);
    expect(await simulationsOf(db, card.company)).toEqual([]);
    const { rows } = await owner.query(
      "SELECT 1 FROM audit_log WHERE entity_type = 'card_simulation' AND after->>'organizationId' = $1",
      [card.company.organizationId],
    );
    expect(rows).toEqual([]);
  });

  it("refuses an amount over the card's monthly limit", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      cardValues: { monthlyLimitUsdCents: 5_000n },
    });

    // #when
    const response = await run(opsAdmin, {
      recurringItemId: payment.itemId,
      amountUsd: "50.01",
    });

    // #then
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({
      _tag: "BadRequest",
      message: "That's more than this card's monthly limit of USD 50.00.",
    });
    expect(chargedFor(payment)).toEqual([]);
  });

  it("refuses an estimate over the card's monthly limit when no amount is given", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      cardValues: { monthlyLimitUsdCents: 1_500n },
    });

    // #when
    const response = await run(opsAdmin, { recurringItemId: payment.itemId });

    // #then
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(
      "That's more than this card's monthly limit of USD 15.00.",
    );
    expect(chargedFor(payment)).toEqual([]);
  });

  it("takes an amount of exactly the card's monthly limit", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      cardValues: { monthlyLimitUsdCents: 5_000n },
    });

    // #when
    const response = await run(opsAdmin, {
      recurringItemId: payment.itemId,
      amountUsd: "50.00",
    });

    // #then
    expect(response.status).toBe(201);
    expect(chargedFor(payment)).toMatchObject([{ amountUsdCents: 5_000n }]);
  });

  it("makes at most 20 staff purchases for a company in an hour", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    for (let i = 0; i < 19; i += 1) {
      await earlierSimulation(db, payment, null, {
        createdAt: new Date(Date.now() - 50 * MINUTE),
        runByStaff: opsAdmin.staffUserId,
      });
    }

    // #when
    const twentieth = await run(opsAdmin, { recurringItemId: payment.itemId });
    const twentyFirst = await run(opsAdmin, {
      recurringItemId: payment.itemId,
    });

    // #then
    expect(twentieth.status).toBe(201);
    expect(twentyFirst.status).toBe(429);
    expect(await errorOf(twentyFirst)).toMatchObject({
      _tag: "TooManyRequests",
      message:
        "Too many simulated purchases for this company in the last hour. Try again later.",
    });
    expect(chargedFor(payment)).toHaveLength(1);
  });

  it("keeps to 20 staff purchases an hour when two are asked for at once", async () => {
    // #given 19 this hour, and Lithic slow to answer
    const payment = await cardPaidPayment(db, card);
    for (let i = 0; i < 19; i += 1) {
      await earlierSimulation(db, payment, null, {
        createdAt: new Date(Date.now() - 50 * MINUTE),
        runByStaff: opsAdmin.staffUserId,
      });
    }
    let reachedLithic = 0;
    let answer = (): void => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    simulator.state.authorizeGate = () => {
      reachedLithic += 1;
      return answered;
    };

    // #when two arrive together
    const both = [
      run(opsAdmin, { recurringItemId: payment.itemId }),
      run(opsAdmin, { recurringItemId: payment.itemId }),
    ];
    const bothAtLithic = vi
      .waitUntil(() => reachedLithic === 2, { timeout: 3_000, interval: 10 })
      .catch(() => undefined);
    await Promise.race([Promise.any(both), bothAtLithic]);
    answer();
    const responses = await Promise.all(both);

    // #then
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(chargedFor(payment)).toHaveLength(1);
    expect(
      (await simulationsOf(db, card.company)).filter(
        ({ runByStaff }) => runByStaff !== null,
      ),
    ).toHaveLength(20);
  });

  it.each<[string, { readonly minutesAgo: number; readonly byStaff: boolean }]>(
    [
      ["staff purchases over an hour ago", { minutesAgo: 61, byStaff: true }],
      ["the daily job's purchases", { minutesAgo: 10, byStaff: false }],
    ],
  )("doesn't count %s toward the hourly limit", async (_case, earlier) => {
    // #given
    const payment = await cardPaidPayment(db, card);
    for (let i = 0; i < 20; i += 1) {
      await earlierSimulation(db, payment, null, {
        createdAt: new Date(Date.now() - earlier.minutesAgo * MINUTE),
        runByStaff: earlier.byStaff ? opsAdmin.staffUserId : null,
      });
    }

    // #when
    const response = await run(opsAdmin, { recurringItemId: payment.itemId });

    // #then
    expect(response.status).toBe(201);
  });

  it("doesn't count another company's staff purchases toward the hourly limit", async () => {
    // #given
    const elsewhere = await cardPaidPayment(db, await createCardCompany(db));
    for (let i = 0; i < 20; i += 1) {
      await earlierSimulation(db, elsewhere, null, {
        createdAt: new Date(Date.now() - 10 * MINUTE),
        runByStaff: opsAdmin.staffUserId,
      });
    }
    const payment = await cardPaidPayment(db, card);

    // #when
    const response = await run(opsAdmin, { recurringItemId: payment.itemId });

    // #then
    expect(response.status).toBe(201);
  });

  it("runs the last bill of a payment with an end date, still owed", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      item: { nextDueOn: null, endsOn: "2026-11-30" },
    });
    const billId = await cardPaidBill(db, payment);

    // #when
    const response = await run(opsAdmin, { recurringItemId: payment.itemId });

    // #then
    expect(response.status).toBe(201);
    const [simulation] = await simulationsOf(db, card.company);
    expect(simulation?.billId).toBe(billId);
  });

  it("takes another amount and a new merchant", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);

    // #when
    const response = await run(opsAdmin, {
      recurringItemId: payment.itemId,
      amountUsd: "12.50",
      newMerchant: true,
    });

    // #then
    expect(response.status).toBe(201);
    const [charged] = chargedFor(payment);
    expect(charged?.amountUsdCents).toBe(1_250n);
    expect(charged?.merchantAcceptorId).toMatch(/^NEW/);
  });

  it("reports a declined purchase", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    simulator.state.decide = () => "declined";

    // #when
    const response = await run(opsAdmin, { recurringItemId: payment.itemId });

    // #then
    expect(
      cardSimulationResultSchema.parse(await dataOf(response)).result,
    ).toBe("declined");
  });

  it("asks for an amount when the payment has no estimate", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      item: { amountUsdc: null },
    });

    // #when
    const response = await run(opsAdmin, { recurringItemId: payment.itemId });

    // #then
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(
      "Enter an amount: this payment has no estimate.",
    );
  });

  it("refuses a recurring payment that isn't the company's", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const elsewhere = await createCardCompany(db);

    // #when
    const response = await run(
      opsAdmin,
      { recurringItemId: payment.itemId },
      elsewhere.company.organizationId,
    );

    // #then
    expect(response.status).toBe(404);
    expect(chargedFor(payment)).toEqual([]);
  });

  it("refuses an ops viewer", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);

    // #when
    const response = await run(opsViewer, { recurringItemId: payment.itemId });

    // #then
    expect(response.status).toBe(403);
    expect((await errorOf(response))._tag).toBe("Forbidden");
    expect(chargedFor(payment)).toEqual([]);
  });

  it("refuses the company's own admin, and anyone without a login", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);

    // #when
    const statuses = [
      (await run(card.company.admin, { recurringItemId: payment.itemId }))
        .status,
      (await panel(card.company.admin)).status,
      (
        await app.request(path(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recurringItemId: payment.itemId }),
        })
      ).status,
    ];

    // #then
    expect(statuses).toEqual([403, 403, 401]);
    expect(chargedFor(payment)).toEqual([]);
  });

  it("stays out of the company's own activity log", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    await run(opsAdmin, { recurringItemId: payment.itemId });

    // #when
    const response = await sendJson(
      app,
      `/organizations/${card.company.organizationId}/activity`,
      card.company.admin,
    );

    // #then
    expect(response.status).toBe(200);
    const { entries } = activityPageSchema.parse(await dataOf(response));
    expect(entries.map(({ action }) => action)).not.toContain(
      "card_simulation.made",
    );
  });
});

describe("GET /internal/companies/:organizationId/card-simulations", () => {
  it("lists the card-paid recurring payments for any staff role", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const billId = await cardPaidBill(db, payment, {
      amountUsdc: 21_000_000n,
    });

    // #when
    const response = await panel(opsViewer);

    // #then
    expect(response.status).toBe(200);
    expect(staffCardSimulationsSchema.parse(await dataOf(response))).toEqual({
      available: true,
      payments: [
        {
          id: payment.itemId,
          payeeName: "Anthropic",
          state: "active",
          estimateUsdCents: "2000",
          card: {
            nickname: "Software subscriptions",
            lastFour: "1881",
            state: "open",
          },
          nextBill: {
            id: billId,
            dueOn: "2026-11-13",
            status: "due",
            amountUsdCents: "2100",
          },
          lastSimulation: null,
        },
      ],
    });
  });

  it("shows the last simulation and how the purchase check answered it", async () => {
    // #given
    const declined = await cardPaidPayment(db, card, { payeeName: "Notion" });
    const declinedBill = await cardPaidBill(db, declined);
    await earlierSimulation(db, declined, declinedBill, {
      createdAt: new Date("2026-11-12T07:00:00Z"),
      purchase: "declined",
    });
    const byStaff = await cardPaidPayment(db, card, { payeeName: "Vercel" });
    await run(opsAdmin, { recurringItemId: byStaff.itemId });

    // #when
    const { payments } = staffCardSimulationsSchema.parse(
      await dataOf(await panel(opsViewer)),
    );

    // #then
    expect(
      payments.map(({ payeeName, lastSimulation }) => ({
        payeeName,
        result: lastSimulation?.result,
        byStaff: lastSimulation?.byStaff,
      })),
    ).toEqual([
      { payeeName: "Notion", result: "declined", byStaff: false },
      { payeeName: "Vercel", result: null, byStaff: true },
    ]);
  });

  it("leaves out payments that aren't card-paid or have ended", async () => {
    // #given
    await cardPaidPayment(db, card, {
      item: {
        payVia: "expendi",
        cardId: null,
        currency: "kes",
        amountUsdc: null,
        amountKes: 250_000n,
      },
    });
    await cardPaidPayment(db, card, {
      item: { nextDueOn: null, endsOn: "2026-11-01" },
    });

    // #when
    const { payments } = staffCardSimulationsSchema.parse(
      await dataOf(await panel(opsViewer)),
    );

    // #then
    expect(payments).toEqual([]);
  });

  it("lists a payment with an end date while its last bill is still owed", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      item: { nextDueOn: null, endsOn: "2026-11-30" },
    });
    const billId = await cardPaidBill(db, payment);

    // #when
    const { payments } = staffCardSimulationsSchema.parse(
      await dataOf(await panel(opsViewer)),
    );

    // #then
    expect(payments).toMatchObject([
      { id: payment.itemId, nextBill: { id: billId } },
    ]);
  });

  it("says when Lithic's sandbox isn't set up", async () => {
    // #given
    simulator.state.configured = false;

    // #when
    const body = staffCardSimulationsSchema.parse(
      await dataOf(await panel(opsAdmin)),
    );

    // #then
    expect(body.available).toBe(false);
  });
});

describe("with simulated purchases turned off", () => {
  const network = vi.fn<typeof fetch>(() =>
    Promise.reject(new Error("no network in tests")),
  );
  let offRuntime: AppRuntime;
  let offApp: App;

  beforeAll(() => {
    vi.stubGlobal("fetch", network);
    offRuntime = makeTestRuntime(
      { lithicSimulator: LithicSimulatorLive },
      {
        LITHIC_API_KEY: "sandbox_key_never_used",
        CARD_SIMULATIONS_ENABLED: undefined,
      },
    );
    offApp = createApp({ runtime: offRuntime });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await offRuntime.dispose();
  });

  it("shows staff the panel as unavailable", async () => {
    // #when
    const response = await sendJson(offApp, path(), opsViewer, {
      method: "GET",
    });

    // #then
    expect(response.status).toBe(200);
    expect(
      staffCardSimulationsSchema.parse(await dataOf(response)).available,
    ).toBe(false);
  });

  it("refuses to make a purchase", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);

    // #when
    const response = await sendJson(offApp, path(), opsAdmin, {
      method: "POST",
      body: { recurringItemId: payment.itemId },
    });

    // #then
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({
      _tag: "ServiceUnavailable",
      message: "Simulated Card purchases are turned off on this API.",
    });
    expect(await simulationsOf(db, card.company)).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
});

it("is a route of the internal app, so its guard checks it", () => {
  // #then
  expect(
    app.routes
      .filter(({ path: routePath }) => routePath.endsWith("/card-simulations"))
      .map(({ method, path: routePath }) => `${method} ${routePath}`),
  ).toEqual(
    expect.arrayContaining([
      "GET /internal/companies/:organizationId/card-simulations",
      "POST /internal/companies/:organizationId/card-simulations",
    ]),
  );
});
