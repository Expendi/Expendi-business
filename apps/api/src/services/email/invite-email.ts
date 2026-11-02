import type { EmailMessage } from "./email-sender.js";

export interface InviteEmailInput {
  readonly to: string;
  readonly companyName: string;
  readonly inviterName: string;
  readonly installUrl: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Company and inviter names are typed by users, so they're escaped. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export const oneLine = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

/** The invite (spec §6.2): who asked, which company, and the install link. */
export function inviteEmail(input: InviteEmailInput): EmailMessage {
  const companyName = oneLine(input.companyName);
  const inviterName = oneLine(input.inviterName);
  const intro = `${inviterName} invited you to join ${companyName} on Expendi Business.`;
  const signIn = `Install the app and sign in with this email address (${input.to}).`;
  return {
    to: input.to,
    subject: `${inviterName} invited you to ${companyName} on Expendi Business`,
    text: `${intro}\n\n${signIn}\n\n${input.installUrl}\n`,
    html: [
      `<p>${escapeHtml(intro)}</p>`,
      `<p>${escapeHtml(signIn)}</p>`,
      `<p><a href="${escapeHtml(input.installUrl)}">Install Expendi Business</a></p>`,
    ].join("\n"),
  };
}
