import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

export interface InvoiceReceiptEmailInput {
  readonly to: string;
  readonly invoiceNumber: string;
  readonly companyName: string;
  /** What the customer sent, in USDC base units (6 decimals). */
  readonly amountUsdc: bigint;
  /** The chain the customer paid from, e.g. "Base". */
  readonly chainName: string;
  /** The Nairobi day the payment arrived, `YYYY-MM-DD`. */
  readonly paidOn: string;
  readonly paymentId: string;
}

/** 1_500_500_000n as "1,500.50": whole cents at least, more places if the amount has them. */
function formatUsdc(units: bigint): string {
  const digits = units.toString().padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = digits.slice(-6).replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}

/** The customer's receipt once a payment through the pay link is recorded. */
export function invoiceReceiptEmail(
  input: InvoiceReceiptEmailInput,
): EmailMessage {
  const invoiceNumber = oneLine(input.invoiceNumber);
  const companyName = oneLine(input.companyName);
  const lines = [
    `${companyName} received your payment for invoice ${invoiceNumber}.`,
    `Amount: ${formatUsdc(input.amountUsdc)} USDC`,
    `Paid from: ${input.chainName}`,
    `Date: ${input.paidOn}`,
  ];
  return {
    to: input.to,
    subject: `Payment received for invoice ${invoiceNumber}`,
    text: `${lines.join("\n")}\n\nKeep this email as your receipt.\n`,
    html: [
      `<p>${escapeHtml(lines[0] ?? "")}</p>`,
      "<ul>",
      ...lines.slice(1).map((line) => `<li>${escapeHtml(line)}</li>`),
      "</ul>",
      "<p>Keep this email as your receipt.</p>",
    ].join("\n"),
    idempotencyKey: `invoice-payment-${input.paymentId}-receipt`,
  };
}
