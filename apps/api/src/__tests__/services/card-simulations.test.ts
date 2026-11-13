import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Cause, Exit, Layer, Option, Redacted } from "effect";
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
import type { AppRuntime } from "../../runtime.js";
import type { SimulateCardPurchaseInput } from "../../services/card-simulations/simulate.js";
import type { CardCompany } from "../helpers/card-purchases.js";
import type { CardPaidPayment } from "../helpers/card-simulations.js";
import { DatabaseService } from "../../db/client.js";
import { bills, cardPurchases, recurringItems } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  LithicSimulator,
  makeLithicSimulator,
} from "../../services/card-simulations/lithic-simulator.js";
import {
  isUnconfirmedToken,
  simulateCardPurchase,
} from "../../services/card-simulations/simulate.js";
import { LITHIC_SANDBOX_URL } from "../../services/lithic/lithic-client.js";
import { readBill } from "../helpers/bills.js";
import { createCardCompany } from "../helpers/card-purchases.js";
import {
  cardPaidBill,
  cardPaidPayment,
  setCardState,
  simulationsOf,
} from "../helpers/card-simulations.js";
import { makeFakeLithicSimulator } from "../helpers/lithic-simulator.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const simulator = makeFakeLithicSimulator();

let runtime: AppRuntime;
let db: Database;
let card: CardCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({ lithicSimulator: simulator.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  card = await createCardCompany(db);
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(() => {
  simulator.state.reset();
});

const simulate = (
  payment: CardPaidPayment,
  input: Partial<SimulateCardPurchaseInput> = {},
) =>
  runtime.runPromiseExit(
    simulateCardPurchase({
      organizationId: payment.company.organizationId,
      recurringItemId: payment.itemId,
      runBy: { kind: "job" },
      ...input,
    }),
  );

async function simulated(
  payment: CardPaidPayment,
  input: Partial<SimulateCardPurchaseInput> = {},
) {
  const exit = await simulate(payment, input);
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
}

async function refusal(
  payment: CardPaidPayment,
  input: Partial<SimulateCardPurchaseInput> = {},
) {
  const exit = await simulate(payment, input);
  if (Exit.isSuccess(exit)) throw new Error("expected a refusal");
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  return failure && { tag: failure._tag, message: failure.message };
}

const authorizedFor = (payment: CardPaidPayment) =>
  simulator.state.authorizations.filter(
    ({ cardToken }) => cardToken === payment.cardToken,
  );

describe("the amount", () => {
  it("is the one given, ahead of the bill and the estimate", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    await cardPaidBill(db, payment, { amountUsdc: 31_500_000n });

    // #when
    const purchase = await simulated(payment, { amountUsdCents: 1_234n });

    // #then
    expect(purchase.amountUsdCents).toBe(1_234n);
    expect(authorizedFor(payment)).toMatchObject([{ amountUsdCents: 1_234n }]);
  });

  it("is the bill still owed when none is given", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const billId = await cardPaidBill(db, payment, {
      amountUsdc: 31_500_000n,
    });

    // #when
    const purchase = await simulated(payment);

    // #then
    expect(purchase).toMatchObject({ amountUsdCents: 3_150n, billId });
  });

  it("is the estimate when no bill is owed", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);

    // #when
    const purchase = await simulated(payment);

    // #then
    expect(purchase).toMatchObject({ amountUsdCents: 2_000n, billId: null });
  });

  it("is the estimate when the bill's amount isn't entered yet", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    await cardPaidBill(db, payment, { variable: true, amountUsdc: null });

    // #when
    const purchase = await simulated(payment);

    // #then
    expect(purchase.amountUsdCents).toBe(2_000n);
  });

  it("must be entered when there is no estimate and no bill amount", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      item: { amountUsdc: null },
    });
    await cardPaidBill(db, payment, { variable: true, amountUsdc: null });

    // #when
    const refused = await refusal(payment);

    // #then
    expect(refused).toEqual({
      tag: "BadRequest",
      message: "Enter an amount: this payment has no estimate.",
    });
    expect(authorizedFor(payment)).toEqual([]);
  });

  it("rounds a part of a cent up", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      item: { amountUsdc: 10_000_001n },
    });

    // #when
    const purchase = await simulated(payment);

    // #then
    expect(purchase.amountUsdCents).toBe(1_001n);
  });
});

