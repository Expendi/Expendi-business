import type { ConfigError } from "effect";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { z } from "zod";

/**
 * Lithic card issuing, sandbox only: `LITHIC_SANDBOX_URL` is the one address
 * this client knows, so nothing built on it can reach production. Tests fake
 * this port; `apps/api/scripts/lithic-simulate.ts` drives the real sandbox.
 */
export const LITHIC_SANDBOX_URL = "https://sandbox.lithic.com";

export class LithicError extends Data.TaggedError("LithicError")<{
  readonly message: string;
  readonly status: number;
  readonly code: string;
  /**
   * The request changed state and may have succeeded although we saw an
   * error. Lithic's sandbox answers 500 and still creates the company, so
   * look the record up before trying again.
   */
  readonly ambiguous: boolean;
}> {}

const accountHolderSchema = z.looseObject({
  token: z.string().min(1),
  account_token: z.string().min(1),
  status: z.string().optional(),
});

export interface LithicAccountHolder {
  readonly token: string;
  readonly accountToken: string;
}

const cardSchema = z.looseObject({
  token: z.string().min(1),
  last_four: z.string().min(4),
  state: z.string(),
});

export interface LithicCard {
  readonly token: string;
  readonly lastFour: string;
  readonly state: string;
}

const signedAmount = z.object({ amount: z.number().int() });

const transactionSchema = z.looseObject({
  token: z.string().min(1),
  card_token: z.string().min(1),
  status: z.string(),
  result: z.string(),
  created: z.string(),
  amounts: z.object({ hold: signedAmount, settlement: signedAmount }),
  merchant: z.looseObject({
    /** Lithic's ID for the merchant, which outlives a changed descriptor. */
    acceptor_id: z.string().nullish(),
    descriptor: z.string(),
    mcc: z.string(),
    city: z.string().nullish(),
    country: z.string().nullish(),
  }),
  events: z.array(
    z.looseObject({
      type: z.string(),
      result: z.string(),
      detailed_results: z.array(z.string()).optional(),
    }),
  ),
});

export type LithicTransaction = z.infer<typeof transactionSchema>;

export interface LithicAddress {
  readonly addressLine1: string;
  readonly city: string;
  readonly postalCode: string;
}

export interface LithicBusinessInput {
  /** Our ID, so a create Lithic answered with an error can be found again. */
  readonly externalId: string;
  readonly legalName: string;
  readonly kraPin: string;
  readonly phone: string;
  readonly address: LithicAddress;
  readonly contact: {
    readonly firstName: string;
    readonly lastName: string;
    readonly email: string;
    readonly phone: string;
  };
}

export interface LithicCardholderInput {
  readonly externalId: string;
  readonly businessAccountToken: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  /** The company's address; virtual cards ship nowhere. */
  readonly address: LithicAddress;
}

export interface LithicCardPatch {
  readonly state?: "OPEN" | "PAUSED" | "CLOSED";
  readonly monthlyLimitUsdCents?: bigint;
}

/** The three headers on Lithic's events and authorization requests. */
export interface LithicSignatureHeaders {
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
}

export interface LithicShape {
  /** False when `LITHIC_API_KEY` isn't set; every call then fails. */
  readonly configured: boolean;
  /** The HTTPS origin whose page shows a card's details (`/card-reveal`). */
  readonly revealOrigin: string;
  readonly createBusiness: (
    input: LithicBusinessInput,
  ) => Effect.Effect<LithicAccountHolder, LithicError>;
  readonly createCardholder: (
    input: LithicCardholderInput,
  ) => Effect.Effect<LithicAccountHolder, LithicError>;
  readonly findAccountHolder: (
    externalId: string,
  ) => Effect.Effect<LithicAccountHolder | null, LithicError>;
  readonly createCard: (input: {
    readonly accountToken: string;
    readonly memo: string;
    readonly monthlyLimitUsdCents: bigint;
  }) => Effect.Effect<LithicCard, LithicError>;
  readonly updateCard: (
    token: string,
    patch: LithicCardPatch,
  ) => Effect.Effect<LithicCard, LithicError>;
  /** A short-lived session the card-reveal page mounts Lithic's embed with. */
  readonly createEmbedSession: (
    cardToken: string,
  ) => Effect.Effect<
    { readonly session: string; readonly expiresAt: Date },
    LithicError
  >;
  readonly getTransaction: (
    token: string,
  ) => Effect.Effect<LithicTransaction, LithicError>;
  readonly verifyEventSignature: (
    rawBody: string,
    headers: LithicSignatureHeaders,
  ) => boolean;
  readonly verifyAuthorizationSignature: (
    rawBody: string,
    headers: LithicSignatureHeaders,
  ) => boolean;
}

