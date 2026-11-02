import { z } from "zod";

/** Push notifications (spec §6.10), sent through Expo. */

export const PUSH_PLATFORMS = ["ios", "android"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** `ExponentPushToken[…]`, or the newer `ExpoPushToken[…]`, as expo-notifications returns it. */
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]+\]$/;
export const EXPO_PUSH_TOKEN_MAX_LENGTH = 200;

const notAPushToken = "That isn't an Expo push token.";

export const expoPushTokenSchema = z
  .string({ error: notAPushToken })
  .max(EXPO_PUSH_TOKEN_MAX_LENGTH, notAPushToken)
  .regex(EXPO_PUSH_TOKEN_PATTERN, notAPushToken);

/** `POST /me/push-tokens`: this device's token, for whoever is signed in on it now. */
export const registerPushTokenRequestSchema = z.object({
  token: expoPushTokenSchema,
  platform: z.enum(PUSH_PLATFORMS, { error: "Pick ios or android." }),
});

export type RegisterPushTokenRequest = z.infer<
  typeof registerPushTokenRequestSchema
>;

export const registerPushTokenResponseSchema = z.object({
  registered: z.literal(true),
});

export type RegisterPushTokenResponse = z.infer<
  typeof registerPushTokenResponseSchema
>;

/** `DELETE /me/push-tokens/:token`, on sign-out. */
export const unregisterPushTokenResponseSchema = z.object({
  /** False when this person had no active registration for the token. */
  unregistered: z.boolean(),
});

export type UnregisterPushTokenResponse = z.infer<
  typeof unregisterPushTokenResponseSchema
>;

export const CLAIM_NOTIFICATION_TYPES = [
  "claim_submitted",
  "claim_rejected",
  "claim_paid",
  "claim_payout_failed",
] as const;
export type ClaimNotificationType = (typeof CLAIM_NOTIFICATION_TYPES)[number];

export const claimNotificationDataSchema = z.object({
  type: z.enum(CLAIM_NOTIFICATION_TYPES),
  organizationId: z.uuid(),
  claimId: z.uuid(),
});

export type ClaimNotificationData = z.infer<typeof claimNotificationDataSchema>;

/**
 * Bills, payroll, the wallet and floats (spec §6.10). Each push names the
 * company and the record: `billId` (bill reminders, salary paid),
 * `payrollRunId`, `floatId`; `wallet_short` names only the company.
 */
export const SPENDING_NOTIFICATION_TYPES = [
  "bill_due_soon",
  "bill_due_today",
  "bill_overdue",
  "payroll_ready",
  "wallet_short",
  "salary_paid",
  "float_issued",
  "float_topped_up",
] as const;
export type SpendingNotificationType =
  (typeof SPENDING_NOTIFICATION_TYPES)[number];

/**
 * What a push carries for the app to open when it's tapped. Bills, payroll
 * and floats (T43) add their own shapes here.
 */
export const pushNotificationDataSchema = claimNotificationDataSchema;

export type PushNotificationData = z.infer<typeof pushNotificationDataSchema>;
