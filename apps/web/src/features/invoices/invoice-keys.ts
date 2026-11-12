/** The list's status filter: "overdue" is an open invoice past its due date. */
export const INVOICE_FILTERS = [
  "draft",
  "open",
  "overdue",
  "paid",
  "void",
] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];

export function invoiceFilterOf(value: string | null): InvoiceFilter | null {
  return INVOICE_FILTERS.find((filter) => filter === value) ?? null;
}

export const invoiceKeys = {
  /** Every invoice query of a company, to refresh after an invoice changes. */
  all: (organizationId: string) => ["invoices", organizationId] as const,
  list: (organizationId: string, status: InvoiceFilter | null) =>
    ["invoices", organizationId, "list", status] as const,
  detail: (organizationId: string, invoiceId: string) =>
    ["invoices", organizationId, "detail", invoiceId] as const,
  nextNumber: (organizationId: string) =>
    ["invoices", organizationId, "next-number"] as const,
  deposits: (organizationId: string, invoiceId: string) =>
    ["invoices", organizationId, "deposits", invoiceId] as const,
};

export const customerKeys = {
  all: (organizationId: string) => ["customers", organizationId] as const,
  list: (organizationId: string, includeArchived: boolean) =>
    ["customers", organizationId, "list", includeArchived] as const,
};