describe("the pretend merchant", () => {
  it("is the same every time for a recurring payment, named after its payee", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      payeeName: "  Vercel Inc. hosting and previews ",
    });

    // #when
    const first = await simulated(payment);
    const second = await simulated(payment);

    // #then
    expect(first.merchant).toBe("VERCEL INC. HOSTING AND P");
    expect(first.merchant.length).toBeLessThanOrEqual(25);
    expect(first.merchantKey.length).toBeLessThanOrEqual(15);
    expect(second).toMatchObject({
      merchant: first.merchant,
      merchantKey: first.merchantKey,
    });
    expect(authorizedFor(payment).map((a) => a.merchantAcceptorId)).toEqual([
      first.merchantKey,
      first.merchantKey,
    ]);
  });

  it("differs between recurring payments", async () => {
    // #given
    const one = await cardPaidPayment(db, card);
    const other = await cardPaidPayment(db, card);

    // #when
    const keys = [
      (await simulated(one)).merchantKey,
      (await simulated(other)).merchantKey,
    ];

    // #then
    expect(new Set(keys).size).toBe(2);
  });

  it("is a new one, visibly, every time staff ask for one", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const usual = await simulated(payment);

    // #when
    const first = await simulated(payment, { newMerchant: true });
    const second = await simulated(payment, { newMerchant: true });

    // #then
    const keys = [usual, first, second].map(({ merchantKey }) => merchantKey);
    const names = [usual, first, second].map(({ merchant }) => merchant);
    expect(new Set(keys).size).toBe(3);
    expect(new Set(names).size).toBe(3);
    expect(first.merchant).toMatch(/^ANTHROPIC NEW [0-9A-F]{5}$/);
    expect(keys.every((key) => key.length <= 15)).toBe(true);
  });
});

describe("what it records", () => {
  it("records the purchase it made, for the bill, and settles an approved one", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const billId = await cardPaidBill(db, payment);

    // #when
    const purchase = await simulated(payment);

    // #then
    expect(purchase.result).toBe("approved");
    expect(simulator.state.clearings).toEqual([purchase.transactionToken]);
    expect(await simulationsOf(db, payment.company)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: purchase.simulationId,
          recurringItemId: payment.itemId,
          billId,
          lithicTransactionToken: purchase.transactionToken,
          amountUsdCents: 2_000n,
          merchantKey: purchase.merchantKey,
          runByStaff: null,
        }),
      ]),
    );
  });

  it("records no bill for a new merchant's purchase: it isn't that bill's merchant", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    await cardPaidBill(db, payment, { amountUsdc: 31_500_000n });

    // #when
    const purchase = await simulated(payment, { newMerchant: true });

    // #then
    expect(purchase).toMatchObject({ billId: null, amountUsdCents: 3_150n });
    expect(
      (await simulationsOf(db, payment.company)).find(
        ({ id }) => id === purchase.simulationId,
      ),
    ).toMatchObject({ billId: null });
  });

  it("settles nothing when the purchase is declined, and still records it", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    simulator.state.decide = () => "declined";

    // #when
    const purchase = await simulated(payment);

    // #then
    expect(purchase.result).toBe("declined");
    expect(simulator.state.clearings).toEqual([]);
    expect(
      (await simulationsOf(db, payment.company)).map(
        ({ lithicTransactionToken }) => lithicTransactionToken,
      ),
    ).toContain(purchase.transactionToken);
  });

  it("records an approved purchase that didn't settle, and says so", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    simulator.state.failClear = true;

    // #when
    const refused = await refusal(payment);

    // #then
    expect(refused?.tag).toBe("ServiceUnavailable");
    const [authorization] = authorizedFor(payment);
    expect(
      (await simulationsOf(db, payment.company)).map(
        ({ lithicTransactionToken }) => lithicTransactionToken,
      ),
    ).toContain(authorization?.transactionToken);
  });

  it("records the purchase before reading it back, and calls its result unknown when that fails", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const billId = await cardPaidBill(db, payment);
    simulator.state.failReadBack = true;

    // #when
    const purchase = await simulated(payment);

    // #then
    expect(purchase.result).toBe("unknown");
    expect(simulator.state.clearings).toEqual([]);
    expect(await simulationsOf(db, payment.company)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: purchase.simulationId,
          billId,
          lithicTransactionToken: purchase.transactionToken,
        }),
      ]),
    );
  });

  it("records the attempt as unconfirmed when Lithic may have made it without saying so", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const billId = await cardPaidBill(db, payment);
    simulator.state.failAuthorize = "ambiguous";

    // #when
    const refused = await refusal(payment);

    // #then
    expect(refused).toEqual({
      tag: "ServiceUnavailable",
      message:
        "Lithic's sandbox didn't answer, so the purchase may or may not have been made. Check the card's purchases before trying again.",
    });
    const attempts = (await simulationsOf(db, payment.company)).filter(
      ({ recurringItemId }) => recurringItemId === payment.itemId,
    );
    expect(attempts).toMatchObject([
      { billId, amountUsdCents: 2_000n, runByStaff: null },
    ]);
    const [attempt] = attempts;
    expect(attempt?.lithicTransactionToken).toMatch(
      /^unconfirmed:[0-9a-f-]{36}$/,
    );
    expect(isUnconfirmedToken(attempt?.lithicTransactionToken ?? "")).toBe(
      true,
    );
    expect(
      authorizedFor(payment).map(({ transactionToken }) => transactionToken),
    ).not.toContain(attempt?.lithicTransactionToken);
  });

  it("records nothing when Lithic refuses the purchase outright", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    await cardPaidBill(db, payment);
    simulator.state.failAuthorize = "refused";

    // #when
    const refused = await refusal(payment);

    // #then
    expect(refused).toEqual({
      tag: "ServiceUnavailable",
      message: "Lithic's sandbox didn't answer. Try again in a minute.",
    });
    expect(
      (await simulationsOf(db, payment.company)).filter(
        ({ recurringItemId }) => recurringItemId === payment.itemId,
      ),
    ).toEqual([]);
  });

  it("leaves the bill and Card purchases to the purchase check and the webhook", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const billId = await cardPaidBill(db, payment);
    const before = await readBill(db, payment.company, billId);

    // #when
    await simulated(payment);

    // #then
    expect(await readBill(db, payment.company, billId)).toEqual(before);
    const purchases = await runInScope(
      db,
      { organizationId: payment.company.organizationId },
      (tx) => tx.select({ id: cardPurchases.id }).from(cardPurchases),
    );
    expect(purchases).toEqual([]);
  });
});

