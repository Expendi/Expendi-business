import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { ReportExportRow } from "../../db/schema/index.js";
import type { DbScope } from "../../db/scope.js";
import type { DatabaseError, ServiceUnavailable } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { EmailSendError } from "../email/email-sender.js";
import type { FileStorage, StorageError } from "../storage/file-storage.js";
import {
  memberships,
  organizations,
  reportExportLinks,
  reportExports,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { EmailSender } from "../email/email-sender.js";
import { monthlyExportEmail } from "../email/monthly-export-email.js";
import {
  apiPublicUrl,
  EXPORT_LINK_LIFETIME_MS,
  exportLinks,
  hashExportToken,
  newExportToken,
  uploadExport,
} from "./artifacts.js";
import { nairobiMonth, previousMonth } from "./month.js";
import { renderExport } from "./render.js";

/**
 * The export emailed to every company's accountants on the 1st (spec
 * §6.11), for the month just ended. Each company gets one monthly export
 * per month, made the first time the job runs in the new Nairobi month,
 * and each accountant on it is emailed once, with a link of their own.
 *
 * - Recipients are the accountants who aren't removed when it's made,
 *   invited ones included (they may not have signed in yet).
 * - A failed email is retried on later runs while the link is valid, under
 *   a new token, since the old one was never stored.
 * - The job holds its advisory lock, so two runs never overlap.
 */

const MONTHLY_EXPORT: AuditActor = { type: "system", id: "monthly-export" };

export interface MonthlyExportRun {
  readonly month: string;
  readonly created: number;
  readonly emailed: number;
  readonly failed: number;
}

export interface MonthlyExportOutcome {
  readonly created: boolean;
  readonly emailed: number;
  readonly failed: number;
}

type DeliveryError =
  ServiceUnavailable | StorageError | DatabaseError | EmailSendError;

type DeliveryDeps = DatabaseService | FileStorage | AuditLog | EmailSender;

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Africa/Nairobi",
});

const adminScope = (
  organizationId: string,
): DbScope & {
  readonly organizationId: string;
} => ({ organizationId, role: "admin" });

function currentAccountants(
  organizationId: string,
): Effect.Effect<string[], DatabaseError, DatabaseService> {
  return withScope(adminScope(organizationId), (tx) =>
    query(() =>
      tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.role, "accountant"),
            ne(memberships.status, "removed"),
          ),
        )
        .orderBy(memberships.createdAt, memberships.id),
    ),
  ).pipe(Effect.map((rows) => rows.map((row) => row.id)));
}

