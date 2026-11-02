import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { and, eq, gt } from "drizzle-orm";
import { Cause, Effect } from "effect";

import type { PayrollMarginChange } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type {
  ApprovalChallenge,
  ApprovalSettings,
} from "../approval/passkeys.js";
import {
  memberships,
  organizations,
  payrollRuns,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Forbidden } from "../../errors.js";
import {
  canonicalJson,
  sha256Hex,
  startApproval,
  verifyApproval,
} from "../approval/passkeys.js";
import { AuditLog } from "../audit/audit-log.js";
import { EmailSender } from "../email/email-sender.js";
import { payrollMarginEmail } from "../email/payroll-margin-email.js";
import { activeAdminRecipients } from "../payees/payees.js";
import { payrollCapKes } from "./cap.js";

/**
 * The payroll cap's margin (spec §7.4): a run may pay its salaries plus
 * this percentage, 20% by default. Changing it needs the admin's passkey,
 * bound to the exact new margin, is audited and emails every admin, as a
 * salary change does. Draft runs take the new cap at once; runs already
 * approved keep theirs.
 */

export interface PendingPayrollMarginChange extends ApprovalChallenge {
  readonly status: "confirmation_required";
  readonly change: PayrollMarginChange;
}

type MarginDeps = DatabaseService | AuditLog | ApprovalSettings;

const notAdmin = new Forbidden({
  message: "Only an admin of this company can change the payroll margin.",
});

/** What the passkey signs: the company and exactly this margin. */
export function payrollMarginIntentHash(
  organizationId: string,
  change: PayrollMarginChange,
): string {
  return sha256Hex(
    canonicalJson({
      version: 1,
      kind: "payroll_margin",
      organizationId,
      change,
    }),
  );
}

function requireActiveAdmin(
  tx: Transaction,
  tenant: Tenant,
): Effect.Effect<void, Forbidden | DatabaseError> {
  return query(() =>
    tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, tenant.organizationId),
          eq(memberships.userId, tenant.userId),
          eq(memberships.role, "admin"),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([membership]) =>
      membership ? Effect.void : Effect.fail(notAdmin),
    ),
  );
}

function currentMargin(
  tx: Transaction,
  organizationId: string,
  lock: boolean,
): Effect.Effect<
  { readonly marginPct: number; readonly name: string },
  DatabaseError
> {
  const select = tx
    .select({
      marginPct: organizations.payrollCapMarginPct,
      name: organizations.name,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return query(() => (lock ? select.for("update") : select)).pipe(
    Effect.flatMap(([company]) =>
      company
        ? Effect.succeed(company)
        : Effect.dieMessage(`company ${organizationId} not found`),
    ),
  );
}

export function getPayrollMargin(
  tenant: Tenant,
): Effect.Effect<
  { readonly marginPct: number },
  DatabaseError,
  DatabaseService
> {
  return withScope(tenant, (tx) =>
    currentMargin(tx, tenant.organizationId, false).pipe(
      Effect.map(({ marginPct }) => ({ marginPct })),
    ),
  );
}

/** Asks for the admin's passkey; nothing changes until it's confirmed. */
export function requestPayrollMarginChange(
  tenant: Tenant,
  marginPct: number,
): Effect.Effect<
  PendingPayrollMarginChange,
  BadRequest | Forbidden | DatabaseError,
  MarginDeps
> {
  return Effect.gen(function* () {
    const current = yield* withScope(tenant, (tx) =>
      requireActiveAdmin(tx, tenant).pipe(
        Effect.zipRight(currentMargin(tx, tenant.organizationId, false)),
      ),
    );
    if (current.marginPct === marginPct) {
      return yield* Effect.fail(
        new BadRequest({ message: "That's already the payroll margin." }),
      );
    }
    const change = { marginPct };
    const challenge = yield* startApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      purpose: "change_payroll_margin",
      intentHash: payrollMarginIntentHash(tenant.organizationId, change),
    });
    return { status: "confirmation_required", ...challenge, change };
  });
}

interface MarginNotice {
  readonly recipients: readonly {
    readonly userId: string;
    readonly email: string;
  }[];
  readonly companyName: string;
  readonly actorName: string;
  readonly beforePct: number;
  readonly afterPct: number;
}

