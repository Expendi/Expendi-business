import type {
  ApprovalChallenge,
  PasskeyRequestOptions,
  TreasuryOffer,
} from "@expendi-business/shared";
import {
  topUpNeededSchema,
  treasuryOfferSchema,
} from "@expendi-business/shared";

import type { PasskeyAssertion } from "./passkeys";
import { ApiError, describeApiError } from "./api";
import { formatKesCents } from "./money";
import { PasskeyUnavailableError, signApprovalChallenge } from "./passkeys";

/**
 * Any money action confirmed with the admin's approval passkey (spec §7.3),
 * as the app runs it (`apps/mobile/src/features/approval/`): the API binds a
 * challenge to exactly this action, the browser signs it, and the API acts
 * on it once. Backing out of the passkey prompt is `cancelled`, not an
 * error, and nothing is sent.
 */

export type ApprovalOutcome<TResult> =
  | { readonly status: "approved"; readonly result: TResult }
  | { readonly status: "cancelled" };

export interface PasskeyApprovalSteps<
  TVariables,
  TChallenge extends ApprovalChallenge,
  TResult,
> {
  /** Asks the API for a challenge bound to exactly this action. */
  readonly request: (variables: TVariables) => Promise<TChallenge>;
  /** Sends the signed challenge back; the API approves and acts on it. */
  readonly confirm: (
    challenge: TChallenge,
    assertion: PasskeyAssertion,
  ) => Promise<TResult>;
}

/** Never retried: a confirmation that may have reached the API is left to the API. */
export async function approveWithPasskey<
  TVariables,
  TChallenge extends ApprovalChallenge,
  TResult,
>(
  steps: PasskeyApprovalSteps<TVariables, TChallenge, TResult>,
  variables: TVariables,
  sign: (
    options: PasskeyRequestOptions,
  ) => Promise<PasskeyAssertion | null> = signApprovalChallenge,
): Promise<ApprovalOutcome<TResult>> {
  const challenge = await steps.request(variables);
  const assertion = await sign(challenge.options);
  if (!assertion) return { status: "cancelled" };
  return {
    status: "approved",
    result: await steps.confirm(challenge, assertion),
  };
}

/** Challenges last 5 minutes; past this, prepare again rather than risk it lapsing mid-prompt. */
export const CHALLENGE_REUSE_MS = 4 * 60_000;

export function isChallengeFresh(preparedAt: number, now: number): boolean {
  return now - preparedAt < CHALLENGE_REUSE_MS;
}

/** "Top up KES X" when the API refused a payment for a short wallet, else null. */
export function topUpFrom(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = topUpNeededSchema.safeParse(error.details);
  return parsed.success
    ? `Top up KES ${formatKesCents(parsed.data.topUpKes)}, then approve again. Nothing was sent.`
    : null;
}

/** The "Move to wallet" offer on a refusal for a short wallet, when the company has money in Treasury. */
export function treasuryOfferFrom(error: unknown): TreasuryOffer | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = error.details;
  if (typeof details !== "object" || details === null) return null;
  const parsed = treasuryOfferSchema.safeParse(
    "treasuryOffer" in details ? details.treasuryOffer : undefined,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * What to tell the admin when a passkey step fails: the "Top up KES X" line,
 * unless the API offered Treasury, whose own message says what to do instead.
 */
export function describeApprovalError(error: unknown): string {
  if (error instanceof PasskeyUnavailableError) return error.message;
  if (treasuryOfferFrom(error)) return describeApiError(error);
  return topUpFrom(error) ?? describeApiError(error);
}
