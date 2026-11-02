import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { ConfigError } from "effect";
import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Config, Context, Effect, Layer } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import {
  approvalPasskeys,
  users,
  webauthnChallenges,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Forbidden } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";

/**
 * Admins confirm money actions with a passkey (spec §7.3), Expendi's own
 * WebAuthn credential (Dennis, 2026-11-01). An approval challenge is derived
 * from the hash of exactly what is approved, is single-use, and expires in
 * minutes, so a signature approves those payouts and amounts and nothing
 * else, once.
 */

const RP_NAME = "Expendi Business";
const CHALLENGE_TTL_MS = 5 * 60_000;

export interface ApprovalSettingsShape {
  readonly rpId: string;
  readonly origins: readonly string[];
}

export class ApprovalSettings extends Context.Tag("ApprovalSettings")<
  ApprovalSettings,
  ApprovalSettingsShape
>() {}

export const ApprovalSettingsLive: Layer.Layer<
  ApprovalSettings,
  ConfigError.ConfigError
> = Layer.effect(
  ApprovalSettings,
  Effect.gen(function* () {
    const rpId = yield* Config.string("WEBAUTHN_RP_ID");
    const origins = yield* Config.string("WEBAUTHN_ORIGINS").pipe(
      Config.map((raw) =>
        raw
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),
      Config.validate({
        message: "WEBAUTHN_ORIGINS needs at least one origin",
        validation: (list) => list.length > 0,
      }),
    );
    return { rpId, origins };
  }),
);

const expired = new Forbidden({
  message: "This confirmation expired or was already used. Confirm again.",
});
const notVerified = new Forbidden({
  message: "Your passkey couldn't be verified. Confirm again.",
});
const alreadyEnrolled = new Forbidden({
  message:
    "You already have an approval passkey. Contact Expendi support to replace it.",
});

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** JSON with sorted keys, bigint as strings: stable input for a hash. */
export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type PasskeyDeps = DatabaseService | AuditLog | ApprovalSettings;

// ── Enrolment ────────────────────────────────────────────────────────────

/**
 * Starts enrolling the user's approval passkey. Only a first passkey can be
 * enrolled this way: otherwise a stolen login could add its own passkey and
 * approve payouts. Replacing a lost one goes through Expendi support.
 */
export function startPasskeyEnrolment(
  userId: string,
): Effect.Effect<
  PublicKeyCredentialCreationOptionsJSON,
  Forbidden | DatabaseError,
  PasskeyDeps
> {
  return withScope({ userId }, (tx) =>
    Effect.gen(function* () {
      const settings = yield* ApprovalSettings;
      const existing = yield* query(() =>
        tx
          .select({ id: approvalPasskeys.id })
          .from(approvalPasskeys)
          .where(eq(approvalPasskeys.userId, userId))
          .limit(1),
      );
      if (existing.length > 0) return yield* Effect.fail(alreadyEnrolled);
      const [user] = yield* query(() =>
        tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1),
      );
      const options = yield* Effect.promise(() =>
        generateRegistrationOptions({
          rpName: RP_NAME,
          rpID: settings.rpId,
          userID: new TextEncoder().encode(userId),
          userName: user?.email ?? userId,
          attestationType: "none",
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
          },
        }),
      );
      yield* query(() =>
        tx.insert(webauthnChallenges).values({
          userId,
          purpose: "register_passkey",
          challenge: options.challenge,
          expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        }),
      );
      return options;
    }),
  );
}

export function finishPasskeyEnrolment(
  userId: string,
  response: RegistrationResponseJSON,
): Effect.Effect<
  { readonly passkeyId: string },
  Forbidden | DatabaseError,
  PasskeyDeps
