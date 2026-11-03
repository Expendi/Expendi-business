"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import type {
  ImportField,
  ImportReport,
  ImportRequest,
} from "@expendi-business/shared";
import {
  IMPORT_KINDS,
  IMPORT_MAX_BYTES,
  parseImportSpreadsheet,
  suggestImportMapping,
} from "@expendi-business/shared";

import { PageError, PageLoading } from "~/components/page-state";
import {
  cellClass,
  headCellClass,
  inputClass,
  linkClass,
  primaryButton,
  secondaryButton,
  tableClass,
} from "~/components/styles";
import { NativeSelect } from "~/components/ui/native-select";
import { Table } from "~/components/ui/table";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";

const fields: Record<ImportRequest["kind"], ImportField[]> = {
  payee: ["name", "payeeKind", "email"],
  salary: ["payee", "category", "amount", "date", "scheduleDay"],
  recurring: [
    "payee",
    "category",
    "heading",
    "amount",
    "date",
    "schedule",
    "scheduleDay",
    "payVia",
  ],
  bill: [
    "payee",
    "category",
    "heading",
    "amount",
    "date",
    "description",
    "status",
    "reference",
  ],
  claim: [
    "status",
    "name",
    "email",
    "category",
    "heading",
    "amount",
    "date",
    "description",
    "mpesaCode",
  ],
  history: [
    "status",
    "name",
    "email",
    "category",
    "heading",
    "amount",
    "date",
    "description",
    "mpesaCode",
  ],
  float: ["email", "issued", "left", "date"],
};
const labels: Record<ImportField, string> = {
  name: "Name / merchant",
  email: "Member email",
  payeeKind: "Payee kind (default: supplier)",
  payee: "Existing payee name",
  category: "Existing category name",
  heading: "Overview heading (default: transactions)",
  amount: "Amount in KES",
  date: "Spent / opening / next due date",
  description: "Description (optional)",
  mpesaCode: "M-Pesa code (optional)",
  schedule: "Schedule (default: monthly)",
  scheduleDay: "Pay day / schedule day",
  payVia: "Pay via (default: expendi)",
  issued: "Total float issued in KES",
  left: "Float balance left in KES",
  status: "Payment status (paid / unpaid)",
  reference: "Bill reference (optional)",
};

function suggestedMapping(headers: string[], kind: ImportRequest["kind"]) {
  const suggestions = suggestImportMapping(headers, kind);
  return Object.fromEntries(
    fields[kind].flatMap((field) =>
      suggestions[field] ? [[field, suggestions[field]]] : [],
    ),
  );
}

