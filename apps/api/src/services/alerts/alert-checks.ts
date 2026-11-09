import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import { formatKesAmount } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { OpsAlertDetail } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { AlertSignal, CheckResult } from "./ops-alerts.js";
import {
  expenses,
  opsAlerts,
  stationHeartbeats,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { nairobiDate } from "../bills/status.js";
import { liveKesRate, readCashCheck } from "../overview/cash-check.js";

/**
 * The six alerts' conditions (spec §6.16), read fresh on every run. No
 * alert carries a secret, a token or an amount a salary could be read
 * from.
 */

export const RECONCILE_JOB = "reconcile-paycrest";
/** The reconciliation job runs every minute; this long without a run is an outage. */
export const RECONCILIATION_STALE_MINUTES = 5;
/** A failed payout is reported if it failed within this window. */
export const FAILED_PAYOUT_WINDOW_HOURS = 24;
/** A webhook-signature incident resolves after this long without another failure. */
export const WEBHOOK_QUIET_MINUTES = 60;
/** Bills and payroll due this many days ahead count against the wallet. */
export const LOW_BALANCE_WINDOW_DAYS = 7;

const SYSTEM_SCOPE = {} as const;

const company = (name: string): OpsAlertDetail => ({
  label: "Company",
  value: name,
});

const WEBHOOK_SOURCES = {
  paycrest: {
    name: "Paycrest",
    whatToCheck:
      "Requests to /webhooks/paycrest are failing their signature check. Check PAYCREST_API_SECRET against Paycrest's dashboard; if it matches, someone else is sending them.",
  },
  lithic: {
    name: "Lithic",
    whatToCheck:
      "Requests to /webhooks/lithic are failing their signature check. Check LITHIC_WEBHOOK_SECRET and LITHIC_ASA_SECRET against Lithic's dashboard; if they match, someone else is sending them.",
  },
} as const;

/** A provider's webhook that failed signature verification, raised by the route. */
export function webhookSignatureFailure(
  source: keyof typeof WEBHOOK_SOURCES,
): AlertSignal {
  const { name, whatToCheck } = WEBHOOK_SOURCES[source];
  return {
    kind: "webhook_signature_failure",
    subjectKey: source,
    organizationId: null,
    title: `${name} webhook failed signature verification`,
    details: [
      { label: "Source", value: `${name} webhook` },
      { label: "What to check", value: whatToCheck },
    ],
  };
}

/**
 * A leaver's Expendi card that Lithic keeps refusing to close, raised by the
 * close-cards job and resolved once it closes. The card goes on working until
 * then, so someone needs to look.
 */
export function cardCloseFailed(card: {
  readonly cardId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly lastFour: string;
  readonly attempts: number;
}): AlertSignal {
  return {
    kind: "card_close_failed",
    subjectKey: card.cardId,
    organizationId: card.organizationId,
    title: `Card ending ${card.lastFour} couldn't be closed at ${card.organizationName}`,
    details: [
      company(card.organizationName),
      { label: "Card", value: card.cardId },
      { label: "Attempts", value: String(card.attempts) },
      {
        label: "What to check",
        value:
          "This card belongs to someone who left the company and it stays usable until Lithic closes it. Check Lithic's status; the job keeps retrying.",
      },
    ],
  };
}

/** The webhook incident stays open while failures keep arriving. */
export function webhookCheck(): Effect.Effect<
  CheckResult,
  DatabaseError,
  DatabaseService
> {
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx
        .select({ subjectKey: opsAlerts.subjectKey })
        .from(opsAlerts)
        .where(
          and(
            eq(opsAlerts.kind, "webhook_signature_failure"),
            isNull(opsAlerts.resolvedAt),
            gt(
              opsAlerts.lastSeenAt,
              sql`now() - make_interval(mins => ${WEBHOOK_QUIET_MINUTES})`,
            ),
          ),
        ),
    ),
  ).pipe(
    Effect.map((rows) => ({
      kind: "webhook_signature_failure" as const,
      firing: [],
      keep: rows.map((row) => row.subjectKey),
    })),
  );
}

/** Fires when the reconciliation job hasn't finished a run in 5 minutes. */
export function reconciliationCheck(): Effect.Effect<
  CheckResult,
  DatabaseError,
  DatabaseService
