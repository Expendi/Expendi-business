import { sql } from "drizzle-orm";
import { Effect, Exit, Runtime } from "effect";

import type { MembershipRole } from "@expendi-business/shared";

import type { DatabaseError } from "../errors.js";
import type { Database } from "./client.js";
import { toDatabaseError } from "../errors.js";
import { DatabaseService } from "./client.js";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Who a unit of database work runs as. Row-level security policies read these
 * values; leaving one out means the matching rows are invisible.
 */
export interface DbScope {
  readonly organizationId?: string | undefined;
  readonly userId?: string | undefined;
  /** The caller's role in `organizationId`, for role-restricted tables such as salaries (spec §4). */
  readonly role?: MembershipRole | undefined;
}

/**
 * Runs `work` in a transaction with the scope set transaction-locally. A
 * session-level setting would survive on the pooled connection and leak one
 * company's context into the next request.
 */
export function runInScope<A>(
  db: Database,
  scope: DbScope,
  work: (tx: Transaction) => Promise<A>,
): Promise<A> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.org_id', ${scope.organizationId ?? ""}, true), set_config('app.user_id', ${scope.userId ?? ""}, true), set_config('app.role', ${scope.role ?? ""}, true)`,
    );
    return work(tx);
  });
}

/**
 * Effect form of `runInScope`. Any failure of `work`, typed or not, rolls the
 * whole transaction back (including audit entries written inside it) and
 * surfaces with its original type.
 */
export function withScope<A, E, R>(
  scope: DbScope,
  work: (tx: Transaction) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R | DatabaseService> {
  return Effect.gen(function* () {
    const { db } = yield* DatabaseService;
    const runExit = Runtime.runPromiseExit(yield* Effect.runtime<R>());
    let workFailure: Exit.Exit<A, E> | undefined;
    return yield* Effect.tryPromise({
      try: () =>
        runInScope(db, scope, async (tx) => {
          const exit = await runExit(work(tx));
          if (Exit.isSuccess(exit)) return exit.value;
          workFailure = exit;
          // Throwing makes drizzle roll the transaction back.
          throw new Error("rolled back: unit of work failed");
        }),
      catch: toDatabaseError,
    }).pipe(
      Effect.catchAll(
        (databaseError): Effect.Effect<A, E | DatabaseError> =>
          workFailure ?? Effect.fail(databaseError),
      ),
    );
  });
}

/** Lifts one drizzle call into Effect. */
export function query<A>(
  run: () => Promise<A>,
): Effect.Effect<A, DatabaseError> {
  return Effect.tryPromise({ try: run, catch: toDatabaseError });
}
