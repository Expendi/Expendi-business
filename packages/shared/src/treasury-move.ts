import { z } from "zod";

/**
 * `to_treasury`: the company wallet's USDC goes to the Treasury wallet and
 * into the vault. `to_wallet`: it comes out of the vault and back to the
 * company wallet.
 */
export const TREASURY_MOVE_DIRECTIONS = ["to_treasury", "to_wallet"] as const;
export const treasuryMoveDirectionSchema = z.enum(TREASURY_MOVE_DIRECTIONS);
export type TreasuryMoveDirection = z.infer<typeof treasuryMoveDirectionSchema>;

/**
 * - `open`: parts are still moving; the unsent amount is reserved.
 * - `completed`: every part landed.
 * - `returned`: a part was refunded and came back to the company wallet.
 * - `failed`: nothing moved.
 * - `needs_review`: what happened is unclear; a person is checking it. The
 *   reservation holds until it is settled.
 */
export const TREASURY_MOVE_STATUSES = [
  "open",
  "completed",
  "returned",
  "failed",
  "needs_review",
] as const;
export const treasuryMoveStatusSchema = z.enum(TREASURY_MOVE_STATUSES);
export type TreasuryMoveStatus = z.infer<typeof treasuryMoveStatusSchema>;

/** Statuses in which a move still holds its company's one slot. */
export const UNSETTLED_TREASURY_MOVE_STATUSES = [
  "open",
  "needs_review",
] as const satisfies readonly TreasuryMoveStatus[];