export function ImportView({ companyId }: { companyId: string }) {
  const { api, staff } = useStaffAuth();
  const queryClient = useQueryClient();
  const company = useQuery({
    queryKey: queryKeys.company(companyId),
    queryFn: () => api.ops.company(companyId),
  });
  const [kind, setKind] = useState<ImportRequest["kind"]>("payee");
  const [layout, setLayout] = useState<"standard" | "shanga">("standard");
  const [file, setFile] = useState<{
    name: string;
    csv: string;
    headers: string[];
    ignored: number;
    rows: number;
  } | null>(null);
  const [mapping, setMapping] = useState<ImportRequest["mapping"]>({});
  const [preview, setPreview] = useState<{
    input: ImportRequest;
    report: ImportReport;
  } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const resetPreview = () => {
    setPreview(null);
    setReviewed(false);
    setDone(null);
    setError(null);
  };

  async function loadFile(selected: File | undefined) {
    resetPreview();
    setFile(null);
    setMapping({});
    if (!selected) return;
    setBusy(true);
    try {
      if (selected.size > IMPORT_MAX_BYTES)
        throw new Error("Use a CSV or TSV smaller than 512 KB.");
      if (!/\.(csv|tsv)$/i.test(selected.name))
        throw new Error(
          "Export one Excel sheet as UTF-8 CSV or TSV, then upload it here.",
        );
      let csv: string;
      try {
        csv = new TextDecoder("utf-8", { fatal: true }).decode(
          await selected.arrayBuffer(),
        );
      } catch {
        throw new Error(
          "Export this file as UTF-8 CSV or TSV, then try again.",
        );
      }
      const { headers, ignored, rows } = parseImportSpreadsheet(csv, layout);
      setFile({
        name: selected.name,
        csv,
        headers,
        ignored: ignored.length,
        rows: rows.length,
      });
      setMapping(suggestedMapping(headers, kind));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read this file.");
    } finally {
      setBusy(false);
    }
  }
  async function dryRun() {
    if (!file) return;
    resetPreview();
    setBusy(true);
    const input: ImportRequest = {
      kind,
      csv: file.csv,
      fileName: file.name,
      mapping,
      layout,
    };
    try {
      setPreview({
        input,
        report: await api.imports.preview(companyId, input),
      });
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview?.report.previewToken || !reviewed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.imports.commit(
        companyId,
        preview.input,
        preview.report.previewToken,
      );
      setDone(
        `Imported ${result.imported} rows; skipped ${result.skipped}. Run ${result.runId}.`,
      );
      setPreview(null);
      setReviewed(false);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.company(companyId),
      });
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setBusy(false);
    }
  }
  if (staff?.role !== "ops_admin")
    return <p>Only ops admins can import spreadsheets.</p>;
  if (company.isPending) return <PageLoading label="Loading company…" />;
  if (company.isError)
    return <PageError>{describeApiError(company.error)}</PageError>;
  return (
    <section className="max-w-5xl space-y-6">
      <header>
        <Link href={`/companies/${companyId}`} className={linkClass}>
          {company.data.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Import spreadsheet
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-stone-600">
          Upload one UTF-8 CSV or TSV per record type, up to 500 non-empty rows.
          Invite members and create categories first, then import payees before
          salaries and bills. Dates use DD/MM/YYYY or YYYY-MM-DD; amounts use
          KES, such as 1,500.00.
        </p>
        <p className="mt-2 max-w-2xl text-sm text-stone-600">
          Payment details remain unset until a company admin adds and confirms
          them. History supports earlier financial periods. Float totals are
          opening balances; import individual historic purchases separately as
          history.
        </p>
      </header>
      <fieldset
        disabled={busy}
        className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
      >
        <legend className="px-2 font-semibold">
          1. Choose records and file
        </legend>
        <label className="block max-w-sm text-sm">
          Spreadsheet layout
          <NativeSelect
            className="mt-2 w-full"
            value={layout}
            onChange={(e) => {
              const next = e.target.value === "shanga" ? "shanga" : "standard";
              setLayout(next);
              setFile(null);
              setMapping({});
              if (next === "shanga") setKind("history");
              resetPreview();
            }}
          >
            <option value="standard">Standard spreadsheet</option>
            <option value="shanga">Shanga expense sheets</option>
          </NativeSelect>
        </label>
        {layout === "shanga" ? (
          <div className="max-w-2xl space-y-2 text-sm text-stone-600">
            <p>
              Repeated headings and summary-only cells outside named columns are
              skipped. Money In is income and cannot be imported here.
            </p>
            <p>
              Split paid and unpaid records first. The source Status column must
              say paid for history, or unpaid for bills and claims. Confirm that
              unpaid purchases are supplier bills or employee reimbursements.
            </p>
            <p>
              Add a Member Email column for claims/history; Purchased By names
              cannot identify memberships. For bills, add the actual Due Date.
              Where Cost and Total both exist, choose the final KES transaction
              amount explicitly.
            </p>
            <p>
              Receipt flags and Drive links do not upload receipts. Personnel
              expenses are not salary schedules, and past subscription payments
              are not recurring instructions. Review the dates and totals for
              the financial period being imported.
            </p>
          </div>
        ) : null}
        <label className="block max-w-sm text-sm">
          Record type
          <NativeSelect
            className="mt-2 w-full"
            value={kind}
            onChange={(e) => {
              const selected = IMPORT_KINDS.find((k) => k === e.target.value);
              if (selected) {
                setKind(selected);
                setMapping(
                  file ? suggestedMapping(file.headers, selected) : {},
                );
                resetPreview();
              }
            }}
          >
            {IMPORT_KINDS.filter(
              (k) =>
                layout !== "shanga" || ["history", "bill", "claim"].includes(k),
            ).map((k) => (
              <option key={k} value={k}>
                {k === "history"
                  ? "Paid history"
                  : k === "claim"
                    ? "Unpaid claims"
                    : k === "float"
                      ? "Open floats"
                      : k}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="block text-sm">
          CSV or TSV file
          <input
            type="file"
            key={layout}
            accept=".csv,.tsv,text/csv,text/tab-separated-values"
            className={`${inputClass} max-w-md`}
            onChange={(e) => {
              void loadFile(e.target.files?.[0]);
            }}
          />
        </label>
        {file ? (
          <div>
            <p className="mb-4 text-sm">
              {file.rows} data rows · {file.ignored} template/summary rows
              skipped. Check the suggested mappings before previewing.
            </p>
            <h2 className="mb-4 font-semibold">2. Map columns</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {fields[kind].map((field) => (
                <label key={field} className="text-sm">
                  {labels[field]}
                  <NativeSelect
                    className="mt-2 w-full"
                    disabled={layout === "shanga" && field === "status"}
                    value={mapping[field] ?? ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      setMapping((old) => {
                        const next = { ...old };
                        if (value) next[field] = value;
                        else delete next[field];
                        return next;
                      });
                      resetPreview();
                    }}
                  >
                    <option value="">Not mapped</option>
                    {file.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              ))}
            </div>
            <button
              type="button"
              className={`${secondaryButton} mt-4`}
              onClick={() => {
                void dryRun();
              }}
            >
              Preview import
            </button>
          </div>
        ) : null}
      </fieldset>
      {error ? <PageError>{error}</PageError> : null}
      {done ? (
        <p role="status" className="text-sm">
          {done}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-sm">
          Working…
        </p>
      ) : null}
      {preview ? (
        <section className="space-y-4">
          <h2 className="font-semibold">3. Review with the founder</h2>
          <p className="text-sm">
            {preview.report.ready} ready · {preview.report.skipped} skipped ·{" "}
            {preview.report.errors} errors. This preview has saved nothing.
          </p>
          <div
            className="max-h-96 overflow-auto rounded-xl border border-border bg-card"
            tabIndex={0}
            role="region"
            aria-label="Import preview rows"
          >
            <Table className={tableClass} aria-label="Import preview">
              <thead className="bg-muted/50">
                <tr>
                  {["Row", "Status", "Mapped values", "Result"].map((h) => (
                    <th key={h} scope="col" className={headCellClass}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.report.rows.map((r) => (
                  <tr key={r.row} className="border-t border-stone-200">
                    <td className={cellClass}>{r.row}</td>
                    <td className={cellClass}>{r.status}</td>
                    <td
                      className={`${cellClass} min-w-56 max-w-sm break-words`}
                    >
                      {Object.entries(r.values).map(([k, v]) => (
                        <div key={k}>
                          <span className="text-stone-600">{k}: </span>
                          {v}
                        </div>
                      ))}
                    </td>
                    <td className={cellClass}>{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          {preview.report.previewToken && preview.report.ready > 0 ? (
            <div className="space-y-4">
              <label className="flex min-h-11 items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-primary"
                  checked={reviewed}
                  disabled={busy}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed these rows with the founder for {company.data.name}.
              </label>
              <button
                type="button"
                className={primaryButton}
                disabled={!reviewed || busy}
                onClick={() => {
                  void commit();
                }}
              >
                Import {preview.report.ready} rows
              </button>
            </div>
          ) : (
            <p className="text-sm">
              {preview.report.errors
                ? "Fix the errors and preview again. No rows will be imported while there are errors."
                : "There are no new rows to import."}
            </p>
          )}
        </section>
      ) : null}
    </section>
  );
}
