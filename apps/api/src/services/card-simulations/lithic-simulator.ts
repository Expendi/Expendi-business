import type { ConfigError } from "effect";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import { z } from "zod";

import { LITHIC_SANDBOX_URL, LithicError } from "../lithic/lithic-client.js";

/**
 * Sandbox stand-in for a merchant (spec §6.25,
 * `docs/decisions/company-held-cards.md`): asks Lithic's sandbox to make a
 * Card purchase on a company-held card, as a merchant charging a card on
 * file would. Lithic then runs the purchase check and sends its transaction
 * events exactly as for a real purchase. Real merchants replace all of
 * this, and `LITHIC_SANDBOX_URL` is the only address it knows.
 *
 * Its own port rather than methods on `Lithic`, so deleting the stand-in
 * deletes this directory and nothing in the card issuing client changes.
 */

export interface SimulatedAuthorization {
  readonly transactionToken: string;
}

export interface LithicSimulatorShape {
  /**
   * False unless `CARD_SIMULATIONS_ENABLED=true` and `LITHIC_API_KEY` is
   * set; every call then fails.
   */
  readonly configured: boolean;
  /**
   * Makes the purchase and hands back its token as soon as Lithic has made
   * it, so it can be recorded before anything else can fail. An `ambiguous`
   * error means Lithic may have made it anyway.
   */
  readonly authorize: (input: {
    readonly cardToken: string;
    readonly amountUsdCents: bigint;
    /** What the purchase shows as the merchant's name, at most 25 characters. */
    readonly descriptor: string;
    /** The merchant's ID at Lithic, at most 15 characters. */
    readonly merchantAcceptorId: string;
  }) => Effect.Effect<SimulatedAuthorization, LithicError>;
  /**
   * Whether the purchase check approved the purchase: the simulate call
   * doesn't say, the transaction it made does.
   */
  readonly wasApproved: (input: {
    readonly token: string;
  }) => Effect.Effect<boolean, LithicError>;
  /** Settles the whole of an approved authorization. */
  readonly clear: (input: {
    readonly token: string;
  }) => Effect.Effect<void, LithicError>;
}

export class LithicSimulator extends Context.Tag("LithicSimulator")<
  LithicSimulator,
  LithicSimulatorShape
>() {}

/** Lithic's sandbox allows about one write a second. */
export const SANDBOX_WRITE_GAP_MS = 1_200;

const SANDBOX_HOST = "sandbox.lithic.com";

const REQUEST_TIMEOUT_MS = 20_000;

/** Computer software stores: what most card-paid recurring payments are. */
const SOFTWARE_MCC = "5734";

const sandboxCardSchema = z.looseObject({ pan: z.string().min(12).optional() });

const tokenSchema = z.looseObject({ token: z.string().min(1) });

const transactionSchema = z.looseObject({
  status: z.string(),
  result: z.string(),
});

export interface LithicSimulatorOptions {
  readonly fetch?: typeof fetch;
  readonly writeGapMs?: number;
}

function refusing(error: LithicError): LithicSimulatorShape {
  const refuse = () => Effect.fail(error);
  return {
    configured: false,
    authorize: refuse,
    wasApproved: refuse,
    clear: refuse,
  };
}

const notConfigured = new LithicError({
  message:
    "Simulated Card purchases are off: CARD_SIMULATIONS_ENABLED isn't true or LITHIC_API_KEY isn't set",
  status: 503,
  code: "NOT_CONFIGURED",
  ambiguous: false,
});

const notSandbox = new LithicError({
  message: `Lithic's address isn't ${SANDBOX_HOST}`,
  status: 503,
  code: "NOT_SANDBOX",
  ambiguous: false,
});

/** A path to call, and the template errors name it by. */
interface SandboxPath {
  readonly path: string;
  readonly route: string;
}

const fixedPath = (path: string): SandboxPath => ({ path, route: path });

const tokenPath = (prefix: string, token: string): SandboxPath => ({
  path: `${prefix}/${encodeURIComponent(token)}`,
  route: `${prefix}/:token`,
});

