import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import PDFDocument from "pdfkit";

import type {
  CashOutReceipt,
  CashOutReceiptKind,
  PayeeChain,
  PayoutMethod,
  WalletChain,
} from "@expendi-business/shared";
import {
  cashOutReceiptLabel,
  formatUsdCents,
  nearTransactionUrl,
  PAYEE_CHAIN_NAMES,
  payeeChainTransactionUrl,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { RenderOptions } from "../invoices/pdf-style.js";
import {
  bills,
  cardPurchases,
  cards,
  categories,
  expenses,
  organizations,
  payees,
  payouts,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, NotFound } from "../../errors.js";
import { dollars } from "../email/invoice-email.js";
import { formatUsdc } from "../email/invoice-receipt-email.js";
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
} from "../invoices/pdf-style.js";
import { cashOutReceiptsOf } from "../payout/receipts.js";
import { deliveryTransactionOf, describeRecipient } from "../wallet/history.js";

/**
 * The receipt of a bill paid through Expendi, for
 * `GET …/bills/:billId/payment-receipt`: who paid whom, what for, how much
 * left the wallet and the provider's own receipt codes, kept for the books.
 * Only a bill whose payout is `paid` has one, or a bill a Card purchase on a
 * company-held card paid: its USD, and the KES its spending row recorded.
 */

const billNotFound = new NotFound({ message: "That bill wasn't found." });

const paidOutside = new Conflict({
  message:
    "This bill wasn't paid through Expendi, so there's no payment receipt.",
});

const notPaidYet = new Conflict({
  message:
    "This bill's payment hasn't gone through yet, so there's no receipt.",
});

const cardPaymentUnrecorded = new Conflict({
  message:
    "This bill's card payment hasn't been recorded yet, so there's no receipt.",
});

export interface BillPaymentReceiptData {
  readonly receiptNumber: string;
  readonly companyName: string;
  readonly payeeName: string;
  /** The bill's invoice number or payment registration number. */
  readonly reference: string | null;
  readonly description: string | null;
  readonly categoryName: string;
  readonly amountKesCents: bigint;
  /** USDC base units that left the wallet; null if no ledger row records it. */
  readonly usdcSent: bigint | null;
  /** KES per USDC for a payout, per USD for a Card purchase. */
  readonly rate: string | null;
  /** How a payout sent it; null when a card paid. */
  readonly method: PayoutMethod | null;
  /** Where a payout sent it, masked as the wallet history masks it. */
  readonly recipientDetail: string | null;
  /** The company-held card whose Card purchase paid it, and how many US cents. */
  readonly card: {
    readonly lastFour: string;
    readonly amountUsdCents: bigint;
  } | null;
  readonly approvedAt: Date | null;
  readonly paidAt: Date | null;
  readonly providerReceipts: readonly CashOutReceipt[];
  readonly txHash: string | null;
  readonly txChain: WalletChain | null;
  /**
   * The payee chain's transaction, for a USDC payout delivered through NEAR
   * Intents that left no transaction of the company's own (a confidential
   * account). Only set when `txHash` is null.
   */
  readonly deliveryTxHash: string | null;
  readonly deliveryTxChain: PayeeChain | null;
}

/**
 * Short, stable and readable aloud: the first 8 hex digits of the payout,
 * or of the Card purchase, that paid it.
 */
