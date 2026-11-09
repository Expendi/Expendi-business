import { Effect } from "effect";

import type { DatabaseError } from "../../errors.js";
import type {
  LithicAccountHolder,
  LithicError,
  LithicShape,
} from "../lithic/lithic-client.js";
import { DatabaseService } from "../../db/client.js";
import { query } from "../../db/scope.js";
import { Conflict, ServiceUnavailable } from "../../errors.js";
import { Lithic } from "../lithic/lithic-client.js";

/**
 * Talking to the card issuer. Every call here happens outside a database
 * transaction, so a slow answer never holds a row lock or a transaction open.
 */

const notAvailable = new ServiceUnavailable({
  message: "Cards aren't available yet.",
});

const issuerDown = new ServiceUnavailable({
  message: "We couldn't reach the card issuer. Try again in a minute.",
});

const busy = new Conflict({
  message: "Someone else is making this change. Try again in a moment.",
});

export const requireIssuer: Effect.Effect<
  LithicShape,
  ServiceUnavailable,
  Lithic
> = Effect.flatMap(Lithic, (lithic) =>
  lithic.configured ? Effect.succeed(lithic) : Effect.fail(notAvailable),
);

/** A failed call to the issuer, as the app shows it. */
export function issuerFailure(error: LithicError): ServiceUnavailable {
  return error.code === "NOT_CONFIGURED" ? notAvailable : issuerDown;
}

/**
 * Runs `work` holding a Postgres session lock named `key`, so two requests
 * can't both change the same thing at the issuer. The lock lives on its own
 * connection, outside any transaction, and a second caller is told to retry
 * rather than left waiting.
 */
export function exclusively<A, E, R>(
  key: string,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Conflict | DatabaseError, R | DatabaseService> {
  return Effect.scoped(
    Effect.gen(function* () {
      const { pool } = yield* DatabaseService;
      const { locked } = yield* Effect.acquireRelease(
        query(async () => {
          const connection = await pool.connect();
          try {
            const { rows } = await connection.query<{ locked: boolean }>(
              "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
              [key],
            );
            return { connection, locked: rows[0]?.locked === true };
          } catch (error) {
            connection.release(true);
            throw error;
          }
        }),
        ({ connection, locked: held }) =>
          Effect.promise(async () => {
            if (!held) {
              connection.release();
              return;
            }
            await connection
              .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
                key,
              ])
              .then(
                () => connection.release(),
                // A connection we couldn't unlock must not go back to the pool.
                () => connection.release(true),
              );
          }),
      );
      if (!locked) return yield* Effect.fail(busy);
      return yield* work;
    }),
  );
}

/**
 * The account holder for `externalId`, creating it only if Lithic doesn't
 * have one. Lithic can answer 500 and still create, and a request can die
 * between Lithic's answer and our commit, so it always looks first and looks
 * again after an ambiguous failure: never two creates for one company or
 * cardholder.
 */
export function accountHolderOnce(
  externalId: string,
  create: (
    lithic: LithicShape,
  ) => Effect.Effect<LithicAccountHolder, LithicError>,
): Effect.Effect<
  LithicAccountHolder,
  LithicError | Conflict | DatabaseError,
  Lithic | DatabaseService
> {
  return exclusively(
    `card-issuer:${externalId}`,
    Effect.gen(function* () {
      const lithic = yield* Lithic;
      const existing = yield* lithic.findAccountHolder(externalId);
      if (existing) return existing;
      return yield* create(lithic).pipe(
        Effect.catchTag("LithicError", (error) =>
          error.ambiguous
            ? lithic
                .findAccountHolder(externalId)
                .pipe(
                  Effect.flatMap((found) =>
                    found ? Effect.succeed(found) : Effect.fail(error),
                  ),
                )
            : Effect.fail(error),
        ),
      );
    }),
  );
}
