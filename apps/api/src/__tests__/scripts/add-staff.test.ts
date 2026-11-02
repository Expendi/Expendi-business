import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, Layer } from "effect";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseError } from "../../errors.js";
import type { AppRuntime } from "../../runtime.js";
import type { AuditLog } from "../../services/audit/audit-log.js";
import {
  addStaffUser,
  disableStaffUser,
  ownerDatabase,
} from "../../../scripts/lib/staff-users.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { staffUsers } from "../../db/schema/index.js";
import { NotFound } from "../../errors.js";
import { AuditLogLive } from "../../services/audit/audit-log.js";
import {
  bearer,
  fakePrivyEmails,
  makeTestRuntime,
} from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const INSUFFICIENT_PRIVILEGE = { code: "42501" };

let owner: pg.Pool;
let runtime: AppRuntime;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  runtime = makeTestRuntime();
});

afterAll(async () => {
  await Promise.all([owner.end(), runtime.dispose()]);
});

function asOwner<A>(
  effect: Effect.Effect<
    A,
    NotFound | DatabaseError,
    DatabaseService | AuditLog
  >,
): Promise<Exit.Exit<A, NotFound | DatabaseError>> {
  return Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(Layer.merge(ownerDatabase(owner), AuditLogLive)),
    ),
  );
}

function newEmail(): string {
  return `ops-${randomUUID()}@expendi.test`;
}

interface StaffAuditRow {
  action: string;
  actor_type: string;
  actor_id: string;
  organization_id: string | null;
  before: unknown;
  after: unknown;
}

async function auditFor(staffUserId: string): Promise<StaffAuditRow[]> {
  const { rows } = await owner.query<StaffAuditRow>(
    `SELECT action, actor_type, actor_id, organization_id, before, after
     FROM audit_log
     WHERE entity_type = 'staff_user' AND entity_id = $1
     ORDER BY occurred_at`,
    [staffUserId],
  );
  return rows;
}

async function staffMeAs(email: string): Promise<number> {
  const privyUserId = `did:privy:${randomUUID()}`;
  fakePrivyEmails.set(privyUserId, email);
  const response = await createApp({ runtime }).request("/internal/me", {
    headers: bearer(privyUserId),
  });
  return response.status;
}

describe("addStaffUser", () => {
  it("adds a staff member and audits it as the add-staff system actor", async () => {
    // #given
    const email = newEmail();

    // #when
    const exit = await asOwner(addStaffUser({ email, role: "ops_admin" }));

    // #then
    if (!Exit.isSuccess(exit)) throw new Error("addStaffUser failed");
    expect(exit.value).toMatchObject({
      outcome: "added",
      email,
      role: "ops_admin",
      status: "active",
    });
    expect(await auditFor(exit.value.staffUserId)).toEqual([
      {
        action: "staff_user.added",
        actor_type: "system",
        actor_id: "add-staff",
        organization_id: null,
        before: null,
        after: { email, role: "ops_admin", status: "active" },
      },
    ]);
    expect(await staffMeAs(email)).toBe(200);
  });

  it("changes nothing when re-run with the same role", async () => {
    // #given
    const email = newEmail();
    await asOwner(addStaffUser({ email, role: "ops_viewer" }));

    // #when
    const exit = await asOwner(addStaffUser({ email, role: "ops_viewer" }));

    // #then
    if (!Exit.isSuccess(exit)) throw new Error("addStaffUser failed");
    expect(exit.value.outcome).toBe("unchanged");
    expect(await auditFor(exit.value.staffUserId)).toHaveLength(1);
  });

  it("changes the role and re-activates a disabled member, with before and after", async () => {
    // #given
    const email = newEmail();
    await asOwner(addStaffUser({ email, role: "ops_viewer" }));
    await asOwner(disableStaffUser(email));

    // #when
    const exit = await asOwner(addStaffUser({ email, role: "ops_admin" }));

    // #then
    if (!Exit.isSuccess(exit)) throw new Error("addStaffUser failed");
    expect(exit.value).toMatchObject({
      outcome: "updated",
      role: "ops_admin",
      status: "active",
    });
    expect((await auditFor(exit.value.staffUserId)).at(-1)).toMatchObject({
      action: "staff_user.updated",
      before: { role: "ops_viewer", status: "disabled" },
      after: { role: "ops_admin", status: "active" },
    });
    expect(await staffMeAs(email)).toBe(200);
  });
});

describe("disableStaffUser", () => {
  it("disables the member, audits it, and the API refuses them", async () => {
    // #given
    const email = newEmail();
    await asOwner(addStaffUser({ email, role: "ops_admin" }));

    // #when
    const exit = await asOwner(disableStaffUser(email));

    // #then
    if (!Exit.isSuccess(exit)) throw new Error("disableStaffUser failed");
    expect(exit.value).toMatchObject({
      outcome: "disabled",
      status: "disabled",
    });
    expect((await auditFor(exit.value.staffUserId)).at(-1)).toMatchObject({
      action: "staff_user.disabled",
      actor_type: "system",
      before: { status: "active" },
      after: { status: "disabled" },
    });
    expect(await staffMeAs(email)).toBe(403);
  });

  it("fails for an email that isn't on the staff list", async () => {
    // #when
    const exit = await asOwner(disableStaffUser(newEmail()));

    // #then
    expect(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : null,
    ).toBeInstanceOf(NotFound);
  });
});

describe("staff_users access", () => {
  it("gives the API's role no access to the table", async () => {
    // #given
    const { db } = await runtime.runPromise(DatabaseService);

    // #when
    const read = db.select().from(staffUsers).limit(1);
    const write = db
      .insert(staffUsers)
      .values({ email: newEmail(), role: "ops_admin" });

    // #then
    await expect(read).rejects.toMatchObject({ cause: INSUFFICIENT_PRIVILEGE });
    await expect(write).rejects.toMatchObject({
      cause: INSUFFICIENT_PRIVILEGE,
    });
  });
});
