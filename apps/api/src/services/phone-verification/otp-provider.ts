import type { Effect } from "effect";
import { Context, Data } from "effect";

/**
 * Something that can send and check an SMS code, ported from the consumer
 * backend's `otp-provider.ts`. The provider generates, delivers and checks
 * the code, so the API never sees or stores it; payout-number verification
 * keeps the limits and the challenge state.
 */

export type OtpProviderErrorCode =
  | "NOT_CONFIGURED"
  /** The provider won't send another code to this number for now. */
  | "MAX_SEND_ATTEMPTS"
  | "RATE_LIMITED"
  | "API_ERROR"
  | "NETWORK_ERROR";

/**
 * An infrastructure failure. Its message never includes the number or the
 * provider's reply, so it can be logged as it is.
 */
export class OtpProviderError extends Data.TaggedError("OtpProviderError")<{
  readonly message: string;
  readonly code: OtpProviderErrorCode;
}> {}

/** What checking a code found. A wrong code is an outcome, not an error. */
export type VerificationCheckResult =
  | { readonly approved: true }
  | {
      readonly approved: false;
      readonly reason: "invalid" | "expired" | "max_attempts";
    };

export interface OtpProviderShape {
  /** Sends a code to an E.164 number; `providerRef` is the provider's ID for it. */
  readonly startVerification: (params: {
    readonly to: string;
  }) => Effect.Effect<
    { readonly providerRef: string | null },
    OtpProviderError
  >;

  readonly checkVerification: (params: {
    readonly to: string;
    readonly code: string;
  }) => Effect.Effect<VerificationCheckResult, OtpProviderError>;
}

export class OtpProvider extends Context.Tag("OtpProvider")<
  OtpProvider,
  OtpProviderShape
>() {}