> {
  return withScope({ userId }, (tx) =>
    Effect.gen(function* () {
      const settings = yield* ApprovalSettings;
      const audit = yield* AuditLog;
      // Two enrolments started side by side queue on the user's row, so the
      // second finds the first passkey and is refused.
      yield* query(() =>
        tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .for("update"),
      );
      const existing = yield* query(() =>
        tx
          .select({ id: approvalPasskeys.id })
          .from(approvalPasskeys)
          .where(eq(approvalPasskeys.userId, userId))
          .limit(1),
      );
      if (existing.length > 0) return yield* Effect.fail(alreadyEnrolled);

      const [challenge] = yield* query(() =>
        tx
          .update(webauthnChallenges)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(webauthnChallenges.userId, userId),
              eq(webauthnChallenges.purpose, "register_passkey"),
              isNull(webauthnChallenges.usedAt),
              gt(webauthnChallenges.expiresAt, new Date()),
              eq(
                webauthnChallenges.challenge,
                expectedChallengeOf(response.response.clientDataJSON),
              ),
            ),
          )
          .returning({ challenge: webauthnChallenges.challenge }),
      );
      if (!challenge) return yield* Effect.fail(expired);

      const verification = yield* Effect.tryPromise({
        try: () =>
          verifyRegistrationResponse({
            response,
            expectedChallenge: challenge.challenge,
            expectedOrigin: [...settings.origins],
            expectedRPID: settings.rpId,
            requireUserVerification: true,
          }),
        catch: () => notVerified,
      });
      if (!verification.verified) return yield* Effect.fail(notVerified);
      const { credential } = verification.registrationInfo;

      const [passkey] = yield* query(() =>
        tx
          .insert(approvalPasskeys)
          .values({
            userId,
            credentialId: credential.id,
            publicKey: isoBase64URL.fromBuffer(credential.publicKey),
            counter: credential.counter,
            transports: credential.transports ?? [],
          })
          .returning({ id: approvalPasskeys.id }),
      );
      if (!passkey)
        return yield* Effect.dieMessage("passkey insert returned no row");
      yield* audit.record(tx, {
        actor: { type: "user", id: userId },
        organizationId: null,
        action: "approval_passkey.enrolled",
        entity: { type: "approval_passkey", id: passkey.id },
        after: { credentialId: credential.id },
      });
      return { passkeyId: passkey.id };
    }),
  );
}

/** The challenge a client signed, as recorded in its clientDataJSON. */
function expectedChallengeOf(clientDataJSON: string): string {
  try {
    const parsed: unknown = JSON.parse(
      isoBase64URL.toUTF8String(clientDataJSON),
    );
    return typeof parsed === "object" &&
      parsed !== null &&
      "challenge" in parsed &&
      typeof parsed.challenge === "string"
      ? parsed.challenge
      : "";
  } catch {
    return "";
  }
}

// ── Approval ─────────────────────────────────────────────────────────────

export interface ApprovalChallenge {
  readonly challengeId: string;
  readonly options: PublicKeyCredentialRequestOptionsJSON;
}

/**
 * Issues a challenge bound to `intentHash` (see `payoutIntentHash`): the
 * challenge is SHA-256(nonce ‖ intentHash), so the passkey signature covers
 * the intent itself, not just a random value mapped to it.
 */
/** What a confirmation is for; enrolment has its own flow. */
export type ConfirmationPurpose =
  | "approve_payouts"
  | "change_allowlist"
  | "change_payee"
  | "change_salary"
  | "change_payroll_margin";