> {
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx
        .select({
          lastFinishedAt: stationHeartbeats.lastFinishedAt,
          stale: sql<boolean>`${stationHeartbeats.lastFinishedAt} < now() - make_interval(mins => ${RECONCILIATION_STALE_MINUTES})`,
        })
        .from(stationHeartbeats)
        .where(eq(stationHeartbeats.job, RECONCILE_JOB)),
    ),
  ).pipe(
    Effect.map(([heartbeat]) => ({
      kind: "reconciliation_stopped" as const,
      firing:
        heartbeat && !heartbeat.stale
          ? []
          : [
              {
                kind: "reconciliation_stopped" as const,
                subjectKey: RECONCILE_JOB,
                organizationId: null,
                title: "Payout reconciliation has stopped",
                details: [
                  {
                    label: "Last finished run",
                    value: heartbeat?.lastFinishedAt.toISOString() ?? "never",
                  },
                  {
                    label: "What it means",
                    value:
                      "Payouts aren't being checked against Paycrest, so stuck or failed payments go unnoticed until it runs again. Check the API's logs.",
                  },
                ],
              },
            ],
      keep: [],
    })),
  );
}

interface AlertPayoutRow extends Record<string, unknown> {
  readonly payout_id: string;
  readonly organization_id: string;
  readonly organization_name: string;
  readonly status: "needs_review" | "failed";
  readonly subject_type: string;
  readonly payroll: boolean;
  readonly provider_order_id: string | null;
  readonly failure_reason: string | null;
}

function payoutSignal(row: AlertPayoutRow): AlertSignal {
  const review = row.status === "needs_review";
  return {
    kind: review ? "payout_needs_review" : "payout_failed",
    subjectKey: row.payout_id,
    organizationId: row.organization_id,
    title: `${review ? "Payout needs review" : "Payout failed"} at ${row.organization_name}`,
    details: [
      company(row.organization_name),
      { label: "Payout", value: row.payout_id },
      { label: "Paying", value: row.payroll ? "payroll" : row.subject_type },
      ...(row.provider_order_id
        ? [{ label: "Paycrest order", value: row.provider_order_id }]
        : []),
      ...(row.failure_reason
        ? [{ label: "Reason", value: row.failure_reason }]
        : []),
    ],
  };
}

/**
 * "Payout needs review" for every payout in `needs_review`, and "Payout
 * failed" for each payout that failed after approval in the last day.
 */
export function payoutChecks(): Effect.Effect<
  readonly CheckResult[],
  DatabaseError,
  DatabaseService
> {
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx.execute<AlertPayoutRow>(
        sql`SELECT * FROM ops_alert_payouts(now() - make_interval(hours => ${FAILED_PAYOUT_WINDOW_HOURS}))`,
      ),
    ),
  ).pipe(
    Effect.map(({ rows }) => {
      const signals = rows.map(payoutSignal);
      return [
        {
          kind: "payout_needs_review" as const,
          firing: signals.filter(({ kind }) => kind === "payout_needs_review"),
          keep: [],
        },
        {
          kind: "payout_failed" as const,
          firing: signals.filter(({ kind }) => kind === "payout_failed"),
          keep: [],
        },
      ];
    }),
  );
}

interface ZohoCompanyRow extends Record<string, unknown> {
  readonly organization_id: string;
  readonly organization_name: string;
  readonly needs_reconnect: boolean;
  readonly failed_syncs: number;
}

/**
 * Fires per company while Zoho rejects its connection or any of its syncs
 * has run out of retries (T31's `accounting_syncs.status = 'failed'`).
 */
export function zohoCheck(): Effect.Effect<
  CheckResult,
  DatabaseError,
  DatabaseService
> {
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx.execute<ZohoCompanyRow>(sql`SELECT * FROM ops_alert_zoho_companies()`),
    ),
  ).pipe(
    Effect.map(({ rows }) => ({
      kind: "zoho_sync_failing" as const,
      firing: rows.map((row): AlertSignal => ({
        kind: "zoho_sync_failing",
        subjectKey: row.organization_id,
        organizationId: row.organization_id,
        title: `Zoho Books sync failing for ${row.organization_name}`,
        details: [
          company(row.organization_name),
          ...(row.needs_reconnect
            ? [
                {
                  label: "Connection",
                  value:
                    "Zoho rejected it. Syncing is paused until someone reconnects through a new connect link.",
                },
              ]
            : []),
          ...(row.failed_syncs > 0
            ? [
                {
                  label: "Failed syncs",
                  value: `${row.failed_syncs} ran out of retries. Retry them from the company's Zoho page once the cause is fixed.`,
                },
              ]
            : []),
        ],
      })),
      keep: [],
    })),
  );
}

