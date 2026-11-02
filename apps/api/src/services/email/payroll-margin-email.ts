import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

export interface PayrollMarginEmailInput {
  readonly to: string;
  readonly companyName: string;
  /** The admin who confirmed the change with their passkey. */
  readonly actorName: string;
  readonly beforePct: number;
  readonly afterPct: number;
}

/**
 * Sent to every admin when the payroll cap's margin changes (spec §7.4):
 * it decides how far a payroll run may go beyond the salaries set up.
 */
export function payrollMarginEmail(
  input: PayrollMarginEmailInput,
): EmailMessage {
  const companyName = oneLine(input.companyName);
  const actorName = oneLine(input.actorName);
  const paragraphs = [
    `${actorName} changed the payroll cap's margin at ${companyName} on Expendi Business.`,
    `It was ${input.beforePct}% and is now ${input.afterPct}%. A payroll run can now pay up to its salaries plus ${input.afterPct}%. Draft runs use the new margin at once.`,
    `If you didn't expect this, check with ${actorName} and contact Expendi support right away.`,
  ];
  return {
    to: input.to,
    subject: "Payroll cap margin changed",
    text: `${paragraphs.join("\n\n")}\n`,
    html: paragraphs
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join("\n"),
  };
}
