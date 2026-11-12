import type { QueryClient } from "@tanstack/react-query";

import type {
  Customer,
  Invoice,
  InvoicePayment,
  InvoiceSummary,
} from "@expendi-business/shared";

import type { InvoiceFilter } from "~/features/invoices/invoice-keys";
import {
  customerKeys,
  INVOICE_FILTERS,
  invoiceKeys,
} from "~/features/invoices/invoice-keys";
import {
  computeTotals,
  dollarsToCents,
} from "~/features/invoices/invoice-money";
import { COMPANY_NAME, ORGANIZATION_ID, sampleId } from "./company";

function customer(
  n: number,
  name: string,
  email: string,
  taxId: string | null,
  archived = false,
): Customer {
  return {
    id: sampleId(n),
    name,
    email,
    address: `${name}\nP.O. Box ${String(n)}-00100\nNairobi`,
    taxId,
    archived,
    createdAt: "2026-09-01T08:00:00.000Z",
  };
}

const ACME = customer(
  9701,
  "Acme Freight Ltd",
  "accounts@acmefreight.co.ke",
  "P051234567X",
);
const SAVANNA = customer(9702, "Savanna Foods", "ap@savannafoods.com", null);
const LAKEVIEW = customer(
  9703,
  "Lakeview Hotels",
  "finance@lakeview.co.ke",
  "P059876543K",
);
const MOMBASA = customer(
  9704,
  "Old Mombasa Traders",
  "info@oldmombasa.co.ke",
  null,
  true,
);

export const CUSTOMERS: readonly Customer[] = [
  ACME,
  SAVANNA,
  LAKEVIEW,
  MOMBASA,
];

interface SampleLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
}

function invoice(
  n: number,
  number: string,
  who: Customer,
  status: Invoice["status"],
  options: {
    readonly issueOn: string;
    readonly dueOn: string;
    readonly terms?: Invoice["terms"];
    readonly lines: readonly SampleLine[];
    readonly taxRateBps?: number;
    readonly sentAt?: string;
    readonly paidAt?: string;
    readonly overdue?: boolean;
    readonly voidedReason?: string;
    readonly payments?: readonly InvoicePayment[];
    readonly note?: string;
  },
): Invoice {
  const priced = options.lines.map((line) => ({
    quantity: line.quantity,
    unitPriceCents: dollarsToCents(line.unitPrice),
  }));
  const totals = computeTotals(priced, options.taxRateBps ?? null);
  const sent = status !== "draft";
  return {
    id: sampleId(n),
    number,
    customerName: who.name,
    status,
    overdue: options.overdue ?? false,
    totalCents: totals.totalCents,
    issueOn: options.issueOn,
    dueOn: options.dueOn,
    sentAt: sent
      ? (options.sentAt ?? `${options.issueOn}T08:00:00.000Z`)
      : null,
    paidAt: options.paidAt ?? null,
    customerId: who.id,
    billTo: {
      name: who.name,
      email: who.email,
      address: who.address,
      taxId: who.taxId,
    },
    from: { name: COMPANY_NAME, kraPin: "P051122334Q" },
    terms: options.terms ?? "net_30",
    lines: options.lines.map((line, index) => ({
      id: sampleId(n * 10 + index),
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: priced[index]?.unitPriceCents ?? "0",
      amountCents: totals.lineCents[index] ?? "0",
    })),
    subtotalCents: totals.subtotalCents,
    taxRateBps: options.taxRateBps ?? null,
    taxLabel: "VAT",
    taxCents: totals.taxCents,
    note: options.note ?? null,
    publicId: sent ? `sample-pay-link-${String(n)}` : null,
    voidedReason: options.voidedReason ?? null,
    payments: [...(options.payments ?? [])],
  };
}

