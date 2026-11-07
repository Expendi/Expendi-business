"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import type {
  CompanyImportRequest,
  ImportReport,
} from "@expendi-business/shared";
import {
  IMPORT_MAX_BYTES,
  importReportSchema,
  importResultSchema,
  parseImportSpreadsheet,
} from "@expendi-business/shared";

import type { CompanyImportKind } from "~/features/imports/import-draft";
import {
  inputClass,
  linkClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useDashboard } from "~/contexts/dashboard-context";
import {
  importFields,
  importTemplate,
  suggestCompanyMapping,
} from "~/features/imports/import-draft";
import { ImportHistory } from "~/features/imports/import-history";
import { ImportNewRecords } from "~/features/imports/import-new-records";
import { ImportResults } from "~/features/imports/import-results";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { useApi } from "~/lib/use-api";

export function ImportsView({
  initialKind,
}: {
  initialKind: CompanyImportKind;
}) {
  const { company, canAct } = useDashboard();
  if (!canAct)
    return (
      <section>
        <h1 className="text-xl font-semibold">Import spreadsheet</h1>
        <p className="mt-2">
          Only company admins can import spreadsheets. Ask an admin to upload
          this file.
        </p>
      </section>
    );
  return (
    <CompanyImports
      key={`${company.organizationId}:${initialKind}`}
      organizationId={company.organizationId}
      companyName={company.name}
      initialKind={initialKind}
    />
  );
}

