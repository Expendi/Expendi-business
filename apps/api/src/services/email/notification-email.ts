import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

export interface NotificationEmailInput {
  readonly to: string;
  readonly companyName: string;
  /** The push notification's title and body, reused word for word. */
  readonly title: string;
  readonly body: string;
  /** Stable per message and recipient, so Resend drops a resend after a crash. */
  readonly idempotencyKey: string;
}

/**
 * The email copy of a push notification (spec §6.10): due-date reminders
 * and low-balance warnings, to each admin.
 */
export function notificationEmail(input: NotificationEmailInput): EmailMessage {
  const companyName = oneLine(input.companyName);
  const paragraphs = [
    `${companyName} on Expendi Business:`,
    input.body,
    "Open the Expendi Business app to review it.",
  ];
  return {
    to: input.to,
    subject: `${oneLine(input.title)}: ${companyName}`,
    text: `${paragraphs.join("\n\n")}\n`,
    html: paragraphs
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join("\n"),
    idempotencyKey: input.idempotencyKey,
  };
}
