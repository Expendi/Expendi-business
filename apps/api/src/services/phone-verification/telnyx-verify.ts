import type { ConfigError } from "effect";
import { Config, Effect, Layer, Option, Redacted } from "effect";
import { z } from "zod";

import type {
  OtpProviderErrorCode,
  OtpProviderShape,
  VerificationCheckResult,
} from "./otp-provider.js";
import { OtpProvider, OtpProviderError } from "./otp-provider.js";

/**
 * Telnyx Verify, ported from the consumer backend's
 * `telnyx-verify-service.ts`. Two calls
 * (https://developers.telnyx.com/docs/identity/verify/quickstart):
 *   - send:  POST /v2/verifications/sms
 *   - check: POST /v2/verifications/by_phone_number/{e164}/actions/verify
 * The Verify profile sets the sender, code length and expiry, so those live
 * in the Telnyx dashboard. Telnyx's error text can echo the number, so only
 * the HTTP status and Telnyx's error code reach our messages and logs.
 */

const TELNYX_BASE_URL = "https://api.telnyx.com/v2";
const REQUEST_TIMEOUT_MS = 15_000;

export interface TelnyxVerifySettings {
  readonly apiKey: Redacted.Redacted;
  readonly verifyProfileId: string;
}

const telnyxBodySchema = z.looseObject({
  data: z
    .looseObject({
      id: z.string().optional(),
      /** On a check: accepted, rejected, expired or max_attempts_exceeded. */
      response_code: z.string().optional(),
    })
    .optional(),
  errors: z
    .array(
      z.looseObject({ code: z.union([z.string(), z.number()]).optional() }),
    )
    .optional(),
});
type TelnyxBody = z.infer<typeof telnyxBodySchema>;

interface TelnyxReply {
  readonly ok: boolean;
  readonly status: number;
  readonly body: TelnyxBody;
}

const fail = (code: OtpProviderErrorCode, message: string) =>
  Effect.fail(new OtpProviderError({ code, message }));

function httpFailure(
  reply: TelnyxReply,
  code: OtpProviderErrorCode,
): Effect.Effect<never, OtpProviderError> {
  const telnyxCode = reply.body.errors?.[0]?.code;
  return fail(
    code,
    `Telnyx Verify answered HTTP ${reply.status}${telnyxCode === undefined ? "" : ` (code ${telnyxCode})`}`,
  );
}

/** 401/403 mean the key or profile is wrong: a deployment problem, not the user's. */
function failureCode(status: number): OtpProviderErrorCode {
  if (status === 429) return "RATE_LIMITED";
  if (status === 401 || status === 403) return "NOT_CONFIGURED";
  return "API_ERROR";
}

const CHECK_RESULTS: Readonly<Record<string, VerificationCheckResult>> = {
  accepted: { approved: true },
  expired: { approved: false, reason: "expired" },
  max_attempts_exceeded: { approved: false, reason: "max_attempts" },
};

export function makeTelnyxVerify(
  settings: TelnyxVerifySettings,
  fetchImpl: typeof fetch = fetch,
): OtpProviderShape {
  const post = (
    path: string,
    body: Record<string, string>,
  ): Effect.Effect<TelnyxReply, OtpProviderError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(`${TELNYX_BASE_URL}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Redacted.value(settings.apiKey)}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: "error",
        });
        const json: unknown = await response.json().catch(() => null);
        const parsed = telnyxBodySchema.safeParse(json);
        return {
          ok: response.ok,
          status: response.status,
          body: parsed.success ? parsed.data : {},
        };
      },
      catch: () =>
        new OtpProviderError({
          code: "NETWORK_ERROR",
          message: "Telnyx Verify unreachable",
        }),
    });

  const logFailure =
    (operation: "send" | "check") =>
    <A>(
      effect: Effect.Effect<A, OtpProviderError>,
    ): Effect.Effect<A, OtpProviderError> =>
      Effect.tapError(effect, (error) =>
        Effect.sync(() => {
          console.warn(
            `[telnyx-verify] ${operation} failed (${error.code}): ${error.message}`,
          );
        }),
      );

  return {
    startVerification: ({ to }) =>
      post("/verifications/sms", {
        phone_number: to,
        verify_profile_id: settings.verifyProfileId,
      }).pipe(
        Effect.flatMap((reply) => {
          if (reply.ok) {
            return Effect.succeed({ providerRef: reply.body.data?.id ?? null });
          }
          // Telnyx answers 422 for a number it won't send to again yet.
          return httpFailure(
            reply,
            reply.status === 422
              ? "MAX_SEND_ATTEMPTS"
              : failureCode(reply.status),
          );
        }),
        logFailure("send"),
      ),

    checkVerification: ({ to, code }) =>
      post(
        `/verifications/by_phone_number/${encodeURIComponent(to)}/actions/verify`,
        { code, verify_profile_id: settings.verifyProfileId },
      ).pipe(
        Effect.flatMap(
          (reply): Effect.Effect<VerificationCheckResult, OtpProviderError> => {
            // The verdict is in the body. "rejected", or anything we don't
            // recognise, counts as a wrong code, never as approved.
            if (reply.ok) {
              return Effect.succeed(
                CHECK_RESULTS[reply.body.data?.response_code ?? ""] ?? {
                  approved: false,
                  reason: "invalid",
                },
              );
            }
            // No live verification for the number: expired or already used.
            if (reply.status === 404) {
              return Effect.succeed({ approved: false, reason: "expired" });
            }
            return httpFailure(reply, failureCode(reply.status));
          },
        ),
        logFailure("check"),
      ),
  };
}

const notConfigured = fail(
  "NOT_CONFIGURED",
  "Telnyx Verify isn't configured: set TELNYX_API_KEY and TELNYX_VERIFY_PROFILE_ID",
);

const unconfigured: OtpProviderShape = {
  startVerification: () => notConfigured,
  checkVerification: () => notConfigured,
};

/**
 * Optional: without both settings the API still starts, and payout-number
 * verification answers that it isn't set up yet.
 */
export const OtpProviderLive: Layer.Layer<
  OtpProvider,
  ConfigError.ConfigError
> = Layer.effect(
  OtpProvider,
  Effect.gen(function* () {
    const settings = yield* Config.option(
      Config.all({
        apiKey: Config.redacted("TELNYX_API_KEY"),
        verifyProfileId: Config.string("TELNYX_VERIFY_PROFILE_ID"),
      }),
    );
    if (Option.isNone(settings)) {
      console.warn(
        "[telnyx-verify] TELNYX_API_KEY and TELNYX_VERIFY_PROFILE_ID aren't both set; payout numbers can't be confirmed",
      );
      return unconfigured;
    }
    return makeTelnyxVerify(settings.value);
  }),
);
