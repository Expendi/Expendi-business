import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import PDFDocument from "pdfkit";

import type { FundInChain, PublicInvoice } from "@expendi-business/shared";
import {
  FUND_IN_CHAIN_NAMES,
  nearTransactionUrl,
} from "@expendi-business/shared";

import type { ConfigService } from "../../config.js";
import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError, NotFound } from "../../errors.js";
import type { RenderOptions } from "./pdf-style.js";
import {
  intentQuotes,
  invoicePayments,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { dollars, longDate } from "../email/invoice-email.js";
import { formatUsdc } from "../email/invoice-receipt-email.js";
import { chainOfAsset } from "../intents/fund-in.js";
import { payUrlFor } from "./invoices.js";
import { getPublicInvoice } from "./pay-link.js";
import {
  BOTTOM,
  BRAND_MARK,
  CONTENT_WIDTH,
  CORAL,
  FONT_REGULAR,
  FONT_SEMIBOLD,
  INK,
  MUTED,
  PAGE_MARGIN,
  PAGE_WIDTH,
  PAID_GREEN,
  RULE,
} from "./pdf-style.js";
import { findInvoiceByPublicId } from "./public-lookup.js";

/**
 * The invoice as a PDF, for `GET /pay/:publicId/pdf`. The page is the
 * pay page's invoice with the paper extras: who paid it, how, and the link.
 */

export interface InvoicePdfPayment {
  /** The Nairobi day the money arrived, `YYYY-MM-DD`. */
  readonly paidOn: string;
  /** USDC base units; null for money that moved outside Expendi. */
  readonly amountUsdc: bigint | null;
  readonly chain: FundInChain | null;
  /** The NEAR transaction that credited the company wallet. */
  readonly txHash: string | null;
}

export interface InvoicePdfData {
  readonly invoice: PublicInvoice;
  /** Where the customer pays; null once it isn't open or no dashboard origin is set. */
  readonly payUrl: string | null;
  /** Set when the invoice is paid and a payment explains it. */
  readonly payment: InvoicePdfPayment | null;
}

/** The payment that settled the invoice: the earliest recorded. */
function readPayment(target: {
  readonly invoiceId: string;
  readonly organizationId: string;
}): Effect.Effect<InvoicePdfPayment | null, DatabaseError, DatabaseService> {
  return withScope({ organizationId: target.organizationId }, (tx) =>
    query(() =>
      tx
        .select({
          paidOn: invoicePayments.paidOn,
          amountUsdc: invoicePayments.amountUsdc,
          originAsset: intentQuotes.originAsset,
          txHash: walletTransactions.txHash,
        })
        .from(invoicePayments)
        .leftJoin(
          intentQuotes,
          eq(intentQuotes.id, invoicePayments.intentQuoteId),
        )
        .leftJoin(
          walletTransactions,
          eq(walletTransactions.id, invoicePayments.walletTransactionId),
        )
        .where(
          and(
            eq(invoicePayments.invoiceId, target.invoiceId),
            eq(invoicePayments.organizationId, target.organizationId),
          ),
        )
        .orderBy(asc(invoicePayments.createdAt), asc(invoicePayments.id))
        .limit(1),
    ),
  ).pipe(
    Effect.map(([row]) =>
      row === undefined
        ? null
        : {
            paidOn: row.paidOn,
            amountUsdc: row.amountUsdc,
            chain:
              row.originAsset === null ? null : chainOfAsset(row.originAsset),
            txHash: row.txHash,
          },
    ),
  );
}

export function getInvoicePdfData(
  publicId: string,
): Effect.Effect<
  InvoicePdfData,
  NotFound | DatabaseError,
  DatabaseService | ConfigService
> {
  return Effect.gen(function* () {
    const invoice = yield* getPublicInvoice(publicId);
    const target = yield* findInvoiceByPublicId(publicId);
    const payment =
      invoice.status === "paid" && target !== null
        ? yield* readPayment(target)
        : null;
    const payUrl =
      invoice.status === "open"
        ? yield* payUrlFor(publicId).pipe(Effect.orElseSucceed(() => null))
        : null;
    return { invoice, payUrl, payment };
  });
}

/** `1600` as "16%", `825` as "8.25%". */
function percent(bps: number): string {
  return `${(bps / 100).toString()}%`;
}

/** Safe in a `filename="..."`: invoice numbers may hold `/`. */
export function invoicePdfFilename(number: string): string {
  return `${number.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`;
}

function stampOf(
  invoice: PublicInvoice,
): { label: string; color: string } | null {
  if (invoice.status === "paid") return { label: "PAID", color: PAID_GREEN };
  if (invoice.status === "void") return { label: "VOID", color: MUTED };
  return invoice.overdue ? { label: "OVERDUE", color: CORAL } : null;
}

export function renderInvoicePdf(
  data: InvoicePdfData,
  options: RenderOptions = {},
): Promise<Buffer> {
  const { invoice } = data;
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    compress: options.compress ?? true,
    font: FONT_REGULAR,
    info: { Title: `Invoice ${invoice.number}` },
  });
  doc.registerFont("Regular", FONT_REGULAR);
  doc.registerFont("SemiBold", FONT_SEMIBOLD);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const put = (
    text: string,
    x: number,
    y: number,
    style: {
      font?: "Regular" | "SemiBold";
      size?: number;
      color?: string;
      width?: number;
      align?: "left" | "center" | "right";
      link?: string;
    } = {},
  ): number => {
    options.onText?.(text);
    doc
      .font(style.font ?? "Regular")
      .fontSize(style.size ?? 10)
      .fillColor(style.color ?? INK);
    doc.text(text, x, y, {
      width: style.width ?? CONTENT_WIDTH,
      align: style.align ?? "left",
      link: style.link,
      underline: style.link !== undefined,
      lineBreak: true,
    });
    return doc.y;
  };

  const heightOf = (
    text: string,
    width: number,
    size: number,
    font: "Regular" | "SemiBold" = "Regular",
  ): number => doc.font(font).fontSize(size).heightOfString(text, { width });

  const ensureSpace = (y: number, needed: number): number => {
    if (y + needed <= BOTTOM) return y;
    doc.addPage();
    return PAGE_MARGIN;
  };

  doc.rect(0, 0, PAGE_WIDTH, 6).fill(CORAL);

  const markSize = 24;
  doc.image(BRAND_MARK, PAGE_MARGIN, PAGE_MARGIN, {
    width: markSize,
    height: markSize,
  });
  put("Expendi Business", PAGE_MARGIN + markSize + 8, PAGE_MARGIN + 4, {
    font: "SemiBold",
    size: 13,
  });

  let y = PAGE_MARGIN + markSize + 28;
  put("Invoice", PAGE_MARGIN, y, { font: "SemiBold", size: 28 });
  put(invoice.number, PAGE_MARGIN, y + 36, { size: 12, color: MUTED });

  const stamp = stampOf(invoice);
  if (stamp !== null) {
    const stampWidth = 110;
    const stampX = PAGE_WIDTH - PAGE_MARGIN - stampWidth;
    doc
      .roundedRect(stampX, y + 4, stampWidth, 34, 4)
      .lineWidth(1.5)
      .strokeColor(stamp.color)
      .stroke();
    put(stamp.label, stampX, y + 12, {
      font: "SemiBold",
      size: 16,
      color: stamp.color,
      width: stampWidth,
      align: "center",
    });
  }

  y += 80;
  const columnWidth = 150;
  const columns = [
    PAGE_MARGIN,
    PAGE_MARGIN + columnWidth + 24,
    PAGE_MARGIN + (columnWidth + 24) * 2,
  ] as const;

  const fromLines = [
    invoice.from.name,
    ...(invoice.from.kraPin === null ? [] : [`KRA PIN ${invoice.from.kraPin}`]),
  ];
  const billLines = [
    invoice.billTo.name,
    invoice.billTo.email,
    ...(invoice.billTo.address === null ? [] : [invoice.billTo.address]),
    ...(invoice.billTo.taxId === null
      ? []
      : [`Tax ID ${invoice.billTo.taxId}`]),
  ];

  put("FROM", columns[0], y, { font: "SemiBold", size: 8, color: MUTED });
  put("BILL TO", columns[1], y, { font: "SemiBold", size: 8, color: MUTED });
  put("DATES", columns[2], y, { font: "SemiBold", size: 8, color: MUTED });

  const partyTop = y + 16;
  let fromEnd = partyTop;
  fromLines.forEach((line, index) => {
    fromEnd = put(line, columns[0], fromEnd, {
      font: index === 0 ? "SemiBold" : "Regular",
      width: columnWidth,
      color: index === 0 ? INK : MUTED,
    });
  });
  let billEnd = partyTop;
  billLines.forEach((line, index) => {
    billEnd = put(line, columns[1], billEnd, {
      font: index === 0 ? "SemiBold" : "Regular",
      width: columnWidth,
      color: index === 0 ? INK : MUTED,
    });
  });
  const dateRows = [
    ["Issued", longDate(invoice.issueOn)],
    ["Due", longDate(invoice.dueOn)],
  ] as const;
  dateRows.forEach(([label, value], index) => {
    const rowY = partyTop + index * 16;
    put(label, columns[2], rowY, { color: MUTED, width: columnWidth });
    put(value, columns[2], rowY, { width: columnWidth, align: "right" });
  });
  const datesEnd = partyTop + dateRows.length * 16;

  y = Math.max(fromEnd, billEnd, datesEnd) + 36;

  const descriptionWidth = 235;
  const qtyX = PAGE_MARGIN + descriptionWidth + 10;
  const qtyWidth = 50;
  const priceX = qtyX + qtyWidth + 10;
  const priceWidth = 85;
  const amountX = priceX + priceWidth + 10;
  const amountWidth = PAGE_WIDTH - PAGE_MARGIN - amountX;

  const tableHeader = (top: number): number => {
    put("DESCRIPTION", PAGE_MARGIN, top, {
      font: "SemiBold",
      size: 8,
      color: MUTED,
      width: descriptionWidth,
    });
    put("QTY", qtyX, top, {
      font: "SemiBold",
      size: 8,
      color: MUTED,
      width: qtyWidth,
      align: "right",
    });
    put("UNIT PRICE (USD)", priceX, top, {
      font: "SemiBold",
      size: 8,
      color: MUTED,
      width: priceWidth,
      align: "right",
    });
    put("AMOUNT (USD)", amountX, top, {
      font: "SemiBold",
      size: 8,
      color: MUTED,
      width: amountWidth,
      align: "right",
    });
    const ruleY = top + 16;
    doc
      .moveTo(PAGE_MARGIN, ruleY)
      .lineTo(PAGE_WIDTH - PAGE_MARGIN, ruleY)
      .lineWidth(1)
      .strokeColor(INK)
      .stroke();
    return ruleY + 10;
  };

  y = tableHeader(y);
  for (const line of invoice.lines) {
    const rowHeight = heightOf(line.description, descriptionWidth, 10);
    if (y + rowHeight + 10 > BOTTOM) {
      doc.addPage();
      y = tableHeader(PAGE_MARGIN);
    }
    put(line.description, PAGE_MARGIN, y, { width: descriptionWidth });
    put(line.quantity, qtyX, y, { width: qtyWidth, align: "right" });
    put(dollars(BigInt(line.unitPriceCents)), priceX, y, {
      width: priceWidth,
      align: "right",
    });
    put(dollars(BigInt(line.amountCents)), amountX, y, {
      width: amountWidth,
      align: "right",
    });
    y += rowHeight + 10;
    doc
      .moveTo(PAGE_MARGIN, y - 4)
      .lineTo(PAGE_WIDTH - PAGE_MARGIN, y - 4)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
  }

  const totalsWidth = 220;
  const totalsX = PAGE_WIDTH - PAGE_MARGIN - totalsWidth;
  const totalRows: { label: string; value: string }[] = [
    { label: "Subtotal", value: `$${dollars(BigInt(invoice.subtotalCents))}` },
    ...(invoice.taxRateBps === null
      ? []
      : [
          {
            label: `${invoice.taxLabel} (${percent(invoice.taxRateBps)})`,
            value: `$${dollars(BigInt(invoice.taxCents))}`,
          },
        ]),
  ];
  y = ensureSpace(y + 10, totalRows.length * 18 + 40);
  for (const row of totalRows) {
    put(row.label, totalsX, y, { color: MUTED, width: totalsWidth });
    put(row.value, totalsX, y, { width: totalsWidth, align: "right" });
    y += 18;
  }
  doc
    .moveTo(totalsX, y + 2)
    .lineTo(PAGE_WIDTH - PAGE_MARGIN, y + 2)
    .lineWidth(1)
    .strokeColor(INK)
    .stroke();
  y += 10;
  put("Total", totalsX, y, { font: "SemiBold", size: 13, width: totalsWidth });
  put(`$${dollars(BigInt(invoice.totalCents))}`, totalsX, y, {
    font: "SemiBold",
    size: 13,
    width: totalsWidth,
    align: "right",
  });
  y += 40;

  if (invoice.note !== null && invoice.note.trim() !== "") {
    const note = invoice.note.trim();
    y = ensureSpace(y, 30 + heightOf(note, CONTENT_WIDTH, 10));
    put("NOTE", PAGE_MARGIN, y, { font: "SemiBold", size: 8, color: MUTED });
    y = put(note, PAGE_MARGIN, y + 14, { color: INK }) + 24;
  }

  if (invoice.status === "paid") {
    const { payment } = data;
    const details: { text: string; link?: string }[] = [];
    if (payment !== null) {
      details.push({ text: `Paid on ${longDate(payment.paidOn)}` });
      if (payment.amountUsdc !== null) {
        details.push({
          text: `Received ${formatUsdc(payment.amountUsdc)} USDC`,
        });
      }
      if (payment.chain !== null) {
        details.push({
          text: `Paid from ${FUND_IN_CHAIN_NAMES[payment.chain]}`,
        });
      }
      if (payment.txHash !== null) {
        details.push({
          text: `NEAR transaction ${payment.txHash}`,
          link: nearTransactionUrl(payment.txHash),
        });
      }
    }
    y = ensureSpace(y, 30 + details.length * 16);
    put("PAYMENT RECEIVED", PAGE_MARGIN, y, {
      font: "SemiBold",
      size: 8,
      color: PAID_GREEN,
    });
    y += 14;
    for (const detail of details) {
      y =
        put(detail.text, PAGE_MARGIN, y, { color: INK, link: detail.link }) + 4;
    }
  } else if (invoice.status === "open" && data.payUrl !== null) {
    y = ensureSpace(y, 50);
    put("PAY IN USDC", PAGE_MARGIN, y, {
      font: "SemiBold",
      size: 8,
      color: CORAL,
    });
    put(data.payUrl, PAGE_MARGIN, y + 14, {
      color: INK,
      link: data.payUrl,
    });
  }

  doc.end();
  return done;
}