export function receiptNumberOf(paymentId: string): string {
  return `RCT-${paymentId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

export function getBillPaymentReceiptData(
  tenant: Tenant,
  billId: string,
): Effect.Effect<
  BillPaymentReceiptData,
  NotFound | Conflict | DatabaseError,
  DatabaseService
> {
  const { organizationId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const [row] = yield* query(() =>
        tx
          .select({
            status: bills.status,
            payoutId: bills.payoutId,
            cardPurchaseId: bills.cardPurchaseId,
            paidAt: bills.paidAt,
            reference: bills.reference,
            notes: bills.notes,
            payeeName: payees.name,
            categoryName: categories.name,
            companyName: organizations.name,
          })
          .from(bills)
          .innerJoin(payees, eq(payees.id, bills.payeeId))
          .innerJoin(categories, eq(categories.id, bills.categoryId))
          .innerJoin(organizations, eq(organizations.id, bills.organizationId))
          .where(
            and(eq(bills.organizationId, organizationId), eq(bills.id, billId)),
          )
          .limit(1),
      );
      if (!row) return yield* Effect.fail(billNotFound);
      const { cardPurchaseId } = row;
      if (row.status === "paid_by_card" && cardPurchaseId !== null) {
        const [paid] = yield* query(() =>
          tx
            .select({
              settledUsdCents: cardPurchases.settledUsdCents,
              rate: cardPurchases.usdKesRate,
              lastFour: cards.lastFour,
              amountKes: expenses.amountKes,
            })
            .from(cardPurchases)
            .innerJoin(cards, eq(cards.id, cardPurchases.cardId))
            .innerJoin(
              expenses,
              and(
                eq(expenses.organizationId, cardPurchases.organizationId),
                eq(expenses.billId, billId),
              ),
            )
            .where(
              and(
                eq(cardPurchases.organizationId, organizationId),
                eq(cardPurchases.id, cardPurchaseId),
              ),
            )
            .limit(1),
        );
        if (!paid) return yield* Effect.fail(cardPaymentUnrecorded);
        return {
          receiptNumber: receiptNumberOf(cardPurchaseId),
          companyName: row.companyName,
          payeeName: row.payeeName,
          reference: row.reference,
          description: row.notes,
          categoryName: row.categoryName,
          amountKesCents: paid.amountKes,
          usdcSent: null,
          rate: paid.rate,
          method: null,
          recipientDetail: null,
          card: {
            lastFour: paid.lastFour,
            amountUsdCents: paid.settledUsdCents,
          },
          approvedAt: null,
          paidAt: row.paidAt,
          providerReceipts: [],
          txHash: null,
          txChain: null,
          deliveryTxHash: null,
          deliveryTxChain: null,
        };
      }
      if (row.payoutId === null) return yield* Effect.fail(paidOutside);
      const payoutId = row.payoutId;

      const [payout] = yield* query(() =>
        tx
          .select()
          .from(payouts)
          .where(
            and(
              eq(payouts.organizationId, organizationId),
              eq(payouts.id, payoutId),
            ),
          ),
      );
      if (!payout) return yield* Effect.fail(paidOutside);
      if (payout.status !== "paid") return yield* Effect.fail(notPaidYet);

      const [ledger] = yield* query(() =>
        tx
          .select({
            usdcAmount: walletTransactions.usdcAmount,
            txHash: walletTransactions.txHash,
            chain: walletTransactions.chain,
          })
          .from(walletTransactions)
          .where(
            and(
              eq(walletTransactions.organizationId, organizationId),
              eq(walletTransactions.payoutId, payoutId),
              eq(walletTransactions.type, "payout"),
            ),
          )
          .orderBy(
            asc(walletTransactions.createdAt),
            asc(walletTransactions.id),
          )
          .limit(1),
      );
      const txHash = ledger?.txHash ?? payout.txHash;
      const delivery = txHash === null ? deliveryTransactionOf(payout) : null;

      return {
        receiptNumber: receiptNumberOf(payout.id),
        companyName: row.companyName,
        payeeName: payout.recipient.accountName,
        reference: row.reference,
        description: row.notes,
        categoryName: row.categoryName,
        amountKesCents: payout.amountKes,
        usdcSent: ledger ? -ledger.usdcAmount : null,
        rate: payout.rate,
        method: payout.method,
        recipientDetail: describeRecipient(payout.recipient),
        card: null,
        approvedAt: payout.approvedAt,
        paidAt: payout.paidAt,
        providerReceipts: cashOutReceiptsOf([payout]),
        txHash,
        txChain: txHash === null ? null : (ledger?.chain ?? null),
        deliveryTxHash: delivery?.txHash ?? null,
        deliveryTxChain: delivery?.chain ?? null,
      };
    }),
  );
}

export function billPaymentReceiptFilename(receiptNumber: string): string {
  return `payment-receipt-${receiptNumber}.pdf`;
}

const METHOD_NAMES: Readonly<Record<PayoutMethod, string>> = {
  mpesa_phone: "M-Pesa to a phone number",
  mpesa_till: "M-Pesa Till",
  mpesa_paybill: "M-Pesa Paybill",
  bank: "Bank transfer",
  usdc: "USDC transfer",
};

/** "13 Nov 2026, 7:30 AM" in Nairobi, whatever the server's zone. */
export function nairobiDateTime(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")} ${part("dayPeriod").toUpperCase()}`;
}

const linkOf = (url: string | null): { link?: string } =>
  url === null ? {} : { link: url };

/** One line per kind, e.g. "M-Pesa receipt: UKDCW299LW". */
function receiptRows(
  receipts: readonly CashOutReceipt[],
): { label: string; value: string }[] {
  const kinds = [...new Set(receipts.map((receipt) => receipt.kind))];
  return kinds.map((kind: CashOutReceiptKind) => {
    const codes = receipts
      .filter((receipt) => receipt.kind === kind)
      .map((receipt) => receipt.code);
    return {
      label: cashOutReceiptLabel(kind, codes.length),
      value: codes.join(", "),
    };
  });
}

