import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

export interface TreasuryTurnedOnEmailInput {
  readonly to: string;
  readonly companyName: string;
  /** The admin who confirmed it with their passkey. */
  readonly actorName: string;
}

/** Sent to every admin when a company turns Treasury on. */
export function treasuryTurnedOnEmail(
  input: TreasuryTurnedOnEmailInput,
): EmailMessage {
  const companyName = oneLine(input.companyName);
  const actorName = oneLine(input.actorName);
  const paragraphs = [
    `${actorName} turned on Treasury at ${companyName} on Expendi Business.`,
    "Treasury is an account that earns yield on USDC the company isn't about to spend. Turning it on moved no money. Only an admin can move money in or out, each time with a passkey.",
    `If you didn't expect this, check with ${actorName} and contact Expendi support right away.`,
  ];
  return {
    to: input.to,
    subject: "Treasury turned on",
    text: `${paragraphs.join("\n\n")}\n`,
    html: paragraphs
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join("\n"),
  };
}
