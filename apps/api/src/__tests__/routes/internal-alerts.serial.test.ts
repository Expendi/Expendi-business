import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  OpsAlert,
  OpsAlertKind,
  OpsAlertsResponse,
  SystemHealth,
} from "@expendi-business/shared";
import {
  opsAlertsResponseSchema,
  systemHealthSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { opsAlerts } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { createCompany } from "../helpers/db.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createNonStaffLogin, createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * Serial: alerts and job heartbeats are platform-wide, so seeding them
 * would change what the alert and webhook tests in other files see.
 */
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let admin: TestStaff;
let viewer: TestStaff;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  [admin, viewer] = await Promise.all([
    createStaff(owner, { role: "ops_admin" }),
    createStaff(owner, { role: "ops_viewer" }),
  ]);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

interface SeedAlert {
  readonly kind?: OpsAlertKind;
  readonly subjectKey?: string;
  readonly organizationId?: string | null;
  readonly title?: string;
  readonly details?: readonly { label: string; value: string }[];
  readonly occurrences?: number;
  readonly openedMinutesAgo?: number;
  readonly lastSeenMinutesAgo?: number;
  readonly resolvedMinutesAgo?: number | null;
  readonly notifiedMinutesAgo?: number | null;
  readonly notifyAttempts?: number;
  readonly nextNotifyInMinutes?: number;
  readonly lastNotifyError?: string | null;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * An incident written as the owner, outside any company or user context,
 * as the alert job writes one.
 */
async function seedAlert(alert: SeedAlert = {}): Promise<string> {
  const {
    rows: [row],
  } = await owner.query<{ id: string }>(
    `INSERT INTO ops_alerts
       (kind, subject_key, organization_id, title, details, occurrences,
        opened_at, last_seen_at, resolved_at, notified_at, notify_attempts,
        next_notify_at, last_notify_error)
     VALUES ($1, $2, $3, $4, $5, $6,
             now() - make_interval(mins => $7),
             now() - make_interval(mins => $8),
             now() - make_interval(mins => $9),
             now() - make_interval(mins => $10),
             $11,
             now() + make_interval(mins => $12),
             $13)
     RETURNING id`,
    [
      alert.kind ?? "payout_needs_review",
      alert.subjectKey ?? randomUUID(),
      alert.organizationId ?? null,
      alert.title ?? "Seeded alert",
      JSON.stringify(alert.details ?? []),
      alert.occurrences ?? 1,
      alert.openedMinutesAgo ?? 10,
      alert.lastSeenMinutesAgo ?? alert.openedMinutesAgo ?? 10,
      alert.resolvedMinutesAgo ?? null,
      alert.notifiedMinutesAgo ?? null,
      alert.notifyAttempts ?? 0,
      alert.nextNotifyInMinutes ?? 0,
      alert.lastNotifyError ?? null,
    ],
  );
  if (!row) throw new Error("ops_alerts insert returned no row");
  return row.id;
}

async function setHeartbeat(job: string, minutesAgo: number): Promise<void> {
  await owner.query(
    `INSERT INTO station_heartbeats (job, last_finished_at)
     VALUES ($1, now() - make_interval(mins => $2))
     ON CONFLICT (job) DO UPDATE SET last_finished_at = excluded.last_finished_at`,
    [job, minutesAgo],
  );
}

/** Keep other tests' webhook history older than this test's incident. */
async function ageWebhookIncidents(): Promise<void> {
  await owner.query(
    `UPDATE ops_alerts
     SET opened_at = least(opened_at, now() - interval '2 days'),
         last_seen_at = least(last_seen_at, now() - interval '2 days'),
         resolved_at = now() - interval '1 day'
     WHERE kind = 'webhook_signature_failure'`,
  );
}

async function get(path: string, staff: TestStaff = admin): Promise<Response> {
  return app.request(path, { headers: bearer(staff.privyUserId) });
}

async function alertsPage(
  staff: TestStaff = admin,
): Promise<OpsAlertsResponse> {
  const response = await get("/internal/alerts", staff);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return opsAlertsResponseSchema.parse(body.data);
}

async function health(staff: TestStaff = admin): Promise<SystemHealth> {
  const response = await get("/internal/health", staff);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return systemHealthSchema.parse(body.data);
}

const minutesBefore = (iso: string, later: string): number =>
  (Date.parse(later) - Date.parse(iso)) / 60_000;

const PATHS = ["/internal/alerts", "/internal/health"] as const;

describe("alerts and system health access", () => {
  it("refuses a request without a token", async () => {
    // #when
    const statuses = await Promise.all(
      PATHS.map(async (path) => (await app.request(path)).status),
    );

    // #then
    expect(statuses).toEqual([401, 401]);
  });

  it("refuses an email that isn't on the staff list", async () => {
    // #given
    const login = createNonStaffLogin();

    // #when
    const statuses = await Promise.all(
      PATHS.map(
        async (path) =>
          (await app.request(path, { headers: bearer(login.privyUserId) }))
            .status,
      ),
    );

    // #then
    expect(statuses).toEqual([403, 403]);
  });

  it("refuses a company admin who isn't staff, even about their own company", async () => {
    // #given
    const company = await createCompany(db);
    await seedAlert({
      kind: "low_company_balance",
      subjectKey: company.organizationId,
      organizationId: company.organizationId,
    });

    // #when
    const statuses = await Promise.all(
      PATHS.map(
        async (path) =>
          (
            await app.request(path, {
              headers: bearer(company.admin.privyUserId),
            })
          ).status,
      ),
    );

    // #then
    expect(statuses).toEqual([403, 403]);
  });

  it("lets an ops viewer read both pages", async () => {
    // #when
    const statuses = await Promise.all(
      PATHS.map(async (path) => (await get(path, viewer)).status),
    );

    // #then
    expect(statuses).toEqual([200, 200]);
  });

  it("has no way to change an alert or a heartbeat", async () => {
    // #given
    const writes = PATHS.flatMap((path) =>
      ["POST", "PUT", "PATCH", "DELETE"].map((method) => ({ path, method })),
    );

    // #when
    const statuses = await Promise.all(
      writes.map(
        async ({ path, method }) =>
          (
            await app.request(path, {
              method,
              headers: {
                ...bearer(admin.privyUserId),
                "content-type": "application/json",
              },
              body: method === "DELETE" ? undefined : "{}",
            })
          ).status,
      ),
    );

    // #then
    expect(statuses).toEqual(writes.map(() => 404));
  });
});

describe("GET /internal/alerts", () => {
  let company: TestCompany;
  let lowBalance: string;
  let needsReview: string;
  let retrying: string;
  let reconciliation: string;
  let resolvedYesterday: string;
  let resolvedLastWeek: string;
  let payoutId: string;

  beforeAll(async () => {
    company = await createCompany(db);
    payoutId = randomUUID();
    await owner.query(
      "UPDATE ops_alerts SET resolved_at = now() - interval '30 days' WHERE kind = 'reconciliation_stopped' AND resolved_at IS NULL",
    );
    lowBalance = await seedAlert({
      kind: "low_company_balance",
      subjectKey: company.organizationId,
      organizationId: company.organizationId,
      title: `Low wallet balance at ${company.name}`,
      details: [
        { label: "Company", value: company.name },
        { label: "Spendable now", value: "KES 1,000.00" },
      ],
      openedMinutesAgo: 30,
      lastSeenMinutesAgo: 1,
      notifiedMinutesAgo: 29,
      notifyAttempts: 1,
    });
    needsReview = await seedAlert({
      kind: "payout_needs_review",
      subjectKey: payoutId,
      organizationId: company.organizationId,
      openedMinutesAgo: 3,
    });
    retrying = await seedAlert({
      kind: "zoho_sync_failing",
      organizationId: company.organizationId,
      openedMinutesAgo: 20,
      notifyAttempts: 2,
      nextNotifyInMinutes: 2,
      lastNotifyError: "Resend answered HTTP 500",
    });
    reconciliation = await seedAlert({
      kind: "reconciliation_stopped",
      subjectKey: "reconcile-paycrest",
      openedMinutesAgo: 15,
    });
    resolvedYesterday = await seedAlert({
      kind: "payout_failed",
      organizationId: company.organizationId,
      openedMinutesAgo: 2 * MINUTES_PER_DAY,
      resolvedMinutesAgo: MINUTES_PER_DAY,
    });
    resolvedLastWeek = await seedAlert({
      kind: "payout_needs_review",
      organizationId: company.organizationId,
      openedMinutesAgo: 9 * MINUTES_PER_DAY,
      resolvedMinutesAgo: 8 * MINUTES_PER_DAY,
      notifiedMinutesAgo: 9 * MINUTES_PER_DAY,
      notifyAttempts: 1,
    });
  });

  const ids = (alerts: readonly OpsAlert[]) => alerts.map(({ id }) => id);

  it("lists open alerts newest first, before those resolved", async () => {
    // #when
    const page = await alertsPage();

    // #then
    expect(
      ids(page.open).filter((id) =>
        [lowBalance, needsReview, retrying, reconciliation].includes(id),
      ),
    ).toEqual([needsReview, reconciliation, retrying, lowBalance]);
  });

  it("keeps alerts resolved in the last 7 days and leaves out older ones", async () => {
    // #when
    const page = await alertsPage();

    // #then
    expect({
      resolved: ids(page.recentlyResolved).filter((id) =>
        [resolvedYesterday, resolvedLastWeek].includes(id),
      ),
      openAmongResolved: page.recentlyResolved.filter(
        ({ resolvedAt }) => resolvedAt === null,
      ),
      resolvedAmongOpen: page.open.filter(
        ({ resolvedAt }) => resolvedAt !== null,
      ),
      window: Math.round(
        minutesBefore(page.resolvedSince, new Date().toISOString()) /
          MINUTES_PER_DAY,
      ),
    }).toEqual({
      resolved: [resolvedYesterday],
      openAmongResolved: [],
      resolvedAmongOpen: [],
      window: 7,
    });
  });

  it("shows an alert's kind, subject, company, times, repeat count and sent email", async () => {
    // #when
    const page = await alertsPage();

    // #then
    const alert = page.open.find(({ id }) => id === lowBalance);
    expect(alert).toEqual({
      id: lowBalance,
      kind: "low_company_balance",
      subjectKey: company.organizationId,
      organization: { id: company.organizationId, name: company.name },
      title: `Low wallet balance at ${company.name}`,
      details: [
        { label: "Company", value: company.name },
        { label: "Spendable now", value: "KES 1,000.00" },
      ],
      occurrences: 1,
      openedAt: expect.any(String) as string,
      lastSeenAt: expect.any(String) as string,
      resolvedAt: null,
      email: {
        status: "sent",
        sentAt: expect.any(String) as string,
        attempts: 1,
        lastError: null,
        nextAttemptAt: null,
      },
    });
    expect(
      [alert?.openedAt, alert?.email.sentAt, alert?.lastSeenAt].map((at) =>
        Math.round(minutesBefore(at ?? "", new Date().toISOString())),
      ),
    ).toEqual([30, 29, 1]);
  });

  it("shows an email waiting for its first send, and one being retried after a failure", async () => {
    // #when
    const page = await alertsPage();

    // #then
    const emailOf = (id: string) =>
      page.open.find((alert) => alert.id === id)?.email;
    expect([emailOf(needsReview), emailOf(retrying)]).toEqual([
      {
        status: "pending",
        sentAt: null,
        attempts: 0,
        lastError: null,
        nextAttemptAt: expect.any(String) as string,
      },
      {
        status: "retrying",
        sentAt: null,
        attempts: 2,
        lastError: "Resend answered HTTP 500",
        nextAttemptAt: expect.any(String) as string,
      },
    ]);
  });

  it("shows an alert that resolved before its email went out as not sent", async () => {
    // #when
    const page = await alertsPage();

    // #then
    const alert = page.recentlyResolved.find(
      ({ id }) => id === resolvedYesterday,
    );
    expect({
      email: alert?.email.status,
      resolved: alert?.resolvedAt !== null,
    }).toEqual({ email: "not_sent", resolved: true });
  });

  it("names the payout it's about, and no company for a system alert", async () => {
    // #when
    const page = await alertsPage();

    // #then
    const byId = (id: string) => page.open.find((alert) => alert.id === id);
    expect([
      {
        subjectKey: byId(needsReview)?.subjectKey,
        organization: byId(needsReview)?.organization,
      },
      {
        subjectKey: byId(reconciliation)?.subjectKey,
        organization: byId(reconciliation)?.organization,
      },
    ]).toEqual([
      {
        subjectKey: payoutId,
        organization: { id: company.organizationId, name: company.name },
      },
      { subjectKey: "reconcile-paycrest", organization: null },
    ]);
  });

  it("shows the same alerts to an ops viewer", async () => {
    // #when
    const [asAdmin, asViewer] = await Promise.all([
      alertsPage(admin),
      alertsPage(viewer),
    ]);

    // #then
    expect({
      open: ids(asViewer.open),
      recentlyResolved: ids(asViewer.recentlyResolved),
    }).toEqual({
      open: ids(asAdmin.open),
      recentlyResolved: ids(asAdmin.recentlyResolved),
    });
  });
});

describe("GET /internal/health", () => {
  beforeEach(async () => {
    await setHeartbeat("reconcile-paycrest", 0);
  });

  it("shows the last finished reconciliation run as on time within 5 minutes", async () => {
    // #given
    await setHeartbeat("reconcile-paycrest", 2);

    // #when
    const result = await health(viewer);

    // #then
    expect({
      ...result.reconciliation,
      lastFinishedAt: Math.round(
        minutesBefore(
          result.reconciliation.lastFinishedAt ?? "",
          result.checkedAt,
        ),
      ),
    }).toEqual({
      job: "reconcile-paycrest",
      lastFinishedAt: 2,
      staleAfterMinutes: 5,
      stale: false,
    });
  });

  it("shows reconciliation as stopped after 5 minutes without a finished run", async () => {
    // #given
    await setHeartbeat("reconcile-paycrest", 6);

    // #when
    const result = await health();

    // #then
    expect(result.reconciliation.stale).toBe(true);
  });

  it("shows reconciliation as stopped when it has never finished a run", async () => {
    // #given
    await owner.query(
      "DELETE FROM station_heartbeats WHERE job = 'reconcile-paycrest'",
    );

    // #when
    const result = await health();

    // #then
    expect(result.reconciliation).toEqual({
      job: "reconcile-paycrest",
      lastFinishedAt: null,
      staleAfterMinutes: 5,
      stale: true,
    });
  });

  it("lists every job's heartbeat by name", async () => {
    // #given
    const job = `test-job-${randomUUID()}`;
    await setHeartbeat(job, 3);

    // #when
    const result = await health();

    // #then
    const names = result.jobs.map((entry) => entry.job);
    expect({
      includesBoth: [job, "reconcile-paycrest"].every((name) =>
        names.includes(name),
      ),
      sorted: [...names].sort().join() === names.join(),
    }).toEqual({ includesBoth: true, sorted: true });
  });

  it("shows the open webhook incident's failure count and last failure", async () => {
    // #given
    await ageWebhookIncidents();
    const alertId = await seedAlert({
      kind: "webhook_signature_failure",
      subjectKey: "paycrest",
      occurrences: 4,
      openedMinutesAgo: 40,
      lastSeenMinutesAgo: 5,
    });

    // #when
    const result = await health();

    // #then
    const failures = result.paycrestWebhook.signatureFailures;
    expect({
      ...result.paycrestWebhook,
      signatureFailures: failures && {
        ...failures,
        firstSeenAt: Math.round(
          minutesBefore(failures.firstSeenAt, result.checkedAt),
        ),
        lastSeenAt: Math.round(
          minutesBefore(failures.lastSeenAt, result.checkedAt),
        ),
      },
    }).toEqual({
      resolvesAfterQuietMinutes: 60,
      signatureFailures: {
        alertId,
        open: true,
        count: 4,
        firstSeenAt: 40,
        lastSeenAt: 5,
        resolvedAt: null,
      },
    });
  });

  it("shows the last webhook incident once it has resolved", async () => {
    // #given
    // Another serial file can leave an incident resolved just now. It must
    // be moved out of the fixture's time window along with open incidents.
    await seedAlert({
      kind: "webhook_signature_failure",
      subjectKey: "paycrest",
      openedMinutesAgo: 2,
      lastSeenMinutesAgo: 1,
      resolvedMinutesAgo: 0,
    });
    await ageWebhookIncidents();
    const alertId = await seedAlert({
      kind: "webhook_signature_failure",
      subjectKey: "paycrest",
      occurrences: 2,
      openedMinutesAgo: 120,
      lastSeenMinutesAgo: 90,
      resolvedMinutesAgo: 30,
    });

    // #when
    const result = await health();

    // #then
    expect(result.paycrestWebhook.signatureFailures).toEqual({
      alertId,
      open: false,
      count: 2,
      firstSeenAt: expect.any(String) as string,
      lastSeenAt: expect.any(String) as string,
      resolvedAt: expect.any(String) as string,
    });
  });
});

describe("alerts outside the staff routes", () => {
  it("are invisible to a customer's scope, directly and through the staff read", async () => {
    // #given
    const company = await createCompany(db);
    await seedAlert({
      kind: "low_company_balance",
      subjectKey: company.organizationId,
      organizationId: company.organizationId,
    });

    // #when
    const seen = await runInScope(
      db,
      {
        organizationId: company.organizationId,
        userId: company.admin.id,
        role: "admin",
      },
      async (tx) => {
        const direct = await tx.select().from(opsAlerts);
        const { rows: throughFunction } = await tx.execute(
          sql`SELECT * FROM staff_ops_alerts(NULL, NULL, 200)`,
        );
        return {
          direct: direct.length,
          throughFunction: throughFunction.length,
        };
      },
    );

    // #then
    expect(seen).toEqual({ direct: 0, throughFunction: 0 });
  });

  it("are invisible to a signed-in user with no company in scope", async () => {
    // #given
    const company = await createCompany(db);
    await seedAlert({ organizationId: company.organizationId });

    // #when
    const { rows } = await runInScope(db, { userId: company.admin.id }, (tx) =>
      tx.execute(sql`SELECT * FROM staff_ops_alerts(NULL, NULL, 200)`),
    );

    // #then
    expect(rows).toEqual([]);
  });
});
