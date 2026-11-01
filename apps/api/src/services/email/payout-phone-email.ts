import type { EmailMessage } from "./email-sender.js";

const lastDigits = (phone: string) => phone.slice(-4);

const notYou =
  "If this wasn't you, contact your company's admin and Expendi support right away.";

/** Sent when someone sets or changes their payout number (spec §6.18). */
export function payoutPhoneSetEmail(input: {
  readonly to: string;
  readonly phone: string;
  readonly changed: boolean;
}): EmailMessage {
  const what = input.changed ? "changed" : "set";
  const summary = `Your M-Pesa payout number on Expendi Business was ${what} to the number ending ${lastDigits(input.phone)}. Claims are now paid to it.`;
  return {
    to: input.to,
    subject: `Your payout number was ${what}`,
    text: `${summary}\n\n${notYou}\n`,
    html: `<p>${summary}</p>\n<p>${notYou}</p>`,
  };
}

/**
 * Sent to the previous holder when another person confirms their number:
 * numbers get recycled, so the latest confirmation wins (spec §6.18).
 */
export function payoutPhoneRemovedEmail(input: {
  readonly to: string;
  readonly phone: string;
}): EmailMessage {
  const summary = `Your M-Pesa payout number ending ${lastDigits(input.phone)} was confirmed by another Expendi Business account, so it was removed from yours.`;
  const next =
    "Add and confirm your M-Pesa number in the app before your next payout.";
  return {
    to: input.to,
    subject: "Your payout number was removed",
    text: `${summary}\n\n${next}\n\n${notYou}\n`,
    html: `<p>${summary}</p>\n<p>${next}</p>\n<p>${notYou}</p>`,
  };
}
