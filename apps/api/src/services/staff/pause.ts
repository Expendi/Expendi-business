import { eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { StaffConfirmationPurpose } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { CompanySummaryView } from "./companies.js";
import type { ConfirmationRefused } from "./confirmations.js";
import type { StaffMember } from "./staff-auth.js";
import { organizations, platformSettings } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, NotFound } from "../../errors.js";
import { RequestMeta } from "../../http/request-meta.js";
import { AuditLog } from "../audit/audit-log.js";
import { searchCompanies } from "./companies.js";
import {
  issueConfirmation,
  peekConfirmation,
  spendConfirmation,
} from "./confirmations.js";
import { UUID } from "./paging.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * The payout pause (spec §6.15, §7.6): all companies, or one. Pausing never
 * moves money. It takes effect at once: approval and the funding barrier
 * both read the flags under their locks (`isPaused`), so a payout approved
 * or funded after the pause commits is refused with nothing sent.
 *
 * - All companies: the app role can only read `platform_settings`, so the
 *   flag is set through `set_platform_payouts_paused`, which accepts only an
 *   active ops admin and a reason, and audits in the same transaction.
 * - One company: `organizations.payouts_paused`, written in that company's
 *   scope and audited in the same transaction.
 */

export type PauseAction = "pause" | "unpause";

const PURPOSES: Record<PauseAction, StaffConfirmationPurpose> = {
  pause: "pause_payouts",
  unpause: "unpause_payouts",
};

const PLATFORM = "platform";

export interface ControlsView {
  readonly platformPayoutsPaused: boolean;
  readonly platformUpdatedAt: string;
  readonly pausedCompanies: readonly CompanySummaryView[];
}

export function controlsState(): Effect.Effect<
  ControlsView,
  DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const [platform] = yield* withStaffReadScope({}, (tx) =>
      query(() => tx.select().from(platformSettings).limit(1)),
    );
    const paused = yield* searchCompanies({
      pausedOnly: true,
      limit: 200,
    }).pipe(
      Effect.catchTag("BadRequest", () =>
        Effect.dieMessage("company search refused a request without a cursor"),
      ),
    );
    return {
      platformPayoutsPaused: platform?.payoutsPaused ?? true,
      platformUpdatedAt: (platform?.updatedAt ?? new Date(0)).toISOString(),
      pausedCompanies: paused.companies,
    };
  });
}

interface PauseTarget {
  readonly scope: "platform" | "company";
  readonly organization: { readonly id: string; readonly name: string } | null;
  readonly paused: boolean;
}

const noSuchCompany = new NotFound({ message: "No company with this ID" });

function pauseTarget(
  organizationId: string | null,
): Effect.Effect<PauseTarget, NotFound | DatabaseError, DatabaseService> {
  if (organizationId === null) {
    return withStaffReadScope({}, (tx) =>
      query(() => tx.select().from(platformSettings).limit(1)),
    ).pipe(
      Effect.map(([platform]) => ({
        scope: "platform" as const,
        organization: null,
        paused: platform?.payoutsPaused ?? true,
      })),
    );
  }
  if (!UUID.test(organizationId)) return Effect.fail(noSuchCompany);
  return withStaffReadScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({
          id: organizations.id,
          name: organizations.name,
          paused: organizations.payoutsPaused,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId)),
    ),
  ).pipe(
    Effect.flatMap(([company]) =>
      company
        ? Effect.succeed({
            scope: "company" as const,
            organization: { id: company.id, name: company.name },
            paused: company.paused,
          })
        : Effect.fail(noSuchCompany),
    ),
  );
}

const alreadyThere = (action: PauseAction, target: PauseTarget) =>
  new Conflict({
    message: `${target.organization ? `${target.organization.name}'s payouts are` : "Payouts for all companies are"} already ${action === "pause" ? "paused" : "running"}.`,
  });

function consequences(action: PauseAction, target: PauseTarget): string[] {
  const whose = target.organization
    ? `${target.organization.name}'s`
    : "Every company's";
  if (action === "pause") {
    return [
      `${whose} payouts stop the moment you confirm: approvals are refused, and approved payouts whose funding hasn't started fail with nothing sent.`,
      "Payouts already sent aren't affected, and no money moves.",
      "Audited under your name, with your reason.",
    ];
  }
  return [
    `${whose} payouts can be approved again. Unpausing sends nothing: each payout still needs its company admin's approval.`,
    ...(target.scope === "company"
      ? ["A platform-wide pause, if one is on, still applies."]
      : []),
    "Audited under your name, with your reason.",
  ];
}