export function startApproval(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly purpose: ConfirmationPurpose;
  readonly intentHash: string;
  /** Required for payout approvals. */
  readonly payoutIds?: readonly string[];
}): Effect.Effect<ApprovalChallenge, Forbidden | DatabaseError, PasskeyDeps> {
  return withScope(
    { organizationId: input.organizationId, userId: input.userId },
    (tx) =>
      Effect.gen(function* () {
        const settings = yield* ApprovalSettings;
        const passkeys = yield* query(() =>
          tx
            .select({
              credentialId: approvalPasskeys.credentialId,
              transports: approvalPasskeys.transports,
            })
            .from(approvalPasskeys)
            .where(eq(approvalPasskeys.userId, input.userId)),
        );
        if (passkeys.length === 0) {
          return yield* Effect.fail(
            new Forbidden({
              message: "Set up your approval passkey before paying.",
            }),
          );
        }
        const challenge = createHash("sha256")
          .update(randomBytes(32))
          .update(input.intentHash, "utf8")
          .digest();
        const options = yield* Effect.promise(() =>
          generateAuthenticationOptions({
            rpID: settings.rpId,
            challenge,
            userVerification: "required",
            allowCredentials: passkeys.map((passkey) => ({
              id: passkey.credentialId,
              transports: passkey.transports as AuthenticatorTransportFuture[],
            })),
          }),
        );
        const [stored] = yield* query(() =>
          tx
            .insert(webauthnChallenges)
            .values({
              userId: input.userId,
              organizationId: input.organizationId,
              purpose: input.purpose,
              challenge: options.challenge,
              intentHash: input.intentHash,
              payoutIds: input.payoutIds ? [...input.payoutIds] : null,
              expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
            })
            .returning({ id: webauthnChallenges.id }),
        );
        if (!stored)
          return yield* Effect.dieMessage("challenge insert returned no row");
        return { challengeId: stored.id, options };
      }),
  );
}

export interface VerifiedApproval {
  readonly approvalId: string;
  readonly intentHash: string;
  readonly payoutIds: readonly string[];
}

/**
 * Consumes the challenge first, in its own transaction, so it is spent
 * even if verification then fails; then checks the passkey's signature.
 * The caller must still compare `intentHash` with the payouts as they are
 * now, under lock, before moving money.
 */
export function verifyApproval(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly purpose: ConfirmationPurpose;
  readonly challengeId: string;
  readonly response: AuthenticationResponseJSON;
}): Effect.Effect<VerifiedApproval, Forbidden | DatabaseError, PasskeyDeps> {
  const scope = { organizationId: input.organizationId, userId: input.userId };
  return Effect.gen(function* () {
    const settings = yield* ApprovalSettings;
    const [challenge] = yield* withScope(scope, (tx) =>
      query(() =>
        tx
          .update(webauthnChallenges)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(webauthnChallenges.id, input.challengeId),
              eq(webauthnChallenges.userId, input.userId),
              eq(webauthnChallenges.organizationId, input.organizationId),
              eq(webauthnChallenges.purpose, input.purpose),
              isNull(webauthnChallenges.usedAt),
              gt(webauthnChallenges.expiresAt, new Date()),
            ),
          )
          .returning(),
      ),
    );
    const intentHash = challenge?.intentHash;
    const payoutIds = challenge?.payoutIds ?? [];
    if (!challenge || !intentHash) {
      return yield* Effect.fail(expired);
    }

    return yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const [passkey] = yield* query(() =>
          tx
            .select()
            .from(approvalPasskeys)
            .where(
              and(
                eq(approvalPasskeys.userId, input.userId),
                eq(approvalPasskeys.credentialId, input.response.id),
              ),
            )
            .limit(1),
        );
        if (!passkey) return yield* Effect.fail(notVerified);

        const verification = yield* Effect.tryPromise({
          try: () =>
            verifyAuthenticationResponse({
              response: input.response,
              expectedChallenge: challenge.challenge,
              expectedOrigin: [...settings.origins],
              expectedRPID: settings.rpId,
              requireUserVerification: true,
              credential: {
                id: passkey.credentialId,
                publicKey: isoBase64URL.toBuffer(passkey.publicKey),
                counter: passkey.counter,
                transports:
                  passkey.transports as AuthenticatorTransportFuture[],
              },
            }),
          catch: () => notVerified,
        });
        if (!verification.verified) return yield* Effect.fail(notVerified);

        yield* query(() =>
          tx
            .update(approvalPasskeys)
            .set({
              counter: verification.authenticationInfo.newCounter,
              lastUsedAt: new Date(),
            })
            .where(eq(approvalPasskeys.id, passkey.id)),
        );
        return { approvalId: challenge.id, intentHash, payoutIds };
      }),
    );
  });
}