function CompanyImports({
  organizationId,
  companyName,
  initialKind,
}: {
  organizationId: string;
  companyName: string;
  initialKind: CompanyImportKind;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState(initialKind);
  const [layout, setLayout] = useState<"standard" | "shanga">("standard");
  const [file, setFile] = useState<{
    name: string;
    csv: string;
    parsed: ReturnType<typeof parseImportSpreadsheet>;
  } | null>(null);
  const [mapping, setMapping] = useState<CompanyImportRequest["mapping"]>({});
  const [preview, setPreview] = useState<{
    input: CompanyImportRequest;
    report: ImportReport;
  } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [createMissing, setCreateMissing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  function resetPreview() {
    setPreview(null);
    setReviewed(false);
    setError(null);
    setDone(null);
  }

  async function loadFile(selected?: File) {
    resetPreview();
    setFile(null);
    setMapping({});
    if (!selected) return;
    setBusy(true);
    try {
      if (!/\.(csv|tsv)$/i.test(selected.name))
        throw new Error(
          "Choose a CSV or TSV. In Excel, export one sheet as CSV UTF-8 first.",
        );
      if (selected.size > IMPORT_MAX_BYTES)
        throw new Error(
          "Use a file smaller than 512 KB. Split larger sheets into files of up to 500 rows.",
        );
      let csv: string;
      try {
        csv = new TextDecoder("utf-8", { fatal: true }).decode(
          await selected.arrayBuffer(),
        );
      } catch {
        throw new Error("Export this sheet as CSV UTF-8, then try again.");
      }
      const parsed = parseImportSpreadsheet(csv, layout);
      setFile({ name: selected.name, csv, parsed });
      setMapping(suggestCompanyMapping(parsed.headers, kind));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't read this spreadsheet.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function dryRun() {
    if (!file) return;
    resetPreview();
    setBusy(true);
    const input: CompanyImportRequest = {
      kind,
      layout,
      fileName: file.name,
      csv: file.csv,
      mapping,
      createMissing,
    };
    try {
      const report = await api.post(
        `/organizations/${organizationId}/imports/preview`,
        input,
        importReportSchema,
      );
      setPreview({ input, report });
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (
      !reviewed ||
      !preview?.report.previewToken ||
      preview.report.errors ||
      !preview.report.ready
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post(
        `/organizations/${organizationId}/imports/commit`,
        { ...preview.input, previewToken: preview.report.previewToken },
        importResultSchema,
      );
      setDone(
        `${result.imported} ${result.imported === 1 ? "record" : "records"} imported into ${companyName}; ${result.skipped} skipped. No money was sent.`,
      );
      setPreview(null);
      setReviewed(false);
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes(organizationId),
      });
    } catch (e) {
      setError(
        `${describeApiError(e)} Check Import history, then preview again before retrying.`,
      );
      setPreview(null);
      setReviewed(false);
      void queryClient.invalidateQueries({
        queryKey: ["imports", organizationId],
      });
    } finally {
      setBusy(false);
    }
  }
  const missing = importFields[kind].some(
    ({ field, required }) =>
      required && !mapping[field as keyof typeof mapping],
  );
  return (
    <section className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-3">
        <Link
          href={kind === "history" ? "/expenses" : "/bills"}
          className={linkClass}
        >
          Back to {kind === "history" ? "Expenses" : "Bills"}
        </Link>
        <h1 className="text-2xl font-semibold">Import your spreadsheet</h1>
        <p className="max-w-2xl text-sm text-stone-600">
          Bring paid expenses or unpaid bills into{" "}
          <strong>{companyName}</strong>. Match your columns, check the preview,
          then import. Your file is only saved as records after you confirm.
        </p>
        <p className="max-w-2xl text-sm text-stone-600">
          Imports never send money. Paid expenses appear in Expenses and reports
          without being sent to Zoho. Unpaid bills appear in Bills for payment
          later.
        </p>
      </header>
      <fieldset disabled={busy} className="space-y-5">
        <legend className="mb-4 text-lg font-semibold">
          1. Choose your records
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            What are you importing?
            <select
              className={inputClass}
              value={kind}
              onChange={(e) => {
                const next = e.target.value === "bill" ? "bill" : "history";
                setKind(next);
                setMapping(
                  file ? suggestCompanyMapping(file.parsed.headers, next) : {},
                );
                resetPreview();
              }}
            >
              <option value="history">
                Paid expenses: money already spent
              </option>
              <option value="bill">Unpaid bills: money you still owe</option>
            </select>
          </label>
          <label className="text-sm">
            Spreadsheet layout
            <select
              className={inputClass}
              value={layout}
              onChange={(e) => {
                setLayout(e.target.value === "shanga" ? "shanga" : "standard");
                setFile(null);
                setMapping({});
                resetPreview();
              }}
            >
              <option value="standard">Standard / custom columns</option>
              <option value="shanga">Shanga expense sheets</option>
            </select>
          </label>
        </div>
        <div className="space-y-2 text-sm text-stone-600">
          <p>
            Use UTF-8 CSV or TSV, up to 500 non-empty rows and 512 KB. Dates:
            DD/MM/YYYY or YYYY-MM-DD. Amounts: KES, for example 1,500.00.
            Earlier financial periods are supported.
          </p>
          <p>
            Existing categories{kind === "bill" ? " and payees" : ""} are
            matched by name, ignoring capitalization and surrounding spaces. New
            names appear in the preview for creation when you confirm. Keep paid
            and unpaid records in separate files. Receipt links do not upload
            receipts.
          </p>
          {layout === "shanga" ? (
            <p>
              Repeated headings and summary-only cells are skipped. Status must
              say {kind === "history" ? "paid" : "unpaid"}. Choose the final
              transaction amount when Cost and Total both exist. Bills need
              their actual Due Date. Money In is not supported.
            </p>
          ) : null}
          <a
            className={linkClass}
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(importTemplate(kind))}`}
            download={`${kind === "history" ? "paid-expenses" : "unpaid-bills"}-template.csv`}
          >
            Download example CSV
          </a>
          <p>
            Replace the example row with your records. Keep a unique reference
            column when different transactions share the same details.
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={createMissing}
            onChange={(e) => {
              setCreateMissing(e.target.checked);
              resetPreview();
            }}
          />
          {kind === "bill"
            ? "Create missing suppliers and categories when I confirm"
            : "Create missing categories when I confirm"}
        </label>
        {!createMissing ? (
          <p className="text-sm text-stone-600">
            Only existing active names will be accepted. Missing names will
            appear as errors in the preview.
          </p>
        ) : null}
        <label className="block text-sm">
          CSV or TSV file
          <input
            key={layout}
            type="file"
            accept=".csv,.tsv,text/csv,text/tab-separated-values"
            className={`${inputClass} max-w-lg`}
            onChange={(e) => void loadFile(e.target.files?.[0])}
          />
        </label>
        {file ? (
          <section className="space-y-4 border-t border-stone-200 pt-6">
            <h2 className="text-lg font-semibold">2. Match your columns</h2>
            <p className="text-sm text-stone-600">
              {file.name} · {file.parsed.rows.length} data rows ·{" "}
              {file.parsed.ignored.length} template/summary rows skipped. Check
              the suggested matches. Required fields are marked *.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {importFields[kind].map(({ field, label, required }) => (
                <label key={field} className="text-sm">
                  {label}
                  {required ? " *" : " (optional)"}
                  <select
                    className={inputClass}
                    value={mapping[field as keyof typeof mapping] ?? ""}
                    disabled={layout === "shanga" && field === "status"}
                    onChange={(e) => {
                      const value = e.target.value;
                      setMapping((old) => {
                        const next = { ...old };
                        if (value) Object.assign(next, { [field]: value });
                        else delete next[field as keyof typeof next];
                        return next;
                      });
                      resetPreview();
                    }}
                  >
                    <option value="">
                      {required ? "Choose a column" : "Not included"}
                    </option>
                    {file.parsed.headers.map((header, i) => (
                      <option key={header} value={header}>
                        {header}:{" "}
                        {file.parsed.rows[0]?.[i]?.slice(0, 60) ??
                          "empty in first row"}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <p className="text-sm text-stone-600">
              Overview heading is optional: transactions (default),
              subscriptions, salaries or petty_cash. Bills support transactions
              or subscriptions.
            </p>
            <button
              type="button"
              className={primaryButton}
              disabled={missing}
              onClick={() => void dryRun()}
            >
              Preview import
            </button>
          </section>
        ) : null}
      </fieldset>
      {busy ? (
        <p role="status" className="text-sm">
          Processing your spreadsheet…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-error-700">
          {error}
        </p>
      ) : null}
      {done ? (
        <div
          role="status"
          className="space-y-2 rounded-lg border border-stone-200 p-4"
        >
          <p>{done}</p>
          <Link
            href={kind === "history" ? "/expenses" : "/bills"}
            className={linkClass}
          >
            View {kind === "history" ? "expenses" : "bills"}
          </Link>
        </div>
      ) : null}
      {preview ? (
        <section className="space-y-4" aria-labelledby="import-review-title">
          <h2 id="import-review-title" className="text-lg font-semibold">
            3. Review before importing
          </h2>
          <p role="status">
            {preview.report.ready} ready · {preview.report.skipped} skipped ·{" "}
            {preview.report.errors} need correction
          </p>
          <p className="text-lg font-semibold">
            Total to import: KES{" "}
            {formatKesCents(preview.report.totalKes ?? "0")}
          </p>
          <p className="text-sm text-stone-600">
            Nothing has been imported yet. Only ready rows count toward this
            total. Exact repeats are skipped; review similar transactions before
            confirming.
          </p>
          <ImportResults rows={preview.report.rows} />
          <ImportNewRecords records={preview.report.newRecords ?? []} />
          {preview.report.errors ? (
            <p className="text-sm">
              Fix the highlighted rows in your spreadsheet or correct the column
              matches, then preview again. No rows can be imported while there
              are errors.
            </p>
          ) : preview.report.ready && preview.report.previewToken ? (
            <div className="space-y-4">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={busy}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed these{" "}
                {kind === "history" ? "paid expenses" : "unpaid bills"} and the
                total for {companyName}
                {preview.report.newRecords?.length
                  ? ", including the new suppliers or categories listed above"
                  : ""}
                . Importing will not send money.
              </label>
              <button
                type="button"
                className={primaryButton}
                disabled={!reviewed || busy}
                onClick={() => void commit()}
              >
                Import {preview.report.ready}{" "}
                {kind === "history" ? "expense" : "bill"}
                {preview.report.ready === 1 ? "" : "s"}
              </button>
            </div>
          ) : (
            <p>There are no new records to import.</p>
          )}
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={resetPreview}
          >
            Back to column matching
          </button>
        </section>
      ) : null}
      <ImportHistory organizationId={organizationId} />
    </section>
  );
}
