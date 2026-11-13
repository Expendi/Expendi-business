import type { Effect as EffectType } from "effect";
import { Cause, Effect, Exit, Redacted } from "effect";
import pg from "pg";

import type { DatabaseError } from "../errors.js";
import type { AppDeps } from "../layers/main.js";
import type { AppRuntime } from "../runtime.js";
import { toDatabaseError } from "../errors.js";

/**
 * Postgres-backed recurring jobs (spec §9). Each job runs on an interval in
 * every API instance, but only one instance at a time does the work: the run
 * holds a Postgres advisory lock, and an instance that can't take it skips
 * that tick. A run never overlaps itself within an instance either.
 */
export interface StationJob {
  readonly name: string;
  readonly everyMs: number;
  /** Unique per job; the advisory lock key. */
  readonly lockKey: number;
  readonly run: EffectType.Effect<unknown, unknown, AppDeps>;
}

/**
 * What a frequent job's run returns when it found nothing to do, so the
 * station logs only the runs that did something.
 */
export const IDLE = "idle";

function withAdvisoryLock<A, E>(
  lockPool: pg.Pool,
  lockKey: number,
  work: EffectType.Effect<A, E, AppDeps>,
): EffectType.Effect<A | "skipped", E | DatabaseError, AppDeps> {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => lockPool.connect(),
          catch: toDatabaseError,
        }),
        (connection) => Effect.sync(() => connection.release()),
      );
      const { rows } = yield* Effect.promise(() =>
        client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [lockKey],
        ),
      );
      if (!rows[0]?.locked) return "skipped" as const;
      return yield* work.pipe(
        Effect.ensuring(
          Effect.promise(() =>
            client.query("SELECT pg_advisory_unlock($1)", [lockKey]),
          ),
        ),
      );
    }),
  );
}

/**
 * Starts every job; the returned function stops them, waits for runs and
 * closes the lock connections. `databaseUrl` is the API's own (restricted)
 * role: advisory locks need no table privileges.
 */
export function startStation(
  runtime: AppRuntime,
  jobs: readonly StationJob[],
  databaseUrl: Redacted.Redacted,
): () => Promise<void> {
  // A run holds its lock connection while its work takes others. Drawn from
  // the work pool, jobs firing together could hold every connection and wait
  // forever for one more, so locks get their own pool with room for every
  // job: no number of jobs firing together can exhaust the work pool.
  const lockPool = new pg.Pool({
    connectionString: Redacted.value(databaseUrl),
    max: jobs.length,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });
  // An idle client can error when its backend drops; without a listener
  // Node treats it as unhandled and crashes. The pool evicts the client.
  lockPool.on("error", (error) => {
    console.error("[station] idle lock client error", error);
  });
  const inFlight = new Map<string, Promise<void>>();

  const tick = (job: StationJob) => {
    if (inFlight.has(job.name)) return;
    const run = runtime
      .runPromiseExit(withAdvisoryLock(lockPool, job.lockKey, job.run))
      .then((exit) => {
        if (Exit.isFailure(exit)) {
          console.error(
            `[station] ${job.name} failed`,
            Cause.pretty(exit.cause),
          );
        } else if (exit.value !== "skipped" && exit.value !== IDLE) {
          console.log(`[station] ${job.name}`, exit.value);
        }
      })
      .finally(() => inFlight.delete(job.name));
    inFlight.set(job.name, run);
  };

  const timers = jobs.map((job) => setInterval(() => tick(job), job.everyMs));
  console.log(`[station] started: ${jobs.map((job) => job.name).join(", ")}`);

  return async () => {
    for (const timer of timers) clearInterval(timer);
    await Promise.all(inFlight.values());
    await lockPool.end();
  };
}
