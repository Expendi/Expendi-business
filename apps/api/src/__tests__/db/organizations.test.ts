import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import { DatabaseService } from "../../db/client.js";
import {
  DEFAULT_PAYROLL_CAP_MARGIN_PCT,
  organizations,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { createCompany } from "../helpers/db.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

describe("organizations payroll cap margin", () => {
  it("defaults a new company to the 20% payroll margin", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId, userId: company.admin.id },
      (tx) =>
        tx
          .select({ margin: organizations.payrollCapMarginPct })
          .from(organizations)
          .where(eq(organizations.id, company.organizationId)),
    );

    // #then
    expect(row?.margin).toBe(DEFAULT_PAYROLL_CAP_MARGIN_PCT);
  });

  it.each([0, 100])("accepts a margin of %i%%", async (margin) => {
    // #given
    const organizationId = randomUUID();

    // #when
    const inserted = await runInScope(db, { organizationId }, (tx) =>
      tx
        .insert(organizations)
        .values({
          id: organizationId,
          name: "Boundary",
          payrollCapMarginPct: margin,
        })
        .returning({ margin: organizations.payrollCapMarginPct }),
    );

    // #then
    expect(inserted).toEqual([{ margin }]);
  });

  it.each([-1, 101])("rejects a margin of %i%%", async (margin) => {
    // #given
    const organizationId = randomUUID();

    // #when
    const attempt = runInScope(db, { organizationId }, (tx) =>
      tx.insert(organizations).values({
        id: organizationId,
        name: "Out of range",
        payrollCapMarginPct: margin,
      }),
    );

    // #then
    await expect(attempt).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
