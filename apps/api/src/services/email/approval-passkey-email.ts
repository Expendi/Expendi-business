import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

/**
 * Sent to every admin of each company the person is an admin of when they
 * set up an approval passkey, so a passkey added from a stolen session is
 * noticed (Phase 1 known issue: passkey enrolment security).
 */
export function approvalPasskeyEnrolledEmail(input: {
  readonly to: string;
  /** Who set it up: their name and email, or just the email. */
  readonly enrolledBy: string;
  readonly companyNames: readonly string[];
}): EmailMessage {
  const who = oneLine(input.enrolledBy);
  const companies = input.companyNames.map(oneLine).join(", ");
  const summary = `${who} set up an approval passkey on Expendi Business. It can approve payouts and withdrawals from ${companies}.`;
  const notYou =
    "If you don't recognise this, contact Expendi support right away so we can remove the passkey.";
  return {
    to: input.to,
    subject: "A new approval passkey was set up",
    text: `${summary}\n\n${notYou}\n`,
    html: `<p>${escapeHtml(summary)}</p>\n<p>${escapeHtml(notYou)}</p>`,
  };
}
