import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DbScope, Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { query, withScope } from "../../db/scope.js";

/**
 * Staff are never company members, so nothing in their login gives them a
 * company scope. A staff view of one company sets that company's scope on
 * purpose, for one transaction, and makes the transaction READ ONLY first:
 * Postgres then refuses any write in it, so a viewer's bug can't change a
 * company's data even though row-level security would allow it there.
 * Cross-company lists go through `SECURITY DEFINER` functions instead.
 */
export function withStaffReadScope<A, E, R>(
  scope: Pick<DbScope, "organizationId">,
  work: (tx: Transaction) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R | DatabaseService> {
  return withScope({ organizationId: scope.organizationId }, (tx) =>
    query(() => tx.execute(sql`SET TRANSACTION READ ONLY`)).pipe(
      Effect.zipRight(work(tx)),
    ),
  );
}
