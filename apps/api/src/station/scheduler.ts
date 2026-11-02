import type { Effect as EffectType } from "effect";
import { Cause, Effect, Exit } from "effect";

import type { AppDeps } from "../layers/main.js";
import type { AppRuntime } from "../runtime.js";
import { DatabaseService } from "../db/client.js";

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
  lockKey: number,
  work: EffectType.Effect<A, E, AppDeps>,
): EffectType.Effect<A | "skipped", E, AppDeps> {
  return Effect.scoped(
    Effect.gen(function* () {
      const { pool } = yield* DatabaseService;
      const client = yield* Effect.acquireRelease(
        Effect.promise(() => pool.connect()),
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

/** Starts every job; the returned function stops them and waits for runs. */
export function startStation(
  runtime: AppRuntime,
  jobs: readonly StationJob[],
): () => Promise<void> {
  const inFlight = new Map<string, Promise<void>>();

  const tick = (job: StationJob) => {
    if (inFlight.has(job.name)) return;
    const run = runtime
      .runPromiseExit(withAdvisoryLock(job.lockKey, job.run))
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
  };
}
