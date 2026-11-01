import { sql } from "drizzle-orm";
import { expect } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { TestCompany } from "./db.js";
import { runInScope } from "../../db/scope.js";
import { createCompany } from "./db.js";
import { bearer } from "./runtime.js";

/**
 * Company isolation contract (spec §8). Every company-owned table gets
 * `expectTableIsolation`; every company-scoped route gets
 * `expectRouteIsolation`.
 */
export interface IsolationFixture {
  readonly db: Database;
  readonly companyA: TestCompany;
  readonly companyB: TestCompany;
}

export async function createIsolationFixture(
  db: Database,
): Promise<IsolationFixture> {
  const [companyA, companyB] = await Promise.all([
    createCompany(db, "Company A"),
    createCompany(db, "Company B"),
  ]);
  return { db, companyA, companyB };
}

/**
 * Proves the database itself enforces isolation: a deliberately unfiltered
 * SELECT running as company A sees only A's rows, and with no company in
 * context it sees nothing. Seed rows for both companies before calling.
 */
export async function expectTableIsolation(
  { db, companyA, companyB }: IsolationFixture,
  table: string,
  organizationColumn = "organization_id",
): Promise<void> {
  const unfiltered = sql`SELECT ${sql.identifier(organizationColumn)}::text AS organization_id FROM ${sql.identifier(table)}`;

  const asCompanyA = await runInScope(
    db,
    { organizationId: companyA.organizationId, userId: companyA.admin.id },
    (tx) => tx.execute<{ organization_id: string }>(unfiltered),
  );
  const seen = new Set(asCompanyA.rows.map((row) => row.organization_id));
  expect(seen, `${table}: company A should see its own rows`).toContain(
    companyA.organizationId,
  );
  expect(seen, `${table}: company A must not see company B`).not.toContain(
    companyB.organizationId,
  );
  expect([...seen], `${table}: company A sees only company A`).toEqual([
    companyA.organizationId,
  ]);

  const withoutContext = await runInScope(db, {}, (tx) =>
    tx.execute<{ organization_id: string }>(unfiltered),
  );
  expect(withoutContext.rows, `${table}: no context sees nothing`).toEqual([]);
}

/**
 * Proves a company-scoped route rejects company A's admin when they name
 * company B, while still serving company A.
 */
export async function expectRouteIsolation(
  app: App,
  { companyA, companyB }: IsolationFixture,
  request: (organizationId: string) => { path: string; init?: RequestInit },
): Promise<void> {
  const send = (organizationId: string) => {
    const { path, init } = request(organizationId);
    const headers = new Headers(init?.headers);
    headers.set(
      "authorization",
      bearer(companyA.admin.privyUserId).authorization,
    );
    return app.request(path, { ...init, headers });
  };

  const own = await send(companyA.organizationId);
  expect(own.status, "company A's admin can use company A").not.toBe(403);

  const other = await send(companyB.organizationId);
  expect(other.status, "company A's admin cannot use company B").toBe(403);
  const body = await other.text();
  expect(body).not.toContain(companyB.name);
}
