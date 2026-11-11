import type { ImportNewRecord } from "@expendi-business/shared";

export function ImportNewRecords({ records }: { records: ImportNewRecord[] }) {
  if (!records.length) return null;
  return (
    <section
      className="space-y-3 border-y border-border py-4"
      aria-labelledby="new-import-records"
    >
      <h3 id="new-import-records" className="font-semibold">
        New suppliers and categories
      </h3>
      <p className="text-sm text-muted-foreground">
        These names were not found in this company. Check spelling before
        confirming; each name below will be created once. To use an existing
        record instead, correct its name in the spreadsheet and upload it again.
      </p>
      <ul className="space-y-2 text-sm">
        {records.map((record) => (
          <li key={`${record.kind}:${record.name}`} className="break-words">
            <span className="font-medium">Create new {record.kind}:</span>{" "}
            {record.name}
          </li>
        ))}
      </ul>
      {records.some((r) => r.kind === "supplier") ? (
        <p className="text-sm text-muted-foreground">
          New suppliers have no payment details. Add and confirm those
          separately in Payees before paying.
        </p>
      ) : null}
    </section>
  );
}