describe("what it refuses", () => {
  it("charges a paused payment and a frozen card: the decline is the point", async () => {
    // #given
    const paused = await cardPaidPayment(db, card, { item: { active: false } });
    const frozen = await cardPaidPayment(db, card);
    await setCardState(db, frozen, "frozen");

    // #when
    const results = [await simulate(paused), await simulate(frozen)];

    // #then
    expect(results.map(Exit.isSuccess)).toEqual([true, true]);
  });

  it.each<[string, (payment: CardPaidPayment) => Promise<unknown>, string]>([
    [
      "the card is closed",
      (payment) => setCardState(db, payment, "closed"),
      "Its company-held card is closed.",
    ],
    [
      "the payment has ended",
      (payment) =>
        runInScope(
          db,
          { organizationId: payment.company.organizationId, role: "admin" },
          (tx) =>
            tx
              .update(recurringItems)
              .set({ nextDueOn: null, endsOn: "2026-11-01" })
              .where(eq(recurringItems.id, payment.itemId)),
        ),
      "This recurring payment has ended.",
    ],
  ])("refuses when %s", async (_case, arrange, message) => {
    // #given
    const payment = await cardPaidPayment(db, card);
    await arrange(payment);

    // #when
    const refused = await refusal(payment);

    // #then
    expect(refused).toEqual({ tag: "Conflict", message });
    expect(authorizedFor(payment)).toEqual([]);
  });

  it("charges the last bill of a payment with an end date, still owed", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      item: { nextDueOn: null, endsOn: "2026-11-30" },
    });
    const billId = await cardPaidBill(db, payment);

    // #when
    const purchase = await simulated(payment, { billId });

    // #then
    expect(purchase).toMatchObject({ billId, result: "approved" });
    expect(authorizedFor(payment)).toHaveLength(1);
  });

  it("refuses a payment that isn't paid by card", async () => {
    // #given
    const payment = await cardPaidPayment(db, card, {
      item: {
        payVia: "expendi",
        cardId: null,
        currency: "kes",
        amountUsdc: null,
        amountKes: 250_000n,
      },
    });

    // #when
    const refused = await refusal(payment);

    // #then
    expect(refused).toEqual({
      tag: "Conflict",
      message: "This recurring payment isn't paid by a company-held card.",
    });
  });

  it("refuses a recurring payment of another company", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const elsewhere = await createCardCompany(db);

    // #when
    const refused = await refusal({
      ...payment,
      company: elsewhere.company,
    });

    // #then
    expect(refused?.tag).toBe("NotFound");
    expect(authorizedFor(payment)).toEqual([]);
  });

  it("refuses a bill that is no longer owed", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    const billId = await cardPaidBill(db, payment);
    await runInScope(
      db,
      { organizationId: payment.company.organizationId, role: "admin" },
      (tx) =>
        tx
          .update(bills)
          .set({
            status: "cancelled",
            cancelledReason: "Moved to annual billing",
            cancelledBy: payment.company.admin.id,
            cancelledAt: new Date(),
          })
          .where(eq(bills.id, billId)),
    );

    // #when
    const refused = await refusal(payment, { billId });

    // #then
    expect(refused?.message).toBe("This bill is no longer owed.");
  });

  it("refuses when Lithic's sandbox isn't set up", async () => {
    // #given
    const payment = await cardPaidPayment(db, card);
    simulator.state.configured = false;

    // #when
    const refused = await refusal(payment);

    // #then
    expect(refused?.tag).toBe("ServiceUnavailable");
    expect(authorizedFor(payment)).toEqual([]);
  });
});

