import { randomUUID } from "node:crypto";
import { Data, Effect, Exit } from "effect";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditActorType } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { AuditEntry } from "../../services/audit/audit-log.js";
import type { TestCompany } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import { withScope } from "../../db/scope.js";
import { RequestMeta } from "../../http/request-meta.js";
import { AuditLog } from "../../services/audit/audit-log.js";
import { createCompany } from "../helpers/db.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import {
  TEST_DATABASE_URL,
  TEST_DATABASE_URL_MIGRATE,
} from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let company: TestCompany;
let otherCompany: TestCompany;
let app: pg.Pool;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  [company, otherCompany] = await Promise.all([
    createCompany(db),
    createCompany(db),
  ]);
  app = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), app.end(), owner.end()]);
});

const requestMeta = {
  requestId: "req-audit-test",
  ip: "203.0.113.7",
  userAgent: "ExpendiBusiness/1.0 (iOS)",
};

function record(entry: AuditEntry, organizationId = company.organizationId) {
  return runtime.runPromiseExit(
    withScope({ organizationId, userId: company.admin.id }, (tx) =>
      Effect.flatMap(AuditLog, (audit) => audit.record(tx, entry)),
    ).pipe(Effect.provideService(RequestMeta, requestMeta)),
  );
}

interface AuditRow {
  actor_type: string;
  actor_id: string;
  organization_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
}

async function entriesFor(entityId: string): Promise<AuditRow[]> {
  const { rows } = await owner.query<AuditRow>(
    "SELECT * FROM audit_log WHERE entity_id = $1",
    [entityId],
  );
  return rows;
}

describe("AuditLog.record", () => {
  it.each<[AuditActorType, string]>([
    ["user", randomUUID()],
    ["staff", randomUUID()],
    ["system", "paycrest-webhook"],
  ])("writes every field for a %s actor", async (actorType, actorId) => {
    // #given
    const entityId = randomUUID();

    // #when
    const exit = await record({
      actor: { type: actorType, id: actorId },
      organizationId: company.organizationId,
      action: "organization.cap_changed",
      entity: { type: "organization", id: entityId },
      before: { dailyPayoutCapKes: 20_000_000n },
      after: { dailyPayoutCapKes: 50_000_000n },
    });

    // #then
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(await entriesFor(entityId)).toEqual([
      expect.objectContaining({
        actor_type: actorType,
        actor_id: actorId,
        organization_id: company.organizationId,
        action: "organization.cap_changed",
        entity_type: "organization",
        entity_id: entityId,
        before: { dailyPayoutCapKes: "20000000" },
        after: { dailyPayoutCapKes: "50000000" },
        request_id: requestMeta.requestId,
        ip: requestMeta.ip,
        user_agent: requestMeta.userAgent,
      }),
    ]);
  });

  it("writes platform-wide entries with no company", async () => {
    // #given
    const entityId = randomUUID();

    // #when
    const exit = await record({
      actor: { type: "staff", id: randomUUID() },
      organizationId: null,
      action: "platform.payouts_paused",
      entity: { type: "platform_settings", id: entityId },
    });

    // #then
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(await entriesFor(entityId)).toEqual([
      expect.objectContaining({
        organization_id: null,
        before: null,
        after: null,
      }),
    ]);
  });

  it("refuses to attribute an entry to a company not in context", async () => {
    // #given
    const entityId = randomUUID();

    // #when
    const exit = await record({
      actor: { type: "user", id: company.admin.id },
      organizationId: otherCompany.organizationId,
      action: "organization.renamed",
      entity: { type: "organization", id: entityId },
    });

    // #then
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await entriesFor(entityId)).toEqual([]);
  });

  it("rolls the entry back with the change when the unit of work fails", async () => {
    // #given
    class CapExceeded extends Data.TaggedError("CapExceeded") {}
    const entityId = randomUUID();

    // #when
    const exit = await runtime.runPromiseExit(
      withScope(
        { organizationId: company.organizationId, userId: company.admin.id },
        (tx) =>
          Effect.gen(function* () {
            const audit = yield* AuditLog;
            yield* audit.record(tx, {
              actor: { type: "user", id: company.admin.id },
              organizationId: company.organizationId,
              action: "payout.created",
              entity: { type: "payout", id: entityId },
            });
            return yield* new CapExceeded();
          }),
      ),
    );

    // #then
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { error: { _tag: "CapExceeded" } },
    });
    expect(await entriesFor(entityId)).toEqual([]);
  });
});

describe("audit_log is append-only", () => {
  let entityId: string;

  beforeAll(async () => {
    entityId = randomUUID();
    await record({
      actor: { type: "system", id: "test" },
      organizationId: company.organizationId,
      action: "test.recorded",
      entity: { type: "test", id: entityId },
    });
  });

  it.each([
    ["app", "UPDATE audit_log SET action = 'tampered'"],
    ["app", "DELETE FROM audit_log"],
    ["app", "SELECT * FROM audit_log"],
    ["owner", "UPDATE audit_log SET action = 'tampered'"],
    ["owner", "DELETE FROM audit_log"],
    ["owner", "TRUNCATE audit_log"],
  ] as const)("rejects as the %s role: %s", async (role, statement) => {
    // #given
    const pool = role === "app" ? app : owner;

    // #when
    const attempt = pool.query(statement);

    // #then
    await expect(attempt).rejects.toMatchObject({ code: "42501" });
    expect(await entriesFor(entityId)).toEqual([
      expect.objectContaining({ action: "test.recorded" }),
    ]);
  });
});
