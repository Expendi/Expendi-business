import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
} from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LithicError } from "../../services/lithic/lithic-client.js";
import {
  LithicSimulator,
  LithicSimulatorLive,
  makeLithicSimulator,
} from "../../services/card-simulations/lithic-simulator.js";
import { LITHIC_SANDBOX_URL } from "../../services/lithic/lithic-client.js";

const API_KEY = "sandbox_test_key";
const PAN = "4111111289144142";
const CARD_TOKEN = "card-token-1";
const TX_TOKEN = "tx-token-1";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown> | null;
  readonly at: number;
}

type Route = (sent: Sent) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Lithic's sandbox as these calls see it, with any route overridden. */
function sandbox(overrides: Record<string, Route> = {}) {
  const sent: Sent[] = [];
  const routes: Record<string, Route> = {
    [`GET /v1/cards/${CARD_TOKEN}`]: () =>
      json({ token: CARD_TOKEN, last_four: "4142", state: "OPEN", pan: PAN }),
    "POST /v1/simulate/authorize": () =>
      json({ token: TX_TOKEN, debugging_request_id: "dbg-1" }),
    [`GET /v1/transactions/${TX_TOKEN}`]: () =>
      json({ token: TX_TOKEN, status: "PENDING", result: "APPROVED" }),
    "POST /v1/simulate/clearing": () => json({ debugging_request_id: "dbg-2" }),
    ...overrides,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    const request = { method, url, body, at: Date.now() };
    sent.push(request);
    const route = routes[`${method} ${url.replace(LITHIC_SANDBOX_URL, "")}`];
    return route ? route(request) : json({ message: "not found" }, 404);
  };
  return { sent, fetchImpl };
}

function simulatorOn(fetchImpl: typeof fetch, writeGapMs = 0) {
  return makeLithicSimulator(
    { apiKey: Redacted.make(API_KEY) },
    { fetch: fetchImpl, writeGapMs },
  );
}

const AUTHORIZATION = {
  cardToken: CARD_TOKEN,
  amountUsdCents: 2_000n,
  descriptor: "ANTHROPIC",
  merchantAcceptorId: "SBX0123456789AB",
};

async function failureOf<A>(
  effect: Effect.Effect<A, LithicError>,
): Promise<{ error: LithicError | null; printed: string }> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return { error: null, printed: "" };
  return {
    error: Option.getOrNull(Cause.failureOption(exit.cause)),
    printed: Cause.pretty(exit.cause),
  };
}

const logged: unknown[][] = [];

