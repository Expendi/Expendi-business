import { and, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  AccountingSyncStatus,
  CompanyZohoResponse,
} from "@expendi-business/shared";
import { COMPANY_ZOHO_FAILED_SYNCS_SHOWN } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import { accountingSyncs } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { entityKey, entityLabels } from "../audit/entity-labels.js";
import { loadOpenConnection } from "./connections.js";

/**
 * The company's own view of its Zoho Books connection (spec §6.17), for its
 * admins and accountants: whether it's connected, to which organization,
 * when it last synced and what didn't reach Zoho. Read in the caller's
 * scope; it never carries a token, a link or Zoho's account IDs.
 */

export function companyZohoStatus(
  tenant: Tenant,
): Effect.Effect<CompanyZohoResponse, DatabaseError, DatabaseService> {
  const { organizationId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const connection = yield* loadOpenConnection(tx, organizationId);
      const counted = yield* query(() =>
        tx
          .select({
            status: accountingSyncs.status,
            count: sql<number>`count(*)::int`,
            lastSyncedAt:
              sql<Date | null>`max(${accountingSyncs.syncedAt})`.mapWith(
                accountingSyncs.syncedAt,
              ),
          })
          .from(accountingSyncs)
          .where(eq(accountingSyncs.organizationId, organizationId))
          .groupBy(accountingSyncs.status),
      );
      const failed = yield* query(() =>
        tx
          .select({
            id: accountingSyncs.id,
            subjectType: accountingSyncs.subjectType,
            subjectId: accountingSyncs.subjectId,
            lastError: accountingSyncs.lastError,
            updatedAt: accountingSyncs.updatedAt,
          })
          .from(accountingSyncs)
          .where(
            and(
              eq(accountingSyncs.organizationId, organizationId),
              eq(accountingSyncs.status, "failed"),
            ),
          )
          .orderBy(desc(accountingSyncs.updatedAt), desc(accountingSyncs.id))
          .limit(COMPANY_ZOHO_FAILED_SYNCS_SHOWN),
      );
      const labels = yield* entityLabels(
        tx,
        organizationId,
        failed.map((row) => ({ type: row.subjectType, id: row.subjectId })),
      );
      const count = (status: AccountingSyncStatus) =>
        counted.find((row) => row.status === status)?.count ?? 0;
      const lastSyncedAt =
        counted.find((row) => row.status === "synced")?.lastSyncedAt ?? null;
      return {
        status:
          connection === null || connection.status === "disconnected"
            ? "not_connected"
            : connection.status,
        organizationName: connection?.externalOrganizationId
          ? (connection.externalOrganizationName ??
            connection.externalOrganizationId)
          : null,
        connectedAt: connection?.connectedAt?.toISOString() ?? null,
        lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
        counts: {
          pending: count("pending"),
          synced: count("synced"),
          failed: count("failed"),
        },
        failed: failed.map((row) => ({
          id: row.id,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          label: labels.get(entityKey(row.subjectType, row.subjectId)) ?? null,
          reason: row.lastError,
          failedAt: row.updatedAt.toISOString(),
        })),
      };
    }),
  );
}
