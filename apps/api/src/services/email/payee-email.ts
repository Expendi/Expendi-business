import { PAYEE_CHANGE_HOLD_HOURS } from "@expendi-business/shared";

import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

export interface PayeeDetailsEmailInput {
  readonly to: string;
  readonly companyName: string;
  /** The admin who confirmed the change with their passkey. */
  readonly actorName: string;
  readonly payeeName: string;
  /** A new payee with details, or new details for an existing one. */
  readonly created: boolean;
  /** Already masked: `describeDetails`. */
  readonly details: string;
}

/**
 * Sent to every admin when a payee is added with payment details or its
 * details change (spec §6.19, §7.8): swapped details are a common route
 * for payment fraud, so every admin hears about it.
 */
export function payeeDetailsEmail(input: PayeeDetailsEmailInput): EmailMessage {
  const companyName = oneLine(input.companyName);
  const actorName = oneLine(input.actorName);
  const payeeName = oneLine(input.payeeName);
  const what = input.created
    ? `${actorName} added ${payeeName} as a payee of ${companyName} on Expendi Business.`
    : `${actorName} changed the payment details of ${payeeName}, a payee of ${companyName} on Expendi Business.`;
  const where = `${payeeName} is now paid to: ${input.details}.`;
  const hold = `For the next ${PAYEE_CHANGE_HOLD_HOURS} hours, paying ${payeeName} needs a second confirmation.`;
  const check = `If you didn't expect this, check with ${actorName} and contact Expendi support right away.`;
  const paragraphs = [what, where, hold, check];
  return {
    to: input.to,
    subject: input.created
      ? `New payee on ${companyName}: ${payeeName}`
      : `Payment details changed for ${payeeName}`,
    text: `${paragraphs.join("\n\n")}\n`,
    html: paragraphs
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join("\n"),
  };
}
