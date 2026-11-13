import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Effect, Layer, Redacted } from "effect";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AppRuntime } from "../../runtime.js";
import type { StationJob } from "../../station/scheduler.js";
import { DatabaseService } from "../../db/client.js";
import * as schema from "../../db/schema/index.js";
import { makeRuntime } from "../../runtime.js";
import { startStation } from "../../station/scheduler.js";
import { makeTestLayer } from "../helpers/runtime.js";
import { TEST_DATABASE_URL } from "../setup/test-database.js";

const WORK_POOL_MAX = 2;
const JOBS_FIRING_TOGETHER = 6;
// Far from the real jobs' keys, so a parallel test file never holds them.
const FIRST_LOCK_KEY = 940_000;

/** A work pool smaller than the jobs that fire together, failing fast. */
const SmallWorkPool = Layer.scoped(
  DatabaseService,
  Effect.acquireRelease(
    Effect.sync(() => {
      const pool = new pg.Pool({
        connectionString: TEST_DATABASE_URL,
        max: WORK_POOL_MAX,
        connectionTimeoutMillis: 500,
      });
      pool.on("error", (error) => {
        console.error("[test] idle pool client error", error);
      });
      return { db: drizzle(pool, { schema }), pool };
    }),
    ({ pool }) => Effect.promise(() => pool.end()),
  ),
);

let runtime: AppRuntime;
let stopStation: (() => Promise<void>) | undefined;
const stationErrors: string[] = [];

beforeAll(() => {
  runtime = makeRuntime(Layer.merge(makeTestLayer(), SmallWorkPool));
});

afterEach(async () => {
  await stopStation?.();
  stopStation = undefined;
  stationErrors.length = 0;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await runtime.dispose();
});

function captureStationErrors(): void {
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stationErrors.push(args.map(String).join(" "));
  });
}

/** A job whose work is one query through the API's own database service. */
function queryJob(index: number, ran: Set<string>): StationJob {
  const name = `test-job-${index}`;
  return {
    name,
    everyMs: 100,
    lockKey: FIRST_LOCK_KEY + index,
    run: Effect.gen(function* () {
      const { db } = yield* DatabaseService;
      yield* Effect.promise(() => db.execute(sql`SELECT 1`));
      ran.add(name);
    }),
  };
}

describe("the station", () => {
  it("runs more jobs at once than the work pool has connections", async () => {
    // #given
    captureStationErrors();
    const ran = new Set<string>();
    const jobs = Array.from({ length: JOBS_FIRING_TOGETHER }, (_, index) =>
      queryJob(index, ran),
    );

    // #when every job fires on the same tick
    stopStation = startStation(runtime, jobs, Redacted.make(TEST_DATABASE_URL));
    await vi.waitFor(
      () => {
        expect(ran.size + stationErrors.length).toBeGreaterThanOrEqual(
          JOBS_FIRING_TOGETHER,
        );
      },
      { timeout: 3_000 },
    );

    // #then
    expect(stationErrors).toEqual([]);
    expect(ran.size).toBe(JOBS_FIRING_TOGETHER);
  });

  it("skips a job while another instance holds its lock", async () => {
    // #given another instance running the job
    captureStationErrors();
    const ran = new Set<string>();
    const job = queryJob(JOBS_FIRING_TOGETHER, ran);
    const otherInstance = new pg.Client({
      connectionString: TEST_DATABASE_URL,
    });
    await otherInstance.connect();
    try {
      await otherInstance.query("SELECT pg_advisory_lock($1)", [job.lockKey]);

      // #when
      stopStation = startStation(
        runtime,
        [job],
        Redacted.make(TEST_DATABASE_URL),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));

      // #then it waits its turn, and runs once the lock is free
      expect(ran.size).toBe(0);
      await otherInstance.query("SELECT pg_advisory_unlock($1)", [job.lockKey]);
      await vi.waitFor(() => {
        expect(ran.size).toBe(1);
      });
      expect(stationErrors).toEqual([]);
    } finally {
      await otherInstance.end();
    }
  });
});
