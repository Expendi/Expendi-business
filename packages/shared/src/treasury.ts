import { z } from "zod";

import { approvalChallengeSchema, passkeyAssertionSchema } from "./approval.js";
import {
  treasuryMoveDirectionSchema,
  treasuryMoveStatusSchema,
} from "./treasury-move.js";

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

/** USDC amounts are 6-decimal base units, serialised as positive integer strings. */
const usdcUnits = z.string().regex(/^[1-9]\d{0,18}$/);
const usdcUnitsOrZero = z.string().regex(/^\d{1,19}$/);
const usdcSigned = z.string().regex(/^-?\d{1,19}$/);

/**
 * The least a move may carry, in USDC base units. A move to the wallet may
 * also take "all" of what is there, whatever that is.
 */
export const MIN_TREASURY_MOVE_USDC = 10_000_000n;

/**
 * `POST /organizations/:id/treasury/moves/preview` and `…/confirmations`: the
 * direction and the amount the admin is about to confirm.
 */
export const treasuryMoveRequestSchema = z.object({
  direction: treasuryMoveDirectionSchema,
  /** `"all"` is only for a move to the wallet: everything the vault holds then. */
  amountUsdc: usdcUnits.or(z.literal("all")),
});

export type TreasuryMoveRequest = z.input<typeof treasuryMoveRequestSchema>;

/** What a move would cost and take, worked out before anything is committed. */
export const treasuryMovePreviewSchema = z.object({
  direction: treasuryMoveDirectionSchema,
  /** For "all", what the vault holds now. */
  amountUsdc: usdcUnits,
  isAll: z.boolean().optional(),
  /** How many transfers the amount is split into, each within the wallet's cap. */
  parts: z.number().int().positive(),
  perPartMaxUsdc: usdcUnits,
  /** What 1Click charges for all the parts, which the company pays. */
  estimatedCostUsdc: usdcUnitsOrZero,
  estimatedSeconds: z.number().int().positive(),
  /** What the company wallet can spend now, after what is already reserved. */
  availableUsdc: usdcUnitsOrZero,
  /** A move to the wallet only: what Treasury is worth now. */
  inTreasuryUsdc: usdcUnitsOrZero.optional(),
});

export type TreasuryMovePreview = z.infer<typeof treasuryMovePreviewSchema>;

/** `POST /organizations/:id/treasury/moves`: starts the move once the passkey has confirmed it. */
export const startTreasuryMoveRequestSchema = treasuryMoveRequestSchema.extend({
  challengeId: z.uuid(),
  response: passkeyAssertionSchema,
});

export type StartTreasuryMoveRequest = z.input<
  typeof startTreasuryMoveRequestSchema
>;

/** `POST /organizations/:id/treasury/moves/confirmations`: the passkey challenge. */
export const treasuryMoveChallengeSchema = approvalChallengeSchema;

/** One Treasury move as the history shows it. */
export const treasuryMoveSchema = z.object({
  id: z.uuid(),
  direction: treasuryMoveDirectionSchema,
  status: treasuryMoveStatusSchema,
  requestedUsdc: usdcUnits,
  /** What reached the vault, or the wallet; null until the move settles. */
  movedUsdc: usdcUnitsOrZero.nullable(),
  /** What the move cost; null until it settles. */
  costUsdc: usdcSigned.nullable(),
  failure: z.string().nullable(),
  createdAt: z.iso.datetime(),
  settledAt: z.iso.datetime().nullable(),
});

export type TreasuryMoveSummary = z.infer<typeof treasuryMoveSchema>;

export const treasuryMoveListSchema = z.object({
  moves: z.array(treasuryMoveSchema),
});

export type TreasuryMoveList = z.infer<typeof treasuryMoveListSchema>;