beforeEach(() => {
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the sandbox merchant", () => {
  it("authorizes with the card's number and hands back the purchase's token at once", async () => {
    // #given
    const { sent, fetchImpl } = sandbox();

    // #when
    const result = await Effect.runPromise(
      simulatorOn(fetchImpl).authorize(AUTHORIZATION),
    );

    // #then
    expect(result).toEqual({ transactionToken: TX_TOKEN });
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${LITHIC_SANDBOX_URL}/v1/cards/${CARD_TOKEN}`,
      `POST ${LITHIC_SANDBOX_URL}/v1/simulate/authorize`,
    ]);
    expect(sent[1]?.body).toEqual({
      descriptor: "ANTHROPIC",
      amount: 2_000,
      mcc: "5734",
      merchant_acceptor_id: "SBX0123456789AB",
      pan: PAN,
    });
  });

  it("hands back the token even when the purchase can't be read back", async () => {
    // #given
    const { fetchImpl } = sandbox({
      [`GET /v1/transactions/${TX_TOKEN}`]: () =>
        json({ message: "unavailable" }, 503),
    });

    // #when
    const result = await Effect.runPromise(
      simulatorOn(fetchImpl).authorize(AUTHORIZATION),
    );

    // #then
    expect(result).toEqual({ transactionToken: TX_TOKEN });
  });

  it("reads back that the purchase check approved it", async () => {
    // #given
    const { sent, fetchImpl } = sandbox();

    // #when
    const approved = await Effect.runPromise(
      simulatorOn(fetchImpl).wasApproved({ token: TX_TOKEN }),
    );

    // #then
    expect(approved).toBe(true);
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${LITHIC_SANDBOX_URL}/v1/transactions/${TX_TOKEN}`,
    ]);
  });

  it("clears the whole of an authorization", async () => {
    // #given
    const { sent, fetchImpl } = sandbox();

    // #when
    await Effect.runPromise(simulatorOn(fetchImpl).clear({ token: TX_TOKEN }));

    // #then
    expect(sent.map(({ method, url, body }) => [method, url, body])).toEqual([
      [
        "POST",
        `${LITHIC_SANDBOX_URL}/v1/simulate/clearing`,
        { token: TX_TOKEN },
      ],
    ]);
  });

  it.each([
    ["the transaction is declined", "DECLINED", "UNAUTHORIZED_MERCHANT"],
    ["the result isn't an approval", "PENDING", "CARD_PAUSED"],
  ])(
    "reports a decline when %s, and clears nothing",
    async (_case, status, result) => {
      // #given
      const { sent, fetchImpl } = sandbox({
        [`GET /v1/transactions/${TX_TOKEN}`]: () =>
          json({ token: TX_TOKEN, status, result }),
      });

      // #when
      const approved = await Effect.runPromise(
        simulatorOn(fetchImpl).wasApproved({ token: TX_TOKEN }),
      );

      // #then
      expect(approved).toBe(false);
      expect(sent.some(({ url }) => url.endsWith("/simulate/clearing"))).toBe(
        false,
      );
    },
  );

  it("waits the sandbox's write gap after each write", async () => {
    // #given
    const { sent, fetchImpl } = sandbox();
    const simulator = simulatorOn(fetchImpl, 60);

    // #when
    await Effect.runPromise(
      simulator
        .authorize(AUTHORIZATION)
        .pipe(
          Effect.zipRight(simulator.wasApproved({ token: TX_TOKEN })),
          Effect.zipRight(
            Effect.all(
              [
                simulator.clear({ token: TX_TOKEN }),
                simulator.clear({ token: TX_TOKEN }),
              ],
              { concurrency: "unbounded" },
            ),
          ),
        ),
    );

    // #then
    const [, authorize, readBack, firstClear, secondClear] = sent.map(
      ({ at }) => at,
    );
    expect(sent).toHaveLength(5);
    expect(Number(readBack) - Number(authorize)).toBeGreaterThanOrEqual(55);
    expect(Number(firstClear) - Number(authorize)).toBeGreaterThanOrEqual(55);
    expect(Number(secondClear) - Number(firstClear)).toBeGreaterThanOrEqual(55);
  });

  it("only ever calls the sandbox", async () => {
    // #given
    const { sent, fetchImpl } = sandbox();
    const simulator = simulatorOn(fetchImpl);

    // #when
    await Effect.runPromise(
      simulator
        .authorize(AUTHORIZATION)
        .pipe(
          Effect.zipRight(simulator.wasApproved({ token: TX_TOKEN })),
          Effect.zipRight(simulator.clear({ token: TX_TOKEN })),
        ),
    );

    // #then
    expect(
      sent.every(({ url }) => url.startsWith(`${LITHIC_SANDBOX_URL}/v1/`)),
    ).toBe(true);
  });

  it("fails without a card number when the sandbox gives none", async () => {
    // #given
    const { sent, fetchImpl } = sandbox({
      [`GET /v1/cards/${CARD_TOKEN}`]: () =>
        json({ token: CARD_TOKEN, last_four: "4142", state: "OPEN" }),
    });

    // #when
    const { error } = await failureOf(
      simulatorOn(fetchImpl).authorize(AUTHORIZATION),
    );

    // #then
    expect(error?.code).toBe("NO_CARD_NUMBER");
    expect(sent).toHaveLength(1);
  });

  it.each<[string, Record<string, Route>, boolean]>([
    [
      "fails the authorization",
      { "POST /v1/simulate/authorize": () => json({}, 500) },
      true,
    ],
    [
      "can't be reached for the authorization",
      {
        "POST /v1/simulate/authorize": () =>
          Promise.reject(new TypeError("fetch failed")),
      },
      true,
    ],
    [
      "answers the authorization with nonsense",
      { "POST /v1/simulate/authorize": () => new Response("<html>") },
      true,
    ],
    [
      "refuses the authorization",
      { "POST /v1/simulate/authorize": () => json({}, 400) },
      false,
    ],
    [
      "can't find the card",
      { [`GET /v1/cards/${CARD_TOKEN}`]: () => json({}, 404) },
      false,
    ],
    [
      "fails the card lookup",
      { [`GET /v1/cards/${CARD_TOKEN}`]: () => json({}, 500) },
      false,
    ],
  ])(
    "says whether the purchase may have been made when the sandbox %s",
    async (_case, overrides, ambiguous) => {
      // #given
      const { fetchImpl } = sandbox(overrides);

      // #when
      const { error } = await failureOf(
        simulatorOn(fetchImpl).authorize(AUTHORIZATION),
      );

      // #then
      expect(error?.ambiguous).toBe(ambiguous);
    },
  );
});