export function renderBillPaymentReceiptPdf(
  data: BillPaymentReceiptData,
  options: RenderOptions = {},
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    compress: options.compress ?? true,
    font: FONT_REGULAR,
    // Dated by the payment, not by the download, so the same receipt is
    // the same file every time.
    info: {
      Title: `Payment receipt ${data.receiptNumber}`,
      CreationDate: data.paidAt ?? data.approvedAt ?? new Date(0),
    },
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
  put("Payment receipt", PAGE_MARGIN, y, { font: "SemiBold", size: 28 });
  put(data.receiptNumber, PAGE_MARGIN, y + 36, { size: 12, color: MUTED });
  put(data.companyName, PAGE_MARGIN, y + 56, {
    font: "SemiBold",
    size: 12,
    width: CONTENT_WIDTH - 130,
  });

  const stampWidth = 110;
  const stampX = PAGE_WIDTH - PAGE_MARGIN - stampWidth;
  doc
    .roundedRect(stampX, y + 4, stampWidth, 34, 4)
    .lineWidth(1.5)
    .strokeColor(PAID_GREEN)
    .stroke();
  put("PAID", stampX, y + 12, {
    font: "SemiBold",
    size: 16,
    color: PAID_GREEN,
    width: stampWidth,
    align: "center",
  });

  y += 96;

  const labelWidth = 130;
  const valueX = PAGE_MARGIN + labelWidth + 16;
  const valueWidth = PAGE_WIDTH - PAGE_MARGIN - valueX;

  const rows: { label: string; value: string; link?: string }[] = [
    { label: "Paid to", value: data.payeeName },
    ...(data.reference === null || data.reference === ""
      ? []
      : [{ label: "Reference", value: data.reference }]),
    ...(data.description === null || data.description.trim() === ""
      ? []
      : [{ label: "Description", value: data.description.trim() }]),
    { label: "Category", value: data.categoryName },
    {
      label: "Amount",
      value: `KES ${dollars(data.amountKesCents)}`,
    },
    ...(data.card === null
      ? []
      : [
          { label: "Charged", value: formatUsdCents(data.card.amountUsdCents) },
        ]),
    ...(data.usdcSent === null
      ? []
      : [
          {
            label: "USDC sent",
            value: `${formatUsdc(data.usdcSent)} USDC`,
          },
        ]),
    ...(data.rate === null
      ? []
      : [
          {
            label: "Rate",
            value: `KES ${data.rate} per ${data.card === null ? "USDC" : "USD"}`,
          },
        ]),
    ...(data.recipientDetail === null
      ? []
      : [{ label: "Sent to", value: data.recipientDetail }]),
    ...(data.method === null
      ? []
      : [{ label: "Method", value: METHOD_NAMES[data.method] }]),
    ...(data.card === null
      ? []
      : [
          {
            label: "Paid by",
            value: `Expendi card •••• ${data.card.lastFour}`,
          },
        ]),
    ...(data.approvedAt === null
      ? []
      : [{ label: "Approved", value: nairobiDateTime(data.approvedAt) }]),
    ...(data.paidAt === null
      ? []
      : [{ label: "Paid", value: nairobiDateTime(data.paidAt) }]),
    ...receiptRows(data.providerReceipts),
    ...(data.txHash === null
      ? []
      : [
          {
            label: "Transaction",
            value: data.txHash,
            ...(data.txChain === "near"
              ? { link: nearTransactionUrl(data.txHash) }
              : {}),
          },
        ]),
    ...(data.deliveryTxHash === null || data.deliveryTxChain === null
      ? []
      : [
          {
            label: `${PAYEE_CHAIN_NAMES[data.deliveryTxChain]} transaction`,
            value: data.deliveryTxHash,
            ...linkOf(
              payeeChainTransactionUrl(
                data.deliveryTxChain,
                data.deliveryTxHash,
              ),
            ),
          },
        ]),
  ];

  doc
    .moveTo(PAGE_MARGIN, y - 10)
    .lineTo(PAGE_WIDTH - PAGE_MARGIN, y - 10)
    .lineWidth(1)
    .strokeColor(INK)
    .stroke();

  for (const row of rows) {
    const height = doc
      .font("Regular")
      .fontSize(10)
      .heightOfString(row.value, { width: valueWidth });
    if (y + height + 14 > BOTTOM) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
    put(row.label, PAGE_MARGIN, y, { color: MUTED, width: labelWidth });
    put(row.value, valueX, y, { width: valueWidth, link: row.link });
    y += height + 14;
    doc
      .moveTo(PAGE_MARGIN, y - 7)
      .lineTo(PAGE_WIDTH - PAGE_MARGIN, y - 7)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
  }

  if (y + 40 > BOTTOM) {
    doc.addPage();
    y = PAGE_MARGIN;
  }
  put("Paid through Expendi Business.", PAGE_MARGIN, y + 16, {
    size: 9,
    color: MUTED,
  });

  doc.end();
  return done;
}
