import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

export interface InvoiceEmailInput {
  readonly to: string;
  readonly customerName: string;
  readonly companyName: string;
  readonly number: string;
  readonly totalCents: bigint;
  /** `YYYY-MM-DD`. */
  readonly dueOn: string;
  readonly note: string | null;
  readonly payUrl: string;
  readonly idempotencyKey: string;
  /** A reminder says so; the first email introduces the invoice. */
  readonly reminder: boolean;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** `2026-12-02` as "2 December 2026". */
export function longDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  const monthName = MONTHS[Number(month) - 1];
  return monthName === undefined
    ? isoDate
    : `${Number(day)} ${monthName} ${year}`;
}

/** Cents as dollars with thousands separators: 1234567 is "12,345.67". */
export function dollars(cents: bigint): string {
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * An invoice for a customer (docs/decisions/crypto-invoicing.md): the
 * amount, when it is due, and the link where they pay without an account.
 */
export function invoiceEmail(input: InvoiceEmailInput): EmailMessage {
  const companyName = oneLine(input.companyName);
  const customerName = oneLine(input.customerName);
  const amount = `$${dollars(input.totalCents)}`;
  const due = longDate(input.dueOn);
  const intro = input.reminder
    ? `A reminder from ${companyName}: invoice ${input.number} for ${amount} is due ${due}.`
    : `${companyName} sent you invoice ${input.number} for ${amount}, due ${due}.`;
  const note = input.note?.trim() ? input.note.trim() : null;
  const ask = "You can see the invoice and pay it in USDC with no account.";
  const pdfUrl = `${input.payUrl}/pdf`;
  return {
    to: input.to,
    subject: `Invoice ${input.number} from ${companyName} — ${amount} due ${due}`,
    idempotencyKey: input.idempotencyKey,
    text: [
      `Hi ${customerName},`,
      intro,
      ...(note ? [`Note from ${companyName}: ${note}`] : []),
      `${ask}\nView and pay: ${input.payUrl}\nDownload PDF: ${pdfUrl}`,
    ].join("\n\n"),
    html: [
      `<p>Hi ${escapeHtml(customerName)},</p>`,
      `<p>${escapeHtml(intro)}</p>`,
      ...(note
        ? [
            `<p>Note from ${escapeHtml(companyName)}:<br>${escapeHtml(note).replace(/\n/g, "<br>")}</p>`,
          ]
        : []),
      `<p>${escapeHtml(ask)}</p>`,
      `<p><a href="${escapeHtml(input.payUrl)}">View and pay</a> · <a href="${escapeHtml(pdfUrl)}">Download PDF</a></p>`,
    ].join("\n"),
  };
}