describe("against the sandbox's API", () => {
  const PAN = "4111111289144142";
  const sent: { method: string; path: string; body: string | null }[] = [];
  const logged: unknown[][] = [];
  let sandboxResult = "APPROVED";
  let sandboxCardStatus = 200;
  let transactionToken = "";
  let sandboxRuntime: AppRuntime;

  const fakeSandbox: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = url.replace(LITHIC_SANDBOX_URL, "");
    const method = init?.method ?? "GET";
    sent.push({
      method,
      path,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const answer = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (path.startsWith("/v1/cards/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ pan: PAN }), {
          status: sandboxCardStatus,
        }),
      );
    }
    if (path === "/v1/simulate/authorize") {
      transactionToken = `tx-${randomUUID()}`;
      return answer({ token: transactionToken });
    }
    if (path.startsWith("/v1/transactions/")) {
      if (sandboxResult === "UNREADABLE") {
        return Promise.resolve(new Response("{}", { status: 503 }));
      }
      return answer({
        status: sandboxResult === "APPROVED" ? "PENDING" : "DECLINED",
        result: sandboxResult,
      });
    }
    return answer({});
  };

  beforeAll(() => {
    sandboxRuntime = makeTestRuntime({
      lithicSimulator: Layer.succeed(
        LithicSimulator,
        makeLithicSimulator(
          { apiKey: Redacted.make("sandbox_key") },
          { fetch: fakeSandbox, writeGapMs: 0 },
        ),
      ),
    });
  });

  afterAll(async () => {
    await sandboxRuntime.dispose();
  });

  beforeEach(() => {
    sent.length = 0;
    logged.length = 0;
    sandboxCardStatus = 200;
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = (payment: CardPaidPayment) =>
    sandboxRuntime.runPromiseExit(
      simulateCardPurchase({
        organizationId: payment.company.organizationId,
        recurringItemId: payment.itemId,
        runBy: { kind: "job" },
      }),
    );

  it("authorizes, reads the result back, then clears an approved purchase", async () => {
    // #given
    sandboxResult = "APPROVED";
    const payment = await cardPaidPayment(db, card);

    // #when
    const exit = await run(payment);

    // #then
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /v1/cards/${payment.cardToken}`,
      "POST /v1/simulate/authorize",
      `GET /v1/transactions/${transactionToken}`,
      "POST /v1/simulate/clearing",
    ]);
  });

  it("records the purchase, and clears nothing, when it can't be read back", async () => {
    // #given
    sandboxResult = "UNREADABLE";
    const payment = await cardPaidPayment(db, card);

    // #when
    const exit = await run(payment);

    // #then
    expect(Exit.isSuccess(exit) && exit.value.result).toBe("unknown");
    expect(
      (await simulationsOf(db, payment.company))
        .filter(({ recurringItemId }) => recurringItemId === payment.itemId)
        .map(({ lithicTransactionToken }) => lithicTransactionToken),
    ).toEqual([transactionToken]);
    expect(sent.map(({ path }) => path)).not.toContain("/v1/simulate/clearing");
  });

  it("doesn't clear a declined purchase", async () => {
    // #given
    sandboxResult = "UNAUTHORIZED_MERCHANT";
    const payment = await cardPaidPayment(db, card);

    // #when
    const exit = await run(payment);

    // #then
    expect(Exit.isSuccess(exit) && exit.value.result).toBe("declined");
    expect(sent.map(({ path }) => path)).not.toContain("/v1/simulate/clearing");
  });

  it("keeps the card number and the card's token out of what it returns, records and logs", async () => {
    // #given
    sandboxResult = "APPROVED";
    const payment = await cardPaidPayment(db, card);

    // #when
    const exit = await run(payment);

    // #then
    expect(
      sent.find(({ path }) => path === "/v1/simulate/authorize")?.body,
    ).toContain(PAN);
    const everythingElse = JSON.stringify(
      [exit, await simulationsOf(db, payment.company), logged],
      (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
    );
    expect(everythingElse).not.toContain(PAN);
    expect(everythingElse).not.toContain(payment.cardToken);
  });

  it("keeps the card's token out of the error and the logs when the card can't be looked up", async () => {
    // #given
    sandboxCardStatus = 404;
    const payment = await cardPaidPayment(db, card);

    // #when
    const exit = await run(payment);

    // #then
    expect(Exit.isFailure(exit)).toBe(true);
    const printed = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
    expect(JSON.stringify(logged)).toContain("GET /v1/cards/:token");
    expect(printed).not.toContain(payment.cardToken);
    expect(JSON.stringify(logged)).not.toContain(payment.cardToken);
    expect(JSON.stringify(logged)).not.toContain(PAN);
  });
});
