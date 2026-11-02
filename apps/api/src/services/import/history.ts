import { and, desc, eq } from "drizzle-orm";
import { Effect } from "effect";

import { importRowReportSchema } from "@expendi-business/shared";

import type { Tenant } from "../../middleware/tenant.js";
import { importRuns, memberships, users } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Forbidden, NotFound } from "../../errors.js";

const selection = {
  id: importRuns.id,
  fileName: importRuns.fileName,
  kind: importRuns.kind,
  createdAt: importRuns.createdAt,
  rowsImported: importRuns.rowsImported,
  rowsSkipped: importRuns.rowsSkipped,
  membershipId: importRuns.membershipId,
  email: users.email,
};
function present<
  T extends {
    createdAt: Date;
    membershipId: string | null;
    email: string | null;
  },
>(row: T) {
  const { membershipId, email, ...rest } = row;
  return {
    ...rest,
    createdAt: row.createdAt.toISOString(),
    importedBy: membershipId ? (email ?? "Company admin") : "Expendi Ops",
  };
}

export function listCompanyImports(tenant: Tenant, offset: number) {
  return Effect.gen(function* () {
    if (tenant.role !== "admin")
      return yield* Effect.fail(
        new Forbidden({ message: "Only company admins can view imports." }),
      );
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const rows = yield* query(() =>
          tx
            .select(selection)
            .from(importRuns)
            .leftJoin(memberships, eq(memberships.id, importRuns.membershipId))
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(eq(importRuns.organizationId, tenant.organizationId))
            .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
            .limit(21)
            .offset(offset),
        );
        return {
          imports: rows.slice(0, 20).map(present),
          nextOffset: rows.length > 20 ? offset + 20 : null,
        };
      }),
    );
  });
}

export function companyImportDetail(tenant: Tenant, id: string) {
  return Effect.gen(function* () {
    if (tenant.role !== "admin")
      return yield* Effect.fail(
        new Forbidden({ message: "Only company admins can view imports." }),
      );
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          tx
            .select({ ...selection, report: importRuns.report })
            .from(importRuns)
            .leftJoin(memberships, eq(memberships.id, importRuns.membershipId))
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(importRuns.organizationId, tenant.organizationId),
                eq(importRuns.id, id),
              ),
            ),
        );
        if (!row)
          return yield* Effect.fail(
            new NotFound({ message: "Import not found." }),
          );
        const { report, ...entry } = row;
        return {
          ...present(entry),
          rows: importRowReportSchema.array().parse(report),
        };
      }),
    );
  });
}
