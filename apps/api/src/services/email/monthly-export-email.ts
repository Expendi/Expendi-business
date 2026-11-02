import type { ExportFile } from "@expendi-business/shared";

import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

export interface MonthlyExportEmailInput {
  readonly to: string;
  readonly companyName: string;
  /** e.g. "October 2026". */
  readonly monthLabel: string;
  readonly links: Readonly<Record<ExportFile, string>>;
  /** e.g. "1 December 2026". */
  readonly expiresOn: string;
  readonly idempotencyKey: string;
}

const LINK_LABELS: Readonly<Record<ExportFile, string>> = {
  workbook: "Spreadsheet (Excel)",
  csv: "Spreadsheet (CSV files)",
  receipts: "Receipts (zip)",
};

const FILES: readonly ExportFile[] = ["workbook", "csv", "receipts"];

/**
 * The monthly export for a company's accountant (spec §6.11): everything
 * paid out last month, the bills still owed at its end, and the receipts.
 */
export function monthlyExportEmail(
  input: MonthlyExportEmailInput,
): EmailMessage {
  const companyName = oneLine(input.companyName);
  const intro = `Here is ${companyName}'s export for ${input.monthLabel}: all money paid out that month, the bills still owed at its end, and the month's receipts.`;
  const expiry = `These links work until ${input.expiresOn}. After that, an admin can share a new export from the Expendi Business app.`;
  return {
    to: input.to,
    subject: `${companyName}: ${input.monthLabel} export`,
    idempotencyKey: input.idempotencyKey,
    text: [
      intro,
      ...FILES.map((file) => `${LINK_LABELS[file]}: ${input.links[file]}`),
      expiry,
    ].join("\n\n"),
    html: [
      `<p>${escapeHtml(intro)}</p>`,
      `<ul>${FILES.map(
        (file) =>
          `<li><a href="${escapeHtml(input.links[file])}">${escapeHtml(LINK_LABELS[file])}</a></li>`,
      ).join("")}</ul>`,
      `<p>${escapeHtml(expiry)}</p>`,
    ].join("\n"),
  };
}
