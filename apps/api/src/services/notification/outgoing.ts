/**
 * `member`: that one person, if they're still an active member when it's
 * sent. `admins`: the company's active admins at that moment, less someone
 * who gets their own message about the same event.
 */
export type NotificationAudience =
  | { readonly to: "member"; readonly membershipId: string }
  | { readonly to: "admins"; readonly exceptMembershipId: string | null };

export type NotificationChannel = "push" | "email";

/** One message for one audience, as an event's composer words it. */
export interface OutgoingNotification {
  readonly audience: NotificationAudience;
  readonly title: string;
  readonly body: string;
  /** What the app opens when it's tapped; always names the company. */
  readonly data: Readonly<Record<string, string>> & {
    readonly organizationId: string;
  };
  /** Push always; due-date reminders and low balance by email too (spec §6.10). */
  readonly alsoByEmail?: boolean;
  /**
   * The message's identity, unique per company and channel in the outbox,
   * so queueing it again (a re-run, a second instance) adds nothing. Left
   * out, every event sends, e.g. a claim submitted again after a rejection.
   */
  readonly dedupeKey?: string;
}
