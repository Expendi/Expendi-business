import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

export interface AccountantAccessEmailInput {
  readonly to: string;
  readonly companyName: string;
  readonly inviterName: string;
  readonly dashboardUrl: string;
}

/**
 * An accountant's invite (spec §4, §6.14): view-only access on the web
 * dashboard, never the app.
 */
export function accountantAccessEmail(
  input: AccountantAccessEmailInput,
): EmailMessage {
  const companyName = oneLine(input.companyName);
  const inviterName = oneLine(input.inviterName);
  const intro = `${inviterName} has given you view-only access to ${companyName} on the Expendi Business web dashboard.`;
  const signIn = `Sign in with this email address (${input.to}) at:`;
  return {
    to: input.to,
    subject: `View-only access to ${companyName} on Expendi Business`,
    text: `${intro}\n\n${signIn}\n\n${input.dashboardUrl}\n`,
    html: [
      `<p>${escapeHtml(intro)}</p>`,
      `<p>${escapeHtml(signIn)}</p>`,
      `<p><a href="${escapeHtml(input.dashboardUrl)}">${escapeHtml(input.dashboardUrl)}</a></p>`,
    ].join("\n"),
  };
}
