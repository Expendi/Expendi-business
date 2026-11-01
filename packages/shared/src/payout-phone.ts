import { z } from "zod";

/** The employee's M-Pesa number; the API accepts Kenyan numbers only. */
export const startPayoutPhoneRequestSchema = z.object({
  phone: z
    .string({ error: "Enter your M-Pesa number." })
    .trim()
    .min(1, "Enter your M-Pesa number."),
});

export type StartPayoutPhoneRequest = z.input<
  typeof startPayoutPhoneRequestSchema
>;

const challengeId = z.uuid("That code wasn't found. Enter your number again.");

export const resendPayoutPhoneCodeRequestSchema = z.object({ challengeId });

export type ResendPayoutPhoneCodeRequest = z.infer<
  typeof resendPayoutPhoneCodeRequestSchema
>;

const enterCode = "Enter the code from the SMS.";

export const confirmPayoutPhoneRequestSchema = z.object({
  challengeId,
  code: z
    .string({ error: enterCode })
    .trim()
    .regex(/^\d{4,10}$/, enterCode),
});

export type ConfirmPayoutPhoneRequest = z.input<
  typeof confirmPayoutPhoneRequestSchema
>;

/** A code on its way, from starting or resending. */
export const payoutPhoneChallengeSchema = z.object({
  challengeId: z.uuid(),
  /** The number being confirmed, E.164. */
  phone: z.string(),
  expiresAt: z.iso.datetime(),
  /** When the app can offer "Send again". */
  resendAvailableAt: z.iso.datetime(),
});

export type PayoutPhoneChallenge = z.infer<typeof payoutPhoneChallengeSchema>;

export const confirmPayoutPhoneResponseSchema = z.object({
  /** Now the user's payout number, E.164. */
  phone: z.string(),
  phoneVerifiedAt: z.iso.datetime(),
});

export type ConfirmPayoutPhoneResponse = z.infer<
  typeof confirmPayoutPhoneResponseSchema
>;
