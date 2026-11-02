import { formatKesAmount } from "@expendi-business/shared";

import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

export interface SalaryChangeEmailInput {
  readonly to: string;
  readonly companyName: string;
  /** The admin who confirmed the change with their passkey. */
  readonly actorName: string;
  readonly payeeName: string;
  readonly beforeKes: bigint;
  readonly afterKes: bigint;
}

/**
 * Sent to every admin when someone's net pay changes (spec §7.4): it moves
 * the payroll cap, so every admin hears about it. Only admins get it, as
 * only they see salaries (spec §4).
 */
export function salaryChangeEmail(input: SalaryChangeEmailInput): EmailMessage {
  const companyName = oneLine(input.companyName);
  const actorName = oneLine(input.actorName);
  const payeeName = oneLine(input.payeeName);
  const paragraphs = [
    `${actorName} changed ${payeeName}'s monthly net pay at ${companyName} on Expendi Business.`,
    `It was ${formatKesAmount(input.beforeKes)} and is now ${formatKesAmount(input.afterKes)}. Payroll runs drafted from now on use the new amount.`,
    `If you didn't expect this, check with ${actorName} and contact Expendi support right away.`,
  ];
  return {
    to: input.to,
    subject: `Salary changed for ${payeeName}`,
    text: `${paragraphs.join("\n\n")}\n`,
    html: paragraphs
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join("\n"),
  };
}