export class Lithic extends Context.Tag("Lithic")<Lithic, LithicShape>() {}

export interface LithicSettings {
  readonly apiKey: Redacted.Redacted;
  readonly eventSecret: Option.Option<Redacted.Redacted>;
  readonly authorizationSecret: Option.Option<Redacted.Redacted>;
  readonly revealOrigin: string;
}

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Lithic's documented scheme: HMAC-SHA256 of `id.timestamp.body`, keyed with
 * the base64 part of the `whsec_` secret. The header lists one or more
 * space-separated `v1,<base64>` signatures, so a rotation doesn't break it.
 */
export function verifyLithicSignature(
  rawBody: string,
  headers: LithicSignatureHeaders,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const sentAt = Number(timestamp);
  if (
    !Number.isInteger(sentAt) ||
    Math.abs(nowSeconds - sentAt) > SIGNATURE_TOLERANCE_SECONDS
  ) {
    return false;
  }
  const key = Buffer.from(secret.trim().replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`, "utf8")
    .digest();
  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

const REQUEST_TIMEOUT_MS = 20_000;
const EMBED_SESSION_SECONDS = 5 * 60;

/** Sandbox-only stand-ins for details we don't collect. */
const SANDBOX_PERSON = { dob: "1990-06-28", government_id: "000003333" };
const SANDBOX_OWNER_ID = "000004444";
const SANDBOX_BUSINESS = {
  website_url: "https://business.expendi.app",
  naics_code: "541211",
  nature_of_business: "Company spending through Expendi Business",
};

const kenyanAddress = (address: LithicAddress) => ({
  address1: address.addressLine1,
  city: address.city,
  state: address.city,
  postal_code: address.postalCode,
  country: "KEN",
});

const toHolder = (
  holder: z.infer<typeof accountHolderSchema>,
): LithicAccountHolder => ({
  token: holder.token,
  accountToken: holder.account_token,
});

const toCard = (card: z.infer<typeof cardSchema>): LithicCard => ({
  token: card.token,
  lastFour: card.last_four,
  state: card.state,
});

const limitFields = (cents: bigint) => ({
  spend_limit: Number(cents),
  spend_limit_duration: "MONTHLY",
});

export function makeLithic(
  settings: LithicSettings,
  fetchImpl: typeof fetch = fetch,
): LithicShape {
  const request = <T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Effect.Effect<T, LithicError> => {
    const changesState = method !== "GET";
    const fail = (status: number, code: string, ambiguous: boolean) =>
      new LithicError({
        message: `Lithic ${method} ${path.split("?")[0] ?? path}: ${code}`,
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
        try: () => response.json(),
        catch: () => fail(502, "INVALID_RESPONSE", changesState),
      });
      const parsed = schema.safeParse(payload);
      return parsed.success
        ? parsed.data
        : yield* Effect.fail(fail(502, "INVALID_RESPONSE", changesState));
    });
  };

  const secretOf = (secret: Option.Option<Redacted.Redacted>) =>
    Option.match(secret, {
      onNone: () => "",
      onSome: (value) => Redacted.value(value),
    });

  return {
    configured: true,
    revealOrigin: settings.revealOrigin,
    createBusiness: (input) => {
      const address = kenyanAddress(input.address);
      const person = {
        ...SANDBOX_PERSON,
        first_name: input.contact.firstName,
        last_name: input.contact.lastName,
        email: input.contact.email,
        phone_number: input.contact.phone,
        address,
      };
      return request("POST", "/v1/account_holders", accountHolderSchema, {
        workflow: "KYB_DELEGATED",
        tos_timestamp: new Date().toISOString(),
        external_id: input.externalId,
        business_entity: {
          legal_business_name: input.legalName,
          government_id: input.kraPin,
          address,
          phone_numbers: [input.phone],
        },
        control_person: person,
        beneficial_owner_individuals: [
          { ...person, government_id: SANDBOX_OWNER_ID },
        ],
        ...SANDBOX_BUSINESS,
      }).pipe(Effect.map(toHolder));
    },
    createCardholder: (input) =>
      request("POST", "/v1/account_holders", accountHolderSchema, {
        workflow: "KYC_EXEMPT",
        kyc_exemption_type: "AUTHORIZED_USER",
        external_id: input.externalId,
        business_account_token: input.businessAccountToken,
        first_name: input.firstName,
        last_name: input.lastName,
        email: input.email,
        phone_number: input.phone,
        address: kenyanAddress(input.address),
      }).pipe(Effect.map(toHolder)),
    findAccountHolder: (externalId) =>
      request(
        "GET",
        `/v1/account_holders?external_id=${encodeURIComponent(externalId)}`,
        z.looseObject({ data: z.array(accountHolderSchema) }),
      ).pipe(
        Effect.map(({ data }) => {
          const [holder] = data;
          return holder ? toHolder(holder) : null;
        }),
      ),
    createCard: ({ accountToken, memo, monthlyLimitUsdCents }) =>
      request("POST", "/v1/cards", cardSchema, {
        type: "VIRTUAL",
        state: "OPEN",
        account_token: accountToken,
        memo,
        ...limitFields(monthlyLimitUsdCents),
      }).pipe(Effect.map(toCard)),
    updateCard: (token, patch) =>
      request("PATCH", `/v1/cards/${encodeURIComponent(token)}`, cardSchema, {
        ...(patch.state && { state: patch.state }),
        ...(patch.monthlyLimitUsdCents !== undefined &&
          limitFields(patch.monthlyLimitUsdCents)),
      }).pipe(Effect.map(toCard)),
    createEmbedSession: (cardToken) => {
      const expiresAt = new Date(Date.now() + EMBED_SESSION_SECONDS * 1000);
      return request(
        "POST",
        `/v1/cards/${encodeURIComponent(cardToken)}/embed`,
        z.looseObject({ session: z.string().min(1) }),
        {
          type: "CARD_EMBED",
          target_origin: settings.revealOrigin,
          expiration: Math.floor(expiresAt.getTime() / 1000),
        },
      ).pipe(Effect.map(({ session }) => ({ session, expiresAt })));
    },
    getTransaction: (token) =>
      request(
        "GET",
        `/v1/transactions/${encodeURIComponent(token)}`,
        transactionSchema,
      ),
    verifyEventSignature: (rawBody, headers) =>
      verifyLithicSignature(rawBody, headers, secretOf(settings.eventSecret)),
    verifyAuthorizationSignature: (rawBody, headers) =>
      verifyLithicSignature(
        rawBody,
        headers,
        secretOf(settings.authorizationSecret),
      ),
  };
}

const notConfigured = () =>
  Effect.fail(
    new LithicError({
      message: "LITHIC_API_KEY isn't set",
      status: 503,
      code: "NOT_CONFIGURED",
      ambiguous: false,
    }),
  );

const unconfigured = (revealOrigin: string): LithicShape => ({
  configured: false,
  revealOrigin,
  createBusiness: notConfigured,
  createCardholder: notConfigured,
  findAccountHolder: notConfigured,
  createCard: notConfigured,
  updateCard: notConfigured,
  createEmbedSession: notConfigured,
  getTransaction: notConfigured,
  verifyEventSignature: () => false,
  verifyAuthorizationSignature: () => false,
});

/**
 * Optional: without `LITHIC_API_KEY` the API still starts, and card routes
 * answer that cards aren't available.
 */
export const LithicLive: Layer.Layer<Lithic, ConfigError.ConfigError> =
  Layer.effect(
    Lithic,
    Effect.gen(function* () {
      const apiKey = yield* Config.option(Config.redacted("LITHIC_API_KEY"));
      const eventSecret = yield* Config.option(
        Config.redacted("LITHIC_WEBHOOK_SECRET"),
      );
      const authorizationSecret = yield* Config.option(
        Config.redacted("LITHIC_ASA_SECRET"),
      );
      const revealOrigin = yield* Config.withDefault(
        Config.string("CARD_REVEAL_ORIGIN"),
        "https://business.expendi.app",
      );
      if (Option.isNone(apiKey)) {
        console.warn("[lithic] LITHIC_API_KEY isn't set; cards are off");
        return unconfigured(revealOrigin);
      }
      return makeLithic({
        apiKey: apiKey.value,
        eventSecret,
        authorizationSecret,
        revealOrigin,
      });
    }),
  );
