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
import type { NewBill } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { CardCompany } from "../helpers/card-purchases.js";
import type { CardPaidPayment } from "../helpers/card-simulations.js";
import type { TestStaff } from "../helpers/staff.js";
import { DatabaseService } from "../../db/client.js";
import { runDueCardSimulations } from "../../services/card-simulations/daily.js";
import { LithicSimulatorLive } from "../../services/card-simulations/lithic-simulator.js";
import { simulateCardPurchase } from "../../services/card-simulations/simulate.js";
import { cardSimulationsJob } from "../../station/card-simulations.js";
import { IDLE } from "../../station/scheduler.js";
import { createCardCompany } from "../helpers/card-purchases.js";
import {
  cardPaidBill,
  cardPaidPayment,
  earlierSimulation,
  setCardState,
  simulationsOf,
} from "../helpers/card-simulations.js";
import { makeFakeLithicSimulator } from "../helpers/lithic-simulator.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The job charges every company's card-paid bills, so it runs on its own
 * after the main suite. Other files' bills may be charged too; each test
 * looks only at its own card.
 */

const simulator = makeFakeLithicSimulator();

let runtime: AppRuntime;
let db: Database;
let card: CardCompany;
let staff: TestStaff;

beforeAll(async () => {
  runtime = makeTestRuntime({ lithicSimulator: simulator.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  card = await createCardCompany(db);
  const owner = new pg.Pool({
    connectionString: TEST_DATABASE_URL_MIGRATE,
    max: 1,
  });
  staff = await createStaff(owner, { role: "ops_admin" });
  await owner.end();
});

afterAll(async () => {
  await runtime.dispose();
});

const failures: string[] = [];

beforeEach(() => {
  simulator.state.reset();
  failures.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    failures.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A bill the job tried and failed on, rather than left alone. */
const failedOn = (billId: string) =>
  failures.filter((failure) => failure.includes(billId));

/** 13 Nov 2026, 10:00 in Nairobi. */
const NOW = new Date("2026-11-13T07:00:00Z");
const HOUR = 60 * 60 * 1000;

const EVERYTHING_DUE = 10_000;

const runJob = (now: Date = NOW, maxPerRun = EVERYTHING_DUE) =>
  runtime.runPromise(runDueCardSimulations(now, maxPerRun));

const chargedFor = (payment: CardPaidPayment) =>
  simulator.state.authorizations.filter(
    ({ cardToken }) => cardToken === payment.cardToken,
  );

async function paymentWithBill(
  bill: Partial<NewBill> = {},
  options: Parameters<typeof cardPaidPayment>[2] = {},
) {
  const payment = await cardPaidPayment(db, card, options);
  const billId = await cardPaidBill(db, payment, bill);
  return { payment, billId };
}

describe("which bills the job charges", () => {
  it("charges a bill due today for the estimate, from the usual merchant, and records it", async () => {
    // #given
    const { payment, billId } = await paymentWithBill();

    // #when
    const run = await runJob();

    // #then
    expect(run).toMatchObject({ today: "2026-11-13" });
    expect(chargedFor(payment)).toMatchObject([
      { amountUsdCents: 2_000n, descriptor: "ANTHROPIC" },
    ]);
    expect(
      (await simulationsOf(db, card.company)).filter(
        ({ recurringItemId }) => recurringItemId === payment.itemId,
      ),
    ).toMatchObject([
      {
        billId,
        amountUsdCents: 2_000n,
        runByStaff: null,
        createdAt: NOW,
        merchantKey: chargedFor(payment)[0]?.merchantAcceptorId,
      },
    ]);
  });

  it("charges an overdue bill", async () => {
    // #given
    const { payment } = await paymentWithBill({
      dueOn: "2026-11-10",
      status: "overdue",
    });

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toHaveLength(1);
  });

  it("charges a bill's own amount when the payment has no estimate", async () => {
    // #given
    const { payment } = await paymentWithBill(
      { variable: true, amountUsdc: 45_670_000n },
      { item: { amountUsdc: null } },
    );

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toMatchObject([{ amountUsdCents: 4_567n }]);
  });

  it("charges on a frozen card: the decline is the point", async () => {
    // #given
    const { payment } = await paymentWithBill();
    await setCardState(db, payment, "frozen");

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toHaveLength(1);
  });

  it.each<[string, Partial<NewBill>]>([
    ["is not due yet", { dueOn: "2026-11-14", status: "upcoming" }],
    ["is already paid", { status: "paid_outside", paidOn: "2026-11-12" }],
  ])("skips a bill that %s", async (_case, bill) => {
    // #given
    const { payment, billId } = await paymentWithBill({
      ...bill,
      ...(bill.status === "paid_outside" && {
        paidAt: NOW,
        markedPaidBy: card.company.admin.id,
      }),
    });

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toEqual([]);
    expect(failedOn(billId)).toEqual([]);
  });

  it("skips a paused payment", async () => {
    // #given
    const { payment, billId } = await paymentWithBill(
      {},
      { item: { active: false } },
    );

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toEqual([]);
    expect(failedOn(billId)).toEqual([]);
  });

  it("charges the last bill of a payment with an end date, still owed", async () => {
    // #given
    const { payment, billId } = await paymentWithBill(
      {},
      { item: { nextDueOn: null, endsOn: "2026-11-13" } },
    );

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toHaveLength(1);
    expect(failedOn(billId)).toEqual([]);
  });

  it("skips a payment that has ended, its last bill cancelled", async () => {
    // #given
    const { payment, billId } = await paymentWithBill(
      {
        status: "cancelled",
        cancelledReason: "Moved to annual billing",
        cancelledBy: card.company.admin.id,
        cancelledAt: NOW,
      },
      { item: { nextDueOn: null, endsOn: "2026-11-13" } },
    );

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toEqual([]);
    expect(failedOn(billId)).toEqual([]);
  });

  it("skips a payment with no estimate whose bill has no amount yet", async () => {
    // #given
    const { payment, billId } = await paymentWithBill(
      { variable: true, amountUsdc: null },
      { item: { amountUsdc: null } },
    );

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toEqual([]);
    expect(failedOn(billId)).toEqual([]);
  });

  it("skips a closed card", async () => {
    // #given
    const { payment, billId } = await paymentWithBill();
    await setCardState(db, payment, "closed");

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toEqual([]);
    expect(failedOn(billId)).toEqual([]);
  });

  it("skips a payment that isn't paid by card", async () => {
    // #given
    const { payment } = await paymentWithBill(
      { currency: "kes", amountUsdc: null, amountKes: 250_000n },
      {
        item: {
          payVia: "expendi",
          cardId: null,
          currency: "kes",
          amountUsdc: null,
          amountKes: 250_000n,
        },
      },
    );

    // #when
    await runJob();

    // #then
    expect(
      (await simulationsOf(db, card.company)).filter(
        ({ recurringItemId }) => recurringItemId === payment.itemId,
      ),
    ).toEqual([]);
  });
});

describe("charging a bill again", () => {
  it("never charges twice when the job runs again straight away", async () => {
    // #given
    const { payment } = await paymentWithBill();

    // #when
    await runJob();
    await runJob(new Date(NOW.getTime() + 5 * 60_000));

    // #then
    expect(chargedFor(payment)).toHaveLength(1);
  });

  it.each(["pending", "settled"] as const)(
    "skips a bill whose earlier purchase is %s, however long ago",
    async (purchase) => {
      // #given
      const { payment, billId } = await paymentWithBill();
      await earlierSimulation(db, payment, billId, {
        createdAt: new Date(NOW.getTime() - 72 * HOUR),
        purchase,
      });

      // #when
      await runJob();

      // #then
      expect(chargedFor(payment)).toEqual([]);
    },
  );

  it.each([
    ["a declined purchase", "declined" as const],
    ["a purchase the check hasn't seen yet", undefined],
  ])(
    "skips a bill tried in the last 20 hours, after %s",
    async (_case, purchase) => {
      // #given
      const { payment, billId } = await paymentWithBill();
      await earlierSimulation(db, payment, billId, {
        createdAt: new Date(NOW.getTime() - 19 * HOUR),
        ...(purchase && { purchase }),
      });

      // #when
      await runJob();

      // #then
      expect(chargedFor(payment)).toEqual([]);
    },
  );

  it("tries again the next day after a decline, as a merchant would", async () => {
    // #given
    const { payment, billId } = await paymentWithBill({
      dueOn: "2026-11-12",
      status: "overdue",
    });
    await earlierSimulation(db, payment, billId, {
      createdAt: new Date(NOW.getTime() - 25 * HOUR),
      purchase: "declined",
    });

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toHaveLength(1);
  });

  it("never charges again when Lithic made the purchase but it couldn't be read back", async () => {
    // #given
    const { payment, billId } = await paymentWithBill();
    simulator.state.failReadBack = true;

    // #when
    const first = await runJob();
    simulator.state.failReadBack = false;
    await runJob(new Date(NOW.getTime() + 15 * 60_000));

    // #then
    expect(first?.unknown).toBeGreaterThanOrEqual(1);
    expect(chargedFor(payment)).toHaveLength(1);
    expect(
      (await simulationsOf(db, card.company)).filter(
        (simulation) => simulation.billId === billId,
      ),
    ).toMatchObject([
      { lithicTransactionToken: chargedFor(payment)[0]?.transactionToken },
    ]);
  });

  it("holds back for 20 hours after Lithic didn't answer whether it made the purchase, then tries again", async () => {
    // #given
    const { payment, billId } = await paymentWithBill();
    simulator.state.failAuthorize = "ambiguous";

    // #when
    await runJob();
    simulator.state.failAuthorize = null;
    await runJob(new Date(NOW.getTime() + 15 * 60_000));
    const heldBack = chargedFor(payment).length;
    await runJob(new Date(NOW.getTime() + 21 * HOUR));

    // #then
    expect(heldBack).toBe(1);
    expect(chargedFor(payment)).toHaveLength(2);
    const attempts = (await simulationsOf(db, card.company)).filter(
      (simulation) => simulation.billId === billId,
    );
    expect(
      attempts.map(({ lithicTransactionToken }) =>
        lithicTransactionToken.startsWith("unconfirmed:"),
      ),
    ).toEqual([true, false]);
  });

  it("tries again on the next run when Lithic refused the purchase outright", async () => {
    // #given
    const { payment, billId } = await paymentWithBill();
    simulator.state.failAuthorize = "refused";

    // #when
    await runJob();
    const refusedAttempts = (await simulationsOf(db, card.company)).filter(
      (simulation) => simulation.billId === billId,
    );
    simulator.state.failAuthorize = null;
    await runJob(new Date(NOW.getTime() + 15 * 60_000));

    // #then
    expect(refusedAttempts).toEqual([]);
    expect(chargedFor(payment)).toHaveLength(1);
    expect(failedOn(billId)).not.toEqual([]);
  });

  it("isn't held back by staff purchases, however many", async () => {
    // #given
    const { payment } = await paymentWithBill();
    const staffRun = await cardPaidPayment(db, card);
    for (let i = 0; i < 25; i += 1) {
      await earlierSimulation(db, staffRun, null, {
        createdAt: new Date(NOW.getTime() - 10 * 60_000),
        runByStaff: staff.staffUserId,
      });
    }

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toHaveLength(1);
  });

  it("still charges a bill staff charged from a new merchant", async () => {
    // #given a company of its own, under its staff limit; an admin may
    // answer that merchant one-off, and the bill stays owed
    const payment = await cardPaidPayment(db, await createCardCompany(db));
    await cardPaidBill(db, payment);
    await runtime.runPromise(
      simulateCardPurchase({
        organizationId: payment.company.organizationId,
        recurringItemId: payment.itemId,
        newMerchant: true,
        runBy: { kind: "staff", staffUserId: staff.staffUserId },
        now: new Date(NOW.getTime() - HOUR),
      }),
    );

    // #when
    await runJob();

    // #then
    expect(
      chargedFor(payment).map(({ descriptor }) =>
        descriptor.startsWith("ANTHROPIC NEW"),
      ),
    ).toEqual([true, false]);
  });

  it("only counts tries for this bill", async () => {
    // #given
    const { payment } = await paymentWithBill();
    const otherBill = await paymentWithBill();
    await earlierSimulation(db, otherBill.payment, otherBill.billId, {
      createdAt: new Date(NOW.getTime() - HOUR),
      purchase: "settled",
    });

    // #when
    await runJob();

    // #then
    expect(chargedFor(payment)).toHaveLength(1);
  });
});

describe("a run", () => {
  it("makes no more purchases than its cap", async () => {
    // #given
    await paymentWithBill();
    await paymentWithBill();

    // #when
    const run = await runJob(NOW, 1);

    // #then
    expect(run).not.toBeNull();
    expect((run?.approved ?? 0) + (run?.declined ?? 0)).toBe(1);
    expect(simulator.state.authorizations).toHaveLength(1);
  });

  it("counts declines apart from approvals", async () => {
    // #given
    const { payment } = await paymentWithBill();
    simulator.state.decide = ({ cardToken }) =>
      cardToken === payment.cardToken ? "declined" : "approved";

    // #when
    const run = await runJob();

    // #then
    expect(run?.declined).toBeGreaterThanOrEqual(1);
    expect(simulator.state.clearings).not.toContain(
      chargedFor(payment)[0]?.transactionToken,
    );
  });

  it("tells the station about purchases whose result couldn't be read back", async () => {
    // #given
    await paymentWithBill({ dueOn: "2026-01-13", status: "overdue" });
    simulator.state.failReadBack = true;

    // #when
    const station = await runtime.runPromise(cardSimulationsJob.run);

    // #then
    expect(station).not.toBe(IDLE);
    expect(station).toMatchObject({ approved: 0, declined: 0 });
  });

  it("does nothing, and the station hears nothing, when simulated purchases are turned off", async () => {
    // #given
    const { payment } = await paymentWithBill();
    const network = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error("no network in tests")),
    );
    vi.stubGlobal("fetch", network);
    const off = makeTestRuntime(
      { lithicSimulator: LithicSimulatorLive },
      {
        LITHIC_API_KEY: "sandbox_key_never_used",
        CARD_SIMULATIONS_ENABLED: undefined,
      },
    );

    // #when
    const run = await off.runPromise(runDueCardSimulations(NOW));
    const station = await off.runPromise(cardSimulationsJob.run);
    await off.dispose();

    // #then
    expect(run).toBeNull();
    expect(station).toBe(IDLE);
    expect(network).not.toHaveBeenCalled();
    expect(
      (await simulationsOf(db, card.company)).filter(
        ({ recurringItemId }) => recurringItemId === payment.itemId,
      ),
    ).toEqual([]);
  });

  it("does nothing, and the station hears nothing, when Lithic's sandbox isn't set up", async () => {
    // #given
    const { payment } = await paymentWithBill();
    simulator.state.configured = false;

    // #when
    const run = await runJob();
    const station = await runtime.runPromise(cardSimulationsJob.run);

    // #then
    expect(run).toBeNull();
    expect(station).toBe(IDLE);
    expect(chargedFor(payment)).toEqual([]);
  });
});