describe("the switch", () => {
  const configuredWith = (env: Record<string, string>) =>
    Effect.runPromise(
      LithicSimulator.pipe(
        Effect.map(({ configured }) => configured),
        Effect.provide(
          LithicSimulatorLive.pipe(
            Layer.provide(
              Layer.setConfigProvider(
                ConfigProvider.fromMap(new Map(Object.entries(env))),
              ),
            ),
          ),
        ),
      ),
    );

  it("turns the pretend merchant on only for CARD_SIMULATIONS_ENABLED=true with a Lithic key", async () => {
    // #then
    expect(
      await configuredWith({
        LITHIC_API_KEY: API_KEY,
        CARD_SIMULATIONS_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it.each<[string, Record<string, string>]>([
    ["is left out", { LITHIC_API_KEY: API_KEY }],
    ["is empty", { LITHIC_API_KEY: API_KEY, CARD_SIMULATIONS_ENABLED: "" }],
    [
      "is false",
      { LITHIC_API_KEY: API_KEY, CARD_SIMULATIONS_ENABLED: "false" },
    ],
    ["is TRUE", { LITHIC_API_KEY: API_KEY, CARD_SIMULATIONS_ENABLED: "TRUE" }],
    ["is 1", { LITHIC_API_KEY: API_KEY, CARD_SIMULATIONS_ENABLED: "1" }],
    ["is yes", { LITHIC_API_KEY: API_KEY, CARD_SIMULATIONS_ENABLED: "yes" }],
    ["is true but there's no Lithic key", { CARD_SIMULATIONS_ENABLED: "true" }],
  ])("keeps it off when the setting %s", async (_case, env) => {
    // #then
    expect(await configuredWith(env)).toBe(false);
  });
});

describe("the card number and the card's token", () => {
  const leaks = (text: string) =>
    text.includes(PAN) || text.includes(CARD_TOKEN);

  it("never leave the authorize call they were fetched for", async () => {
    // #given
    const { fetchImpl } = sandbox();

    // #when
    const result = await Effect.runPromise(
      simulatorOn(fetchImpl).authorize(AUTHORIZATION),
    );

    // #then
    expect(leaks(JSON.stringify(result))).toBe(false);
    expect(leaks(JSON.stringify(logged))).toBe(false);
  });

  it.each<[string, Route]>([
    ["refuses it", () => json({ message: `bad pan ${PAN}` }, 400)],
    ["fails", () => json({ message: `pan ${PAN} broke us` }, 500)],
    ["answers nonsense", () => new Response(`<html>${PAN}</html>`)],
    [
      "answers the wrong shape",
      () => json({ pan: PAN, debugging_request_id: "x" }),
    ],
    [
      "can't be reached",
      () => Promise.reject(new TypeError(`fetch failed for ${PAN}`)),
    ],
  ])(
    "stay out of the error and the logs when the sandbox %s",
    async (_case, authorize) => {
      // #given
      const { fetchImpl } = sandbox({
        "POST /v1/simulate/authorize": authorize,
      });

      // #when
      const { error, printed } = await failureOf(
        simulatorOn(fetchImpl).authorize(AUTHORIZATION),
      );

      // #then
      expect(error).not.toBeNull();
      expect(leaks(printed)).toBe(false);
      expect(leaks(JSON.stringify(error))).toBe(false);
      expect(leaks(error?.message ?? "")).toBe(false);
      expect(leaks(JSON.stringify(logged))).toBe(false);
    },
  );

  it.each<[string, Route]>([
    ["can't find the card", () => json({ message: "not found" }, 404)],
    ["fails the card lookup", () => json({ message: "broke" }, 500)],
    [
      "can't be reached for the card lookup",
      () => Promise.reject(new TypeError("fetch failed")),
    ],
    ["answers the card lookup with nonsense", () => new Response("<html>")],
  ])(
    "stay out of the error and the logs when the sandbox %s",
    async (_case, lookup) => {
      // #given
      const { fetchImpl } = sandbox({
        [`GET /v1/cards/${CARD_TOKEN}`]: lookup,
      });

      // #when
      const { error, printed } = await failureOf(
        simulatorOn(fetchImpl).authorize(AUTHORIZATION),
      );

      // #then
      expect(error).not.toBeNull();
      expect(error?.message).toContain("GET /v1/cards/:token");
      expect(leaks(printed)).toBe(false);
      expect(leaks(JSON.stringify(error))).toBe(false);
      expect(leaks(JSON.stringify(logged))).toBe(false);
    },
  );
});
