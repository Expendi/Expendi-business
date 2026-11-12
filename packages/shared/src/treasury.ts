import { z } from "zod";

import { approvalChallengeSchema, passkeyAssertionSchema } from "./approval.js";

/**
 * `GET /organizations/:id/treasury`. `unavailable` while no Earn vault is
 * configured: clients hide Treasury entirely then. Figures (value, yield,
 * rate) come with the move flow.
 */
export const treasuryStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("off") }),
  z.object({ status: z.literal("on"), address: z.string() }),
]);

export type TreasuryStatus = z.infer<typeof treasuryStatusSchema>;

/** `POST /organizations/:id/treasury/confirmations`: the passkey challenge. */
export const turnOnTreasuryChallengeSchema = approvalChallengeSchema;

/** `POST /organizations/:id/treasury`: turns Treasury on once confirmed. */
export const turnOnTreasuryRequestSchema = z.object({
  challengeId: z.uuid(),
  response: passkeyAssertionSchema,
});

export type TurnOnTreasuryRequest = z.input<typeof turnOnTreasuryRequestSchema>;
