import { pushNotificationDataSchema } from "@expendi-business/shared";

/** The claim a tapped notification opens, in the company it's about. */
export interface NotificationTarget {
  readonly organizationId: string;
  readonly claimId: string;
}

/** Null for anything this version of the app can't open. */
export function notificationTarget(data: unknown): NotificationTarget | null {
  const parsed = pushNotificationDataSchema.safeParse(data);
  if (!parsed.success) return null;
  return {
    organizationId: parsed.data.organizationId,
    claimId: parsed.data.claimId,
  };
}
