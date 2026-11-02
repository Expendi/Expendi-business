import { z } from "zod";

/**
 * Approval passkeys (spec §7.3): the admin's own WebAuthn credential that
 * confirms every money action. The JSON shapes are what
 * `@simplewebauthn/server` produces and verifies, and what the app's
 * `react-native-passkeys` takes and returns.
 */

const base64Url = z.string().regex(/^[A-Za-z0-9_-]*$/);

const userVerificationSchema = z.enum(["required", "preferred", "discouraged"]);

export const AUTHENTICATOR_TRANSPORTS = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
] as const;

const credentialDescriptorSchema = z.object({
  id: base64Url,
  type: z.literal("public-key"),
  transports: z.array(z.enum(AUTHENTICATOR_TRANSPORTS)).optional(),
});

/** `POST /me/approval-passkey/options`: what the phone creates the passkey from. */
export const passkeyCreationOptionsSchema = z.object({
  rp: z.object({ id: z.string().optional(), name: z.string() }),
  user: z.object({
    id: base64Url,
    name: z.string(),
    displayName: z.string(),
  }),
  challenge: base64Url,
  pubKeyCredParams: z.array(
    z.object({ type: z.literal("public-key"), alg: z.number() }),
  ),
  timeout: z.number().optional(),
  excludeCredentials: z.array(credentialDescriptorSchema).optional(),
  authenticatorSelection: z
    .object({
      authenticatorAttachment: z
        .enum(["platform", "cross-platform"])
        .optional(),
      requireResidentKey: z.boolean().optional(),
      residentKey: z.enum(["required", "preferred", "discouraged"]).optional(),
      userVerification: userVerificationSchema.optional(),
    })
    .optional(),
  attestation: z.enum(["none", "indirect", "direct", "enterprise"]).optional(),
});

export type PasskeyCreationOptions = z.infer<
  typeof passkeyCreationOptionsSchema
>;

/** What the phone signs to confirm one money action. */
export const passkeyRequestOptionsSchema = z.object({
  challenge: base64Url,
  timeout: z.number().optional(),
  rpId: z.string().optional(),
  allowCredentials: z.array(credentialDescriptorSchema).optional(),
  userVerification: userVerificationSchema.optional(),
});

export type PasskeyRequestOptions = z.infer<typeof passkeyRequestOptionsSchema>;

/**
 * A passkey challenge bound to exactly one action (payouts, a withdrawal,
 * an allowlist change). Single-use and valid for 5 minutes.
 */
export const approvalChallengeSchema = z.object({
  challengeId: z.uuid(),
  options: passkeyRequestOptionsSchema,
});

export type ApprovalChallenge = z.infer<typeof approvalChallengeSchema>;

const clientExtensionResults = z.record(z.string(), z.unknown());
const authenticatorAttachment = z.enum(["platform", "cross-platform"]);

/**
 * The new passkey as the phone returns it. Only the shape is checked here;
 * the API verifies it cryptographically.
 */
export const passkeyRegistrationSchema = z.object({
  id: base64Url,
  rawId: base64Url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: base64Url,
    attestationObject: base64Url,
  }),
  authenticatorAttachment: authenticatorAttachment.optional(),
  clientExtensionResults,
});

/**
 * A signed challenge as the phone returns it. Only the shape is checked
 * here; the API verifies the signature.
 */
export const passkeyAssertionSchema = z.object({
  id: base64Url,
  rawId: base64Url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: base64Url,
    authenticatorData: base64Url,
    signature: base64Url,
    userHandle: z.string().optional(),
  }),
  authenticatorAttachment: authenticatorAttachment.optional(),
  clientExtensionResults,
});

/** `GET /me/approval-passkey`. */
export const approvalPasskeyStatusSchema = z.object({
  enrolled: z.boolean(),
  /** When the passkey was set up; null until then. */
  enrolledAt: z.iso.datetime().nullable(),
});

export type ApprovalPasskeyStatus = z.infer<typeof approvalPasskeyStatusSchema>;
