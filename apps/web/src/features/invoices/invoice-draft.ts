import type {
  Invoice,
  InvoiceDraftRequest,
  InvoiceTerms,
} from "@expendi-business/shared";
import {
  DEFAULT_INVOICE_TERMS,
  dueOnFor,
  invoiceDraftInputSchema,
} from "@expendi-business/shared";

import {
  bpsToPercent,
  centsToDollars,
  dollarsToCents,
  percentToBps,
} from "./invoice-money";

export interface LineDraft {
  /** Identifies the row while it is edited; never sent. */
  readonly key: string;
  readonly description: string;
  readonly quantity: string;
  /** Dollars as typed. */
  readonly unitPrice: string;
}

export interface InvoiceDraft {
  readonly customerId: string | null;
  /** Null until the person edits it: the form then shows the suggested number. */
  readonly number: string | null;
  readonly issueOn: string;
  readonly terms: InvoiceTerms;
  readonly dueOn: string;
  readonly lines: readonly LineDraft[];
  /** Percent as typed; blank for no tax. */
  readonly taxRate: string;
  readonly taxLabel: string;
  readonly note: string;
}

export const DEFAULT_TAX_LABEL = "VAT";

let lineCounter = 0;

export function blankLine(): LineDraft {
  lineCounter += 1;
  return {
    key: `line-${String(lineCounter)}`,
    description: "",
    quantity: "1",
    unitPrice: "",
  };
}

export function blankDraft(today: string): InvoiceDraft {
  return {
    customerId: null,
    number: null,
    issueOn: today,
    terms: DEFAULT_INVOICE_TERMS,
    dueOn: "",
    lines: [blankLine()],
    taxRate: "",
    taxLabel: DEFAULT_TAX_LABEL,
    note: "",
  };
}

export function draftFromInvoice(invoice: Invoice): InvoiceDraft {
  return {
    customerId: invoice.customerId,
    number: invoice.number,
    issueOn: invoice.issueOn,
    terms: invoice.terms,
    dueOn: invoice.terms === "custom" ? invoice.dueOn : "",
    lines: invoice.lines.map((line) => ({
      ...blankLine(),
      description: line.description,
      quantity: line.quantity,
      unitPrice: centsToDollars(line.unitPriceCents),
    })),
    taxRate:
      invoice.taxRateBps === null ? "" : bpsToPercent(invoice.taxRateBps),
    taxLabel: invoice.taxLabel,
    note: invoice.note ?? "",
  };
}

export type DraftField =
  | "customer"
  | "number"
  | "issueOn"
  | "terms"
  | "dueOn"
  | "taxRate"
  | "taxLabel"
  | "note";

export interface DraftErrors {
  readonly fields: Partial<Record<DraftField, string>>;
  /** The first problem of each line, by its key. */
  readonly lines: Readonly<Record<string, string>>;
  /** Problems with the lines as a whole, e.g. none added. */
  readonly linesSummary?: string;
  readonly form?: string;
}

export type DraftResult =
  | { readonly ok: true; readonly request: InvoiceDraftRequest }
  | { readonly ok: false; readonly errors: DraftErrors };

const FIELD_OF_KEY: Readonly<Record<string, DraftField>> = {
  customerId: "customer",
  number: "number",
  issueOn: "issueOn",
  terms: "terms",
  dueOn: "dueOn",
  taxRateBps: "taxRate",
  taxLabel: "taxLabel",
  note: "note",
};

const PRICE_MESSAGE = "Enter the unit price in dollars, like 120 or 49.99.";
const RATE_MESSAGE = "Enter a rate between 0 and 100, like 16 or 7.5.";

/**
 * The draft as the API takes it, checked against the shared schema; or
 * every problem found, per field and per line. `number` is what the form
 * shows (an untouched draft shows the suggestion).
 */
export function toDraftRequest(
  draft: InvoiceDraft,
  number: string,
): DraftResult {
  const localLines: Record<string, string> = {};
  const lines = draft.lines.map((line) => {
    const cents = dollarsToCents(line.unitPrice);
    if (cents === null) localLines[line.key] = PRICE_MESSAGE;
    return {
      description: line.description,
      quantity: line.quantity.trim(),
      unitPriceCents: cents ?? "",
    };
  });

  const fields: Partial<Record<DraftField, string>> = {};
  const rateText = draft.taxRate.trim();
  const bps = rateText === "" ? null : percentToBps(rateText);
  if (rateText !== "" && bps === null) fields.taxRate = RATE_MESSAGE;
  const taxed = bps !== null && bps > 0;
  const note = draft.note.trim();

  const request: InvoiceDraftRequest = {
    customerId: draft.customerId ?? "",
    number,
    issueOn: draft.issueOn,
    terms: draft.terms,
    ...(draft.terms === "custom" && draft.dueOn !== ""
      ? { dueOn: draft.dueOn }
      : {}),
    lines,
    ...(taxed ? { taxRateBps: bps, taxLabel: draft.taxLabel } : {}),
    ...(note === "" ? {} : { note }),
  };

  const parsed = invoiceDraftInputSchema.safeParse(request);
  const lineErrors: Record<string, string> = { ...localLines };
  let linesSummary: string | undefined;
  let form: string | undefined;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [head, index, ...rest] = issue.path;
      if (head === "lines" && typeof index === "number" && rest.length > 0) {
        const key = draft.lines[index]?.key;
        if (key !== undefined) lineErrors[key] ??= issue.message;
      } else if (head === "lines") {
        linesSummary ??= issue.message;
      } else {
        const field = typeof head === "string" ? FIELD_OF_KEY[head] : undefined;
        if (field) fields[field] ??= issue.message;
        else form ??= issue.message;
      }
    }
  }

  const failed =
    !parsed.success ||
    Object.keys(lineErrors).length > 0 ||
    Object.keys(fields).length > 0;
  if (!failed) return { ok: true, request };
  return {
    ok: false,
    errors: { fields, lines: lineErrors, linesSummary, form },
  };
}

/** The due date the terms give, or null while a custom date isn't chosen. */
export function dueDateOf(draft: InvoiceDraft): string | null {
  if (draft.issueOn === "") return null;
  if (draft.terms === "custom") return draft.dueOn === "" ? null : draft.dueOn;
  return dueOnFor(draft.issueOn, draft.terms);
}
