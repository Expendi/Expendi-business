import { and, asc, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type {
  Customer,
  CustomerInput,
  CustomerUpdate,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { CustomerRow } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import { customers } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";

/**
 * A company's customers (docs/decisions/crypto-invoicing.md). Archived,
 * never deleted. Editing one applies to future invoices only.
 */

const customerNotFound = new NotFound({ message: "Customer not found." });

const blankToNull = (value: string | undefined): string | null =>
  value === undefined || value === "" ? null : value;

export function customerView(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    address: row.address,
    taxId: row.taxId,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

const auditedCustomer = (row: CustomerRow) => ({
  name: row.name,
  email: row.email,
  address: row.address,
  taxId: row.taxId,
  archived: row.archivedAt !== null,
});

export function listCustomers(
  tenant: Tenant,
  includeArchived: boolean,
): Effect.Effect<
  { readonly customers: Customer[] },
  DatabaseError,
  DatabaseService
> {
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.organizationId, tenant.organizationId),
            includeArchived ? undefined : isNull(customers.archivedAt),
          ),
        )
        .orderBy(asc(customers.name), asc(customers.createdAt)),
    ),
  ).pipe(Effect.map((rows) => ({ customers: rows.map(customerView) })));
}

export function createCustomer(
  tenant: Tenant,
  input: CustomerInput,
): Effect.Effect<Customer, DatabaseError, DatabaseService | AuditLog> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          tx
            .insert(customers)
            .values({
              organizationId: tenant.organizationId,
              name: input.name,
              email: input.email,
              address: blankToNull(input.address),
              taxId: blankToNull(input.taxId),
            })
            .returning(),
        );
        if (!row) return yield* Effect.dieMessage("customer insert no row");
        yield* audit.record(tx, {
          actor: { type: "user", id: tenant.userId },
          organizationId: tenant.organizationId,
          action: "customer.created",
          entity: { type: "customer", id: row.id },
          after: auditedCustomer(row),
        });
        return customerView(row);
      }),
    );
  });
}

export function updateCustomer(
  tenant: Tenant,
  customerId: string,
  changes: CustomerUpdate,
): Effect.Effect<
  Customer,
  NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const [before] = yield* query(() =>
          tx
            .select()
            .from(customers)
            .where(
              and(
                eq(customers.id, customerId),
                eq(customers.organizationId, tenant.organizationId),
              ),
            )
            .for("update"),
        );
        if (!before) return yield* Effect.fail(customerNotFound);

        const archivedAt =
          changes.archived === undefined
            ? before.archivedAt
            : changes.archived
              ? (before.archivedAt ?? new Date())
              : null;
        const [after] = yield* query(() =>
          tx
            .update(customers)
            .set({
              name: changes.name ?? before.name,
              email: changes.email ?? before.email,
              address:
                changes.address === undefined
                  ? before.address
                  : blankToNull(changes.address),
              taxId:
                changes.taxId === undefined
                  ? before.taxId
                  : blankToNull(changes.taxId),
              archivedAt,
              updatedAt: new Date(),
            })
            .where(eq(customers.id, customerId))
            .returning(),
        );
        if (!after) return yield* Effect.fail(customerNotFound);
        yield* audit.record(tx, {
          actor: { type: "user", id: tenant.userId },
          organizationId: tenant.organizationId,
          action: "customer.updated",
          entity: { type: "customer", id: customerId },
          before: auditedCustomer(before),
          after: auditedCustomer(after),
        });
        return customerView(after);
      }),
    );
  });
}