function findMonthlyExport(
  organizationId: string,
  month: string,
): Effect.Effect<ReportExportRow | null, DatabaseError, DatabaseService> {
  return withScope(adminScope(organizationId), (tx) =>
    query(() =>
      tx
        .select()
        .from(reportExports)
        .where(
          and(
            eq(reportExports.organizationId, organizationId),
            eq(reportExports.month, month),
            eq(reportExports.monthly, true),
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map(([row]) => row ?? null));
}

function createMonthlyExport(
  organizationId: string,
  month: string,
  recipients: readonly string[],
  now: Date,
): Effect.Effect<
  ReportExportRow,
  ServiceUnavailable | StorageError | DatabaseError,
  DatabaseService | FileStorage | AuditLog
> {
  return Effect.gen(function* () {
    const rendered = yield* renderExport(adminScope(organizationId), month);
    const draft = { id: randomUUID(), organizationId, month };
    yield* uploadExport(draft, rendered);
    return yield* withScope(adminScope(organizationId), (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const [row] = yield* query(() =>
          tx
            .insert(reportExports)
            .values({
              ...draft,
              monthly: true,
              recipients: [...recipients],
              expiresAt: new Date(now.getTime() + EXPORT_LINK_LIFETIME_MS),
              createdAt: now,
            })
            .returning(),
        );
        if (!row) {
          return yield* Effect.dieMessage("export insert returned no row");
        }
        yield* audit.record(tx, {
          actor: MONTHLY_EXPORT,
          organizationId,
          action: "report_export.generated",
          entity: { type: "report_export", id: row.id },
          after: {
            month,
            monthly: true,
            recipients,
            expiresAt: row.expiresAt,
          },
        });
        return row;
      }),
    );
  });
}

interface Recipient {
  readonly email: string;
  readonly company: string;
}

/** Null once they're removed, or no longer an accountant. */
function recipientOf(
  organizationId: string,
  membershipId: string,
): Effect.Effect<Recipient | null, DatabaseError, DatabaseService> {
  return withScope(adminScope(organizationId), (tx) =>
    query(() =>
      tx
        .select({ email: users.email, company: organizations.name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(
          organizations,
          eq(organizations.id, memberships.organizationId),
        )
        .where(
          and(
            eq(memberships.id, membershipId),
            eq(memberships.organizationId, organizationId),
            eq(memberships.role, "accountant"),
            ne(memberships.status, "removed"),
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map(([row]) => row ?? null));
}

function alreadyEmailed(
  report: ReportExportRow,
): Effect.Effect<Set<string>, DatabaseError, DatabaseService> {
  return withScope(adminScope(report.organizationId), (tx) =>
    query(() =>
      tx
        .select({ membershipId: reportExportLinks.membershipId })
        .from(reportExportLinks)
        .where(
          and(
            eq(reportExportLinks.exportId, report.id),
            isNotNull(reportExportLinks.emailedAt),
          ),
        ),
    ),
  ).pipe(
    Effect.map(
      (rows) =>
        new Set(
          rows.flatMap((row) => (row.membershipId ? [row.membershipId] : [])),
        ),
    ),
  );
}

/**
 * Issues the accountant's link (replacing the token of an earlier attempt),
 * sends the email, then records it. If recording fails after the email
 * went out, the next run sends again with a new link: rare, and better than
 * an accountant left without one.
 */
function emailAccountant(
  report: ReportExportRow,
  membershipId: string,
  recipient: Recipient,
  baseUrl: URL,
): Effect.Effect<void, DatabaseError | EmailSendError, DeliveryDeps> {
  return Effect.gen(function* () {
    const email = yield* EmailSender;
    const scope = adminScope(report.organizationId);
    const token = newExportToken();
    const tokenHash = hashExportToken(token);
    const [link] = yield* withScope(scope, (tx) =>
      query(() =>
        tx
          .insert(reportExportLinks)
          .values({
            organizationId: report.organizationId,
            exportId: report.id,
            membershipId,
            tokenHash,
          })
          .onConflictDoUpdate({
            target: [
              reportExportLinks.exportId,
              reportExportLinks.membershipId,
            ],
            targetWhere: sql`${reportExportLinks.membershipId} IS NOT NULL`,
            set: { tokenHash },
          })
          .returning({ id: reportExportLinks.id }),
      ),
    );
    if (!link) return yield* Effect.dieMessage("link upsert returned no row");

    yield* email.send(
      monthlyExportEmail({
        to: recipient.email,
        companyName: recipient.company,
        monthLabel: MONTH_LABEL.format(
          new Date(`${report.month}-01T00:00:00Z`),
        ),
        links: exportLinks(baseUrl, token),
        expiresOn: DAY_LABEL.format(report.expiresAt),
        idempotencyKey: `report-export-link/${link.id}/${tokenHash.slice(0, 16)}`,
      }),
    );

    yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* query(() =>
          tx
            .update(reportExportLinks)
            .set({ emailedAt: sql`now()` })
            .where(eq(reportExportLinks.id, link.id)),
        );
        yield* audit.record(tx, {
          actor: MONTHLY_EXPORT,
          organizationId: report.organizationId,
          action: "report_export.emailed",
          entity: { type: "report_export", id: report.id },
          after: { month: report.month, membershipId, linkId: link.id },
        });
      }),
    );
  });
}

function deliverCompany(
  organizationId: string,
  month: string,
  now: Date,
  baseUrl: URL,
): Effect.Effect<MonthlyExportOutcome, DeliveryError, DeliveryDeps> {
  return Effect.gen(function* () {
    let report = yield* findMonthlyExport(organizationId, month);
    let created = false;
    if (!report) {
      const recipients = yield* currentAccountants(organizationId);
      if (recipients.length === 0) return { created, emailed: 0, failed: 0 };
      report = yield* createMonthlyExport(
        organizationId,
        month,
        recipients,
        now,
      );
      created = true;
    }
    if (now.getTime() >= report.expiresAt.getTime()) {
      return { created, emailed: 0, failed: 0 };
    }

    const done = yield* alreadyEmailed(report);
    let emailed = 0;
    let failed = 0;
    for (const membershipId of report.recipients) {
      if (done.has(membershipId)) continue;
      const recipient = yield* recipientOf(organizationId, membershipId);
      if (!recipient) continue;
      const exit = yield* Effect.exit(
        emailAccountant(report, membershipId, recipient, baseUrl),
      );
      if (Exit.isSuccess(exit)) {
        emailed += 1;
      } else {
        failed += 1;
        console.error(
          `[monthly-export] company ${organizationId}, ${month}: emailing an accountant failed`,
          Cause.pretty(exit.cause),
        );
      }
    }
    return { created, emailed, failed };
  });
}

/**
 * One company's pass for the month before `now`'s Nairobi month: makes its
 * monthly export if it isn't made yet, and emails whoever on it hasn't had
 * it.
 */
export function deliverMonthlyExport(
  organizationId: string,
  now: Date = new Date(),
): Effect.Effect<MonthlyExportOutcome, DeliveryError, DeliveryDeps> {
  return Effect.gen(function* () {
    const baseUrl = yield* apiPublicUrl;
    return yield* deliverCompany(
      organizationId,
      previousMonth(nairobiMonth(now)),
      now,
      baseUrl,
    );
  });
}

interface CompanyRef extends Record<string, unknown> {
  readonly organization_id: string;
}

/** `deliverMonthlyExport` for every company with an accountant. */
export function deliverMonthlyExports(
  now: Date = new Date(),
): Effect.Effect<MonthlyExportRun, DeliveryError, DeliveryDeps> {
  return Effect.gen(function* () {
    const month = previousMonth(nairobiMonth(now));
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<CompanyRef>(
          sql`SELECT organization_id FROM monthly_export_companies()`,
        ),
      ),
    );
    let created = 0;
    let emailed = 0;
    let failed = 0;
    if (rows.length === 0) return { month, created, emailed, failed };
    const baseUrl = yield* apiPublicUrl;
    for (const { organization_id: organizationId } of rows) {
      const exit = yield* Effect.exit(
        deliverCompany(organizationId, month, now, baseUrl),
      );
      if (Exit.isFailure(exit)) {
        failed += 1;
        console.error(
          `[monthly-export] company ${organizationId}, ${month}: export failed`,
          Cause.pretty(exit.cause),
        );
        continue;
      }
      if (exit.value.created) created += 1;
      emailed += exit.value.emailed;
      failed += exit.value.failed;
    }
    return { month, created, emailed, failed };
  });
}