export const INVOICES: readonly Invoice[] = [
  invoice(9801, "INV-0005", LAKEVIEW, "draft", {
    issueOn: "2026-11-06",
    dueOn: "2026-12-06",
    lines: [
      {
        description: "November dispatch software",
        quantity: "1",
        unitPrice: "850",
      },
    ],
  }),
  invoice(9802, "INV-0004", ACME, "open", {
    issueOn: "2026-10-01",
    dueOn: "2026-10-31",
    overdue: true,
    taxRateBps: 1600,
    lines: [
      {
        description: "Route optimisation audit",
        quantity: "12.5",
        unitPrice: "120",
      },
      {
        description: "Driver training workshop",
        quantity: "2",
        unitPrice: "450",
      },
    ],
    note: "Pay in USDC from the link. Thank you.",
  }),
  invoice(9803, "INV-0003", SAVANNA, "open", {
    issueOn: "2026-10-28",
    dueOn: "2026-11-27",
    lines: [
      {
        description: "Cold-chain consulting",
        quantity: "8",
        unitPrice: "95.50",
      },
    ],
  }),
  invoice(9804, "INV-0002", ACME, "paid", {
    issueOn: "2026-09-15",
    dueOn: "2026-10-15",
    paidAt: "2026-10-09T10:30:00.000Z",
    lines: [
      {
        description: "Fleet tracking set-up",
        quantity: "1",
        unitPrice: "2400",
      },
    ],
    payments: [
      {
        id: sampleId(9901),
        kind: "link",
        amountUsdc: "2400000000",
        paidOn: "2026-10-09",
        reference: null,
        note: null,
        txHash:
          "0x4f2a9c1d7be35e60a1f98c2d3b7a6e5410f9d8c7b6a5e4d3c2b1a09f8e7d6c5b",
        chain: "base",
        walletTransactionId: null,
        recordedAt: "2026-10-09T10:30:00.000Z",
      },
    ],
  }),
  invoice(9805, "INV-0001", SAVANNA, "paid", {
    issueOn: "2026-09-01",
    dueOn: "2026-09-30",
    paidAt: "2026-09-25T09:00:00.000Z",
    lines: [
      { description: "Pilot programme", quantity: "1", unitPrice: "1200" },
    ],
    payments: [
      {
        id: sampleId(9902),
        kind: "outside",
        amountUsdc: null,
        paidOn: "2026-09-25",
        reference: "KCB-88213",
        note: "Bank transfer",
        txHash: null,
        chain: null,
        walletTransactionId: null,
        recordedAt: "2026-09-25T09:00:00.000Z",
      },
    ],
  }),
  invoice(9806, "INV-0000", MOMBASA, "void", {
    issueOn: "2026-08-20",
    dueOn: "2026-09-19",
    voidedReason: "Issued to the wrong entity",
    lines: [{ description: "Sample invoice", quantity: "1", unitPrice: "300" }],
  }),
];

function summaryOf(full: Invoice): InvoiceSummary {
  return {
    id: full.id,
    number: full.number,
    customerName: full.customerName,
    status: full.status,
    overdue: full.overdue,
    totalCents: full.totalCents,
    issueOn: full.issueOn,
    dueOn: full.dueOn,
    sentAt: full.sentAt,
    paidAt: full.paidAt,
  };
}

function matches(full: Invoice, filter: InvoiceFilter | null): boolean {
  if (filter === null) return true;
  if (filter === "overdue") return full.overdue;
  return full.status === filter;
}

/** The dev preview's invoices and customers, under the keys the page reads. */
export function seedInvoices(client: QueryClient): void {
  const org = ORGANIZATION_ID;
  for (const filter of [null, ...INVOICE_FILTERS]) {
    client.setQueryData(
      invoiceKeys.list(org, filter),
      INVOICES.filter((full) => matches(full, filter)).map(summaryOf),
    );
  }
  for (const full of INVOICES) {
    client.setQueryData(invoiceKeys.detail(org, full.id), full);
  }
  client.setQueryData(invoiceKeys.nextNumber(org), "INV-0006");
  client.setQueryData(customerKeys.list(org, true), [...CUSTOMERS]);
}

export function sampleInvoice(number: string): Invoice {
  const found = INVOICES.find((candidate) => candidate.number === number);
  if (!found) throw new Error(`No sample invoice ${number}`);
  return found;
}