/**
 * Best effort, after the commit: a failed email never undoes the change
 * and is logged with the admin's user ID only.
 */
function sendNotice(
  notice: MarginNotice,
): Effect.Effect<void, never, EmailSender> {
  return Effect.forEach(
    notice.recipients,
    ({ userId, email }) =>
      Effect.flatMap(EmailSender, (sender) =>
        sender.send(payrollMarginEmail({ ...notice, to: email })),
      ).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            console.error(
              `[payroll] margin email to admin ${userId} not sent`,
              Cause.pretty(cause),
            );
          }),
        ),
      ),
    { discard: true },
  );
}

/**
 * Applies the new margin once the admin's passkey has confirmed exactly
 * it. The change is sent again with the signature; if it differs from
 * what was challenged, nothing happens. Draft runs are capped again from
 * their drafted salaries. Audited, and every admin is emailed.
 */
export function confirmPayrollMarginChange(
  tenant: Tenant,
  input: {
    readonly challengeId: string;
    readonly response: AuthenticationResponseJSON;
    readonly change: PayrollMarginChange;
  },
): Effect.Effect<
  { readonly marginPct: number },
  Forbidden | DatabaseError,
  MarginDeps | EmailSender
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const approval = yield* verifyApproval({
      organizationId,
      userId: tenant.userId,
      purpose: "change_payroll_margin",
      challengeId: input.challengeId,
      response: input.response,
    });
    if (
      payrollMarginIntentHash(organizationId, input.change) !==
      approval.intentHash
    ) {
      return yield* Effect.fail(
        new Forbidden({
          message: "That isn't the change you confirmed. Confirm again.",
        }),
      );
    }
    const afterPct = input.change.marginPct;
    const audit = yield* AuditLog;
    const actor = { type: "user", id: tenant.userId } as const;

    const notice = yield* withScope({ ...tenant, role: "admin" }, (tx) =>
      Effect.gen(function* () {
        yield* requireActiveAdmin(tx, tenant);
        const company = yield* currentMargin(tx, organizationId, true);
        if (company.marginPct === afterPct) return null;
        yield* query(() =>
          tx
            .update(organizations)
            .set({ payrollCapMarginPct: afterPct })
            .where(eq(organizations.id, organizationId)),
        );
        yield* audit.record(tx, {
          actor,
          organizationId,
          action: "organization.payroll_margin_changed",
          entity: { type: "organization", id: organizationId },
          before: { payrollCapMarginPct: company.marginPct },
          after: {
            payrollCapMarginPct: afterPct,
            approvalId: approval.approvalId,
          },
        });
        const drafts = yield* query(() =>
          tx
            .select()
            .from(payrollRuns)
            .where(
              and(
                eq(payrollRuns.organizationId, organizationId),
                eq(payrollRuns.status, "draft"),
                gt(payrollRuns.salariesKes, 0n),
              ),
            )
            .for("update"),
        );
        for (const run of drafts) {
          const capKes = payrollCapKes(run.salariesKes, afterPct);
          if (capKes === run.capKes) continue;
          yield* query(() =>
            tx
              .update(payrollRuns)
              .set({ capKes })
              .where(eq(payrollRuns.id, run.id)),
          );
          yield* audit.record(tx, {
            actor,
            organizationId,
            action: "payroll_run.cap_changed",
            entity: { type: "payroll_run", id: run.id },
            before: { capKes: run.capKes },
            after: {
              capKes,
              salariesKes: run.salariesKes,
              payrollCapMarginPct: afterPct,
            },
          });
        }
        const [person] = yield* query(() =>
          tx
            .select({ fullName: users.fullName, email: users.email })
            .from(users)
            .where(eq(users.id, tenant.userId)),
        );
        return {
          recipients: yield* activeAdminRecipients(tx, organizationId),
          companyName: company.name,
          actorName: person?.fullName ?? person?.email ?? "An admin",
          beforePct: company.marginPct,
          afterPct,
        } satisfies MarginNotice;
      }),
    );
    if (notice) yield* sendNotice(notice);
    return { marginPct: afterPct };
  });
}