interface BalanceCompanyRow extends Record<string, unknown> {
  readonly organization_id: string;
  readonly organization_name: string;
}

type CompanyBalance =
  | { readonly state: "covered" | "unknown" }
  | {
      readonly state: "short";
      readonly availableKes: bigint;
      readonly unpaidClaims: number;
      readonly obligations: number;
      readonly through: string;
    };

/**
 * The company's spendable wallet against its unpaid claims plus T42's cash
 * check over the next 7 days (bills, payroll runs and salaries not yet
 * drafted). Read as a company reader, as the cash check is.
 */
function companyBalance(
  organizationId: string,
  today: string,
  rate: string | null,
): Effect.Effect<CompanyBalance, DatabaseError, DatabaseService> {
  return withScope({ organizationId, role: "accountant" }, (tx) =>
    Effect.gen(function* () {
      const cash = yield* readCashCheck(
        tx,
        { organizationId, today, days: LOW_BALANCE_WINDOW_DAYS },
        rate,
      );
      const [claims] = yield* query(() =>
        tx
          .select({
            totalKes: sql<string>`coalesce(sum(${expenses.amountKes}), 0)::text`,
            count: sql<number>`count(*)::int`,
          })
          .from(expenses)
          .where(
            and(
              eq(expenses.organizationId, organizationId),
              eq(expenses.kind, "claim"),
              inArray(expenses.status, ["submitted", "payout_failed"]),
            ),
          ),
      );
      const dueKes = cash.totalKes + BigInt(claims?.totalKes ?? "0");
      if (cash.availableKes === null) {
        return dueKes === 0n && cash.unknownAmounts === 0
          ? ({ state: "covered" } as const)
          : ({ state: "unknown" } as const);
      }
      if (dueKes <= cash.availableKes) return { state: "covered" } as const;
      return {
        state: "short",
        availableKes: cash.availableKes,
        unpaidClaims: claims?.count ?? 0,
        obligations: cash.obligations.filter(
          (obligation) => obligation.payVia === "expendi",
        ).length,
        through: cash.through,
      } as const;
    }),
  );
}

/**
 * Fires per company whose wallet holds less than its unpaid claims plus
 * the bills and payroll due in the next 7 days. A company that can't be
 * valued (no Paycrest rate, or its read failed) keeps whatever it had.
 * Only how much is spendable is shown: the total due can reveal payroll.
 */
export function lowBalanceCheck(
  now: Date = new Date(),
): Effect.Effect<CheckResult, DatabaseError, DatabaseService | Paycrest> {
  return Effect.gen(function* () {
    const { rows } = yield* withScope(SYSTEM_SCOPE, (tx) =>
      query(() =>
        tx.execute<BalanceCompanyRow>(
          sql`SELECT * FROM ops_alert_balance_companies()`,
        ),
      ),
    );
    const firing: AlertSignal[] = [];
    const keep: string[] = [];
    if (rows.length === 0) {
      return { kind: "low_company_balance", firing, keep } as const;
    }
    const rate = yield* liveKesRate;
    const today = nairobiDate(now);
    for (const row of rows) {
      const exit = yield* Effect.exit(
        companyBalance(row.organization_id, today, rate),
      );
      if (Exit.isFailure(exit)) {
        console.error(
          `[alerts] balance of company ${row.organization_id} unreadable`,
          Cause.pretty(exit.cause),
        );
        keep.push(row.organization_id);
        continue;
      }
      const balance = exit.value;
      if (balance.state === "unknown") keep.push(row.organization_id);
      if (balance.state !== "short") continue;
      firing.push({
        kind: "low_company_balance",
        subjectKey: row.organization_id,
        organizationId: row.organization_id,
        title: `Low wallet balance at ${row.organization_name}`,
        details: [
          company(row.organization_name),
          {
            label: "Spendable now",
            value: formatKesAmount(balance.availableKes),
          },
          {
            label: "Not covered",
            value: `${balance.unpaidClaims} unpaid claims and ${balance.obligations} bills or payroll runs due by ${balance.through}`,
          },
        ],
      });
    }
    return { kind: "low_company_balance", firing, keep } as const;
  });
}
