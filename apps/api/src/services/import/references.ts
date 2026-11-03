import { createHash } from "node:crypto";

import type { ImportNewRecord } from "@expendi-business/shared";
import { CATEGORY_NAME_MAX_LENGTH } from "@expendi-business/shared";

import type { CategoryRow, PayeeRow } from "../../db/schema/index.js";

export interface NewImportReference extends ImportNewRecord {
  id: string;
}

const normalise = (name: string) => name.trim().toLowerCase();

/** Stable IDs keep row hashes identical before creation, after creation and on retries. */
function referenceId(
  organizationId: string,
  kind: ImportNewRecord["kind"],
  name: string,
) {
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([
        "import-reference-v1",
        organizationId,
        kind,
        normalise(name),
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Pure planning only. Archived or ambiguous matches require a corrected preview. */
export function planImportReferences(
  organizationId: string,
  categoryRows: CategoryRow[],
  payeeRows: PayeeRow[],
) {
  const proposed = new Map<string, NewImportReference>();
  function resolve<T extends { id: string; name: string; archived: boolean }>(
    kind: ImportNewRecord["kind"],
    name: string,
    records: T[],
    maxLength: number,
  ): T | NewImportReference {
    const matches = records.filter(
      (r) => normalise(r.name) === normalise(name),
    );
    const active = matches.filter((r) => !r.archived);
    if (active.length > 1)
      throw new Error(
        `More than one active ${kind} matches "${name}". Use a unique name before importing.`,
      );
    if (active[0]) return active[0];
    if (matches.length)
      throw new Error(
        `"${name}" matches an archived ${kind}. Restore it or use a different name, then preview again.`,
      );
    if (name.length > maxLength)
      throw new Error(
        `Keep the new ${kind} name to ${maxLength} characters or fewer.`,
      );
    const id = referenceId(organizationId, kind, name);
    // A previously created record may have been renamed; never reuse its identity.
    if (records.some((r) => r.id === id))
      throw new Error(
        `The imported ${kind} "${name}" was renamed. Use its current name, then preview again.`,
      );
    let record = proposed.get(id);
    if (!record) {
      record = { id, kind, name };
      proposed.set(id, record);
    }
    return record;
  }
  return {
    category: (name: string) =>
      resolve("category", name, categoryRows, CATEGORY_NAME_MAX_LENGTH).id,
    payee: (name: string) => {
      const record = resolve("supplier", name, payeeRows, 120);
      return "method" in record
        ? record
        : { ...record, kind: "supplier" as const, method: null };
    },
    forIds: (ids: (string | null | undefined)[]) =>
      ids.flatMap((id) => {
        const record = id ? proposed.get(id) : undefined;
        return record ? [record] : [];
      }),
  };
}