export interface PreparedPause {
  readonly token: string;
  readonly expiresAt: string;
  readonly action: PauseAction;
  readonly scope: "platform" | "company";
  readonly organization: { readonly id: string; readonly name: string } | null;
  readonly currentlyPaused: boolean;
  readonly reason: string;
  readonly consequences: readonly string[];
}

/** Step one: checks the change makes sense and returns a confirmation token. */
export function preparePause(
  staff: StaffMember,
  action: PauseAction,
  request: { readonly organizationId: string | null; readonly reason: string },
): Effect.Effect<
  PreparedPause,
  NotFound | Conflict | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const target = yield* pauseTarget(request.organizationId);
    if (target.paused === (action === "pause")) {
      return yield* Effect.fail(alreadyThere(action, target));
    }
    const issued = yield* withScope({}, (tx) =>
      issueConfirmation(tx, staff, {
        purpose: PURPOSES[action],
        target: target.organization?.id ?? PLATFORM,
        params: { reason: request.reason },
      }),
    );
    return {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      action,
      scope: target.scope,
      organization: target.organization,
      currentlyPaused: target.paused,
      reason: request.reason,
      consequences: consequences(action, target),
    };
  });
}

export interface PauseResult {
  readonly scope: "platform" | "company";
  readonly organizationId: string | null;
  readonly payoutsPaused: boolean;
}

/** Step two: applies the prepared change, spending the token in the same transaction. */
export function confirmPause(
  staff: StaffMember,
  action: PauseAction,
  token: string,
): Effect.Effect<
  PauseResult,
  ConfirmationRefused | Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  const expected = { purposes: [PURPOSES[action]] } as const;
  const pause = action === "pause";
  return Effect.gen(function* () {
    const prepared = yield* withScope({}, (tx) =>
      peekConfirmation(tx, staff, token, expected),
    );
    const reason = prepared.params.reason ?? "";

    if (prepared.target === PLATFORM) {
      const request = Option.getOrNull(
        yield* Effect.serviceOption(RequestMeta),
      );
      return yield* withScope({}, (tx) =>
        Effect.gen(function* () {
          yield* spendConfirmation(tx, staff, token, {
            ...expected,
            target: PLATFORM,
          });
          const [platform] = yield* query(() =>
            tx.select().from(platformSettings).limit(1),
          );
          if ((platform?.payoutsPaused ?? true) === pause) {
            return yield* Effect.fail(
              alreadyThere(action, {
                scope: "platform",
                organization: null,
                paused: pause,
              }),
            );
          }
          yield* query(() =>
            tx.execute(
              sql`SELECT set_platform_payouts_paused(${pause}, ${staff.staffUserId}::uuid, ${reason}, ${request?.requestId ?? null}, ${request?.ip ?? null}, ${request?.userAgent ?? null})`,
            ),
          );
          return {
            scope: "platform",
            organizationId: null,
            payoutsPaused: pause,
          } as const;
        }),
      );
    }

    const organizationId = prepared.target;
    return yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* spendConfirmation(tx, staff, token, {
          ...expected,
          target: organizationId,
        });
        const [company] = yield* query(() =>
          tx
            .select({
              name: organizations.name,
              paused: organizations.payoutsPaused,
            })
            .from(organizations)
            .where(eq(organizations.id, organizationId))
            .for("update"),
        );
        if (!company) return yield* Effect.fail(noSuchCompany);
        if (company.paused === pause) {
          return yield* Effect.fail(
            alreadyThere(action, {
              scope: "company",
              organization: { id: organizationId, name: company.name },
              paused: pause,
            }),
          );
        }
        yield* query(() =>
          tx
            .update(organizations)
            .set({ payoutsPaused: pause })
            .where(eq(organizations.id, organizationId)),
        );
        yield* audit.record(tx, {
          actor: { type: "staff", id: staff.staffUserId },
          organizationId,
          action: pause
            ? "organization.payouts_paused"
            : "organization.payouts_unpaused",
          entity: { type: "organization", id: organizationId },
          before: { payoutsPaused: company.paused },
          after: { payoutsPaused: pause, reason },
        });
        return {
          scope: "company",
          organizationId,
          payoutsPaused: pause,
        } as const;
      }),
    );
  });
}
