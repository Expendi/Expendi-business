import type {
  CompanyImportRequest,
  ImportField,
} from "@expendi-business/shared";
import { suggestImportMapping } from "@expendi-business/shared";

export type CompanyImportKind = CompanyImportRequest["kind"];
export const importFields: Record<
  CompanyImportKind,
  { field: ImportField; label: string; required?: boolean }[]
> = {
  history: [
    { field: "name", label: "Merchant / supplier", required: true },
    { field: "amount", label: "Amount in KES", required: true },
    { field: "date", label: "Date spent", required: true },
    { field: "category", label: "Category", required: true },
    { field: "description", label: "Description" },
    { field: "status", label: "Payment status (paid)" },
    { field: "mpesaCode", label: "M-Pesa transaction code" },
    { field: "heading", label: "Overview heading" },
  ],
  bill: [
    { field: "reference", label: "Invoice / payment reference" },
    { field: "payee", label: "Supplier / payee", required: true },
    { field: "amount", label: "Amount in KES", required: true },
    { field: "date", label: "Due date", required: true },
    { field: "category", label: "Category", required: true },
    { field: "description", label: "Description" },
    { field: "status", label: "Payment status (unpaid)" },
    { field: "heading", label: "Overview heading" },
  ],
};

export function suggestCompanyMapping(
  headers: string[],
  kind: CompanyImportKind,
): CompanyImportRequest["mapping"] {
  const shared = suggestImportMapping(headers, kind);
  const aliases: Partial<Record<ImportField, string[]>> = {
    name: ["merchant", "supplier", "supplier name", "vendor name"],
    payee: ["payee", "supplier", "supplier name", "vendor name"],
    amount: ["amount", "amount in kes", "amount kes", "value"],
    date:
      kind === "history"
        ? ["date", "date paid", "payment date", "spent on"]
        : ["due date", "due on"],
    category: ["category", "expense category"],
    description: ["description", "notes"],
    status: ["status", "payment status"],
    mpesaCode: ["mpesa code", "m-pesa code", "transaction code"],
    reference: ["reference", "invoice number", "invoice reference"],
  };
  const mapping: CompanyImportRequest["mapping"] = {};
  for (const { field } of importFields[kind]) {
    const header =
      shared[field] ??
      headers.find((h) => aliases[field]?.includes(h.toLowerCase()));
    if (header && !Object.values(mapping).includes(header))
      Object.assign(mapping, { [field]: header });
  }
  return mapping;
}

export function importTemplate(kind: CompanyImportKind): string {
  return kind === "history"
    ? "name,amount,date,category,description,status,reference\nExample supplier,1500.00,2026-06-15,Office supplies,Printer paper,paid,EXAMPLE-001\n"
    : "payee,amount,date,category,description,status,reference\nExample supplier,1500.00,2026-12-15,Office supplies,Printer paper,unpaid,EXAMPLE-001\n";
}
