import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import { query, withScope } from "../../db/scope.js";

/** 32 random bytes, base64url: what the invoice's pay link carries. */
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface PublicInvoiceTarget {
  readonly invoiceId: string;
  readonly organizationId: string;
}

/**
 * Resolves a pay link's public ID to its invoice before any company is in
 * context, through the SECURITY DEFINER `invoice_by_public_id` (0085). Read
 * the invoice itself afterwards with `withScope({ organizationId })` and no
 * role, the scope the deposit watcher uses. Null for an ID that isn't one
 * or opens nothing; a draft has no public ID, so its link never resolves.
 */
export function findInvoiceByPublicId(
  publicId: string,
): Effect.Effect<PublicInvoiceTarget | null, DatabaseError, DatabaseService> {
  if (!PUBLIC_ID_PATTERN.test(publicId)) return Effect.succeed(null);
  return withScope({}, (tx) =>
    query(() =>
      tx.execute<{ invoice_id: string; organization_id: string }>(
        sql`SELECT invoice_id, organization_id FROM invoice_by_public_id(${publicId})`,
      ),
    ),
  ).pipe(
    Effect.map(({ rows }) => {
      const [row] = rows;
      return row
        ? { invoiceId: row.invoice_id, organizationId: row.organization_id }
        : null;
    }),
  );
}