export function makeLithicSimulator(
  settings: { readonly apiKey: Redacted.Redacted },
  options: LithicSimulatorOptions = {},
): LithicSimulatorShape {
  // `authorize` fetches a card's full number, which only the sandbox may
  // hand out: pointing the shared address at production must fail closed.
  if (new URL(LITHIC_SANDBOX_URL).host !== SANDBOX_HOST) {
    console.error(
      `[card-simulations] Lithic's address isn't ${SANDBOX_HOST}; the sandbox merchant is off`,
    );
    return refusing(notSandbox);
  }
  const fetchImpl = options.fetch ?? fetch;
  const writeGapMs = options.writeGapMs ?? SANDBOX_WRITE_GAP_MS;
  // Writes from the job and from staff can overlap in one instance; one at
  // a time with the gap after each keeps both under the sandbox's limit.
  const oneWriteAtATime = Effect.unsafeMakeSemaphore(1);

  // Errors name the method, route template and status only: a path holds a
  // card's token and a request body its number, so neither may reach an
  // error or a log.
  const request = <T>(
    method: "GET" | "POST",
    { path, route }: SandboxPath,
    schema: z.ZodType<T>,
    body?: Readonly<Record<string, unknown>>,
  ): Effect.Effect<T, LithicError> => {
    const changesState = method !== "GET";
    const fail = (status: number, code: string, ambiguous: boolean) =>
      new LithicError({
        message: `Lithic sandbox ${method} ${route}: ${code}`,
        status,
        code,
        ambiguous,
      });
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(`${LITHIC_SANDBOX_URL}${path}`, {
            method,
            headers: {
              Authorization: Redacted.value(settings.apiKey),
              "Content-Type": "application/json",
            },
            ...(body !== undefined && { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            redirect: "error",
          }),
        catch: () => fail(503, "TRANSPORT_ERROR", changesState),
      });
      if (!response.ok) {
        return yield* Effect.fail(
          fail(
            response.status,
            `HTTP_${response.status}`,
            changesState && response.status >= 500,
          ),
        );
      }
      const payload = yield* Effect.tryPromise({
        try: async (): Promise<unknown> => {
          const text = await response.text();
          return text === "" ? {} : JSON.parse(text);
        },
        catch: () => fail(502, "INVALID_RESPONSE", changesState),
      });
      const parsed = schema.safeParse(payload);
      return parsed.success
        ? parsed.data
        : yield* Effect.fail(fail(502, "INVALID_RESPONSE", changesState));
    });
  };

  const write = <T>(
    path: string,
    schema: z.ZodType<T>,
    body: Readonly<Record<string, unknown>>,
  ) =>
    oneWriteAtATime.withPermits(1)(
      request("POST", fixedPath(path), schema, body).pipe(
        Effect.ensuring(Effect.sleep(writeGapMs)),
      ),
    );

  /**
   * The full card number, which simulating a purchase needs and only the
   * sandbox hands out. Acceptable only because this is a sandbox stand-in
   * for a merchant, who holds the number in reality: it lives in memory
   * for one call and is never logged, stored, audited or returned.
   */
  const sandboxCardNumber = (cardToken: string) =>
    request("GET", tokenPath("/v1/cards", cardToken), sandboxCardSchema).pipe(
      Effect.flatMap(({ pan }) =>
        pan === undefined
          ? Effect.fail(
              new LithicError({
                message: "Lithic sandbox didn't return the card number",
                status: 502,
                code: "NO_CARD_NUMBER",
                ambiguous: false,
              }),
            )
          : Effect.succeed(pan),
      ),
    );

  return {
    configured: true,
    authorize: (input) =>
      Effect.gen(function* () {
        const pan = yield* sandboxCardNumber(input.cardToken);
        const { token } = yield* write("/v1/simulate/authorize", tokenSchema, {
          descriptor: input.descriptor,
          amount: Number(input.amountUsdCents),
          mcc: SOFTWARE_MCC,
          merchant_acceptor_id: input.merchantAcceptorId,
          pan,
        });
        return { transactionToken: token };
      }),
    wasApproved: ({ token }) =>
      request(
        "GET",
        tokenPath("/v1/transactions", token),
        transactionSchema,
      ).pipe(
        Effect.map(
          (transaction) =>
            transaction.status !== "DECLINED" &&
            transaction.result === "APPROVED",
        ),
      ),
    clear: ({ token }) =>
      write("/v1/simulate/clearing", z.looseObject({}), { token }).pipe(
        Effect.asVoid,
      ),
  };
}

/**
 * Off unless `CARD_SIMULATIONS_ENABLED` is exactly `true` and
 * `LITHIC_API_KEY` is set: a Lithic key alone, which real cards will need
 * too, must not start a pretend merchant spending Card balances.
 */
export const LithicSimulatorLive: Layer.Layer<
  LithicSimulator,
  ConfigError.ConfigError
> = Layer.effect(
  LithicSimulator,
  Effect.gen(function* () {
    const enabled = yield* Config.option(
      Config.string("CARD_SIMULATIONS_ENABLED"),
    );
    const apiKey = yield* Config.option(Config.redacted("LITHIC_API_KEY"));
    if (Option.getOrNull(enabled) !== "true" || Option.isNone(apiKey)) {
      return refusing(notConfigured);
    }
    return makeLithicSimulator({ apiKey: apiKey.value });
  }),
);
