import { sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import type { CashOutProvider } from "@expendi-business/shared";
import {
  CASH_OUT_PROVIDERS,
  cashOutProviderSchema,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { CashOutReadiness } from "../cash-out/readiness.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import type { ConfirmationRefused } from "./confirmations.js";
import type { StaffMember } from "./staff-auth.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict } from "../../errors.js";
import { RequestMeta } from "../../http/request-meta.js";
import { activeCashOutProvider } from "../cash-out/active-provider.js";
import { CASH_OUT_BANKS } from "../cash-out/banks.js";
import { cashOutLimits } from "../cash-out/quote.js";
import { cashOutProviderReadiness } from "../cash-out/readiness.js";
import {
  issueConfirmation,
  peekConfirmation,
  spendConfirmation,
} from "./confirmations.js";
import { isoUtc } from "./paging.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * The active cash-out provider (docs/decisions/pretium-cash-out-provider.md):
 * one setting for every company, changed like the platform pause. The app
 * role can only read `platform_settings`, so the change goes through
 * `set_active_cash_out_provider`, which accepts only an active ops admin and
 * a reason, and audits in the same transaction. A change is refused unless
 * the target provider is ready, checked when preparing and again when
 * confirming. Changing it moves no money: a cash-out takes its provider when
 * an admin approves it.
 */

const PURPOSE = "change_cash_out_provider" as const;
const PLATFORM = "platform";
const AUDIT_ACTION = "platform.cash_out_provider_changed";

const NAMES: Record<CashOutProvider, string> = {
  paycrest: "Paycrest",
  pretium: "Pretium",
};

export interface CashOutProviderReadinessView extends CashOutReadiness {
  readonly provider: CashOutProvider;
  readonly active: boolean;
}

export interface CashOutProviderControlView {
  readonly activeProvider: CashOutProvider;
  readonly changedAt: string | null;
  readonly providers: readonly CashOutProviderReadinessView[];
}

function lastChange(
  tx: Transaction,
): Effect.Effect<string | null, DatabaseError> {
  return query(() =>
    tx.execute<{ changed_at: string }>(sql`
      SELECT ${isoUtc(sql`entry.occurred_at`)} AS changed_at
      FROM staff_search_audit_log(
        NULL::uuid, NULL::audit_actor_type, NULL::text, ${AUDIT_ACTION}::text,
        NULL::text, NULL::text, NULL::text, NULL::date, NULL::date,
        NULL::timestamptz, NULL::uuid, 1::integer
      ) AS entry`),
  ).pipe(Effect.map(({ rows: [row] }) => row?.changed_at ?? null));
}

/** What's active, when it last changed, and each provider's readiness now. */
export function cashOutProviderControl(): Effect.Effect<
  CashOutProviderControlView,
  DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  return Effect.all(
    [
      withStaffReadScope({}, (tx) =>
        Effect.all([activeCashOutProvider(tx), lastChange(tx)]),
      ),
      Effect.forEach(CASH_OUT_PROVIDERS, cashOutProviderReadiness, {
        concurrency: "unbounded",
      }),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([[activeProvider, changedAt], readiness]) => ({
      activeProvider,
      changedAt,
      providers: CASH_OUT_PROVIDERS.map((provider, index) => ({
        provider,
        active: provider === activeProvider,
        ready: readiness[index]?.ready ?? false,
        problems: readiness[index]?.problems ?? [],
      })),
    })),
  );
}

const PAGE_ROWS = 200;
/** Enough for any real backlog; past it the counts are lower bounds. */
const MAX_PAGES = 50;

interface CashOutCounts {
  readonly waitingForApproval: number;
  readonly inFlight: Record<CashOutProvider, number>;
  /** False when there were more than MAX_PAGES pages to count. */
  readonly complete: boolean;
}

interface QueueRow extends Record<string, unknown> {
  readonly payout_id: string;
  readonly created_at: string;
  readonly provider: string;
  readonly status: string;
}

const isCashOutProvider = (provider: string): provider is CashOutProvider =>
  cashOutProviderSchema.safeParse(provider).success;

interface QueueCursor {
  readonly at: string;
  readonly id: string;
}

const COUNTED_STATUSES = sql`ARRAY['awaiting_approval', 'approved',
  'order_created', 'funding', 'paying']::payout_status[]`;

function queuePage(
  tx: Transaction,
  cursor: QueueCursor | null,
): Effect.Effect<readonly QueueRow[], DatabaseError> {
  return query(() =>
    tx.execute<QueueRow>(sql`
      SELECT q.payout_id, q.provider::text AS provider,
             q.status::text AS status,
             ${isoUtc(sql`q.created_at`)} AS created_at
      FROM staff_payout_queue(
        ${COUNTED_STATUSES}, NULL::uuid, ${cursor?.at ?? null}::timestamptz,
        ${cursor?.id ?? null}::uuid, ${PAGE_ROWS}::integer
      ) AS q`),
  ).pipe(Effect.map(({ rows }) => rows));
}

/**
 * Cash-outs at every company that a change would affect, read page by page
 * through `staff_payout_queue`, the one cross-company way to read payouts.
 */
function countCashOuts(): Effect.Effect<
  CashOutCounts,
  DatabaseError,
  DatabaseService
> {
  return withStaffReadScope({}, (tx) =>
    Effect.gen(function* () {
      let waitingForApproval = 0;
      const inFlight: Record<CashOutProvider, number> = {
        paycrest: 0,
        pretium: 0,
      };
      let cursor: QueueCursor | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const rows: readonly QueueRow[] = yield* queuePage(tx, cursor);
        for (const row of rows) {
          if (!isCashOutProvider(row.provider)) continue;
          if (row.status === "awaiting_approval") waitingForApproval += 1;
          else inFlight[row.provider] += 1;
        }
        const last = rows.at(-1);
        if (rows.length < PAGE_ROWS || !last) {
          return { waitingForApproval, inFlight, complete: true };
        }
        cursor = { at: last.created_at, id: last.payout_id };
      }
      return { waitingForApproval, inFlight, complete: false };
    }),
  );
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-KE")} ${count === 1 ? one : many}`;

function consequences(
  provider: CashOutProvider,
  current: CashOutProvider,
  counts: CashOutCounts,
): string[] {
  const name = NAMES[provider];
  const atLeast = counts.complete ? "" : "At least ";
  const waiting = counts.waitingForApproval;
  const inFlight = counts.inFlight.paycrest + counts.inFlight.pretium;
  const lines = [
    `Every company's new cash-outs go through ${name} instead of ${NAMES[current]} from the moment you confirm. Rates and fees shown in the apps follow ${name}.`,
    waiting === 0 && counts.complete
      ? `No cash-outs are waiting for approval.`
      : `${atLeast}${plural(waiting, "cash-out", "cash-outs")} waiting for approval will go through ${name} when approved.`,
    inFlight === 0 && counts.complete
      ? `No cash-outs are approved or in flight.`
      : `${atLeast}${plural(inFlight, "cash-out", "cash-outs")} already approved or in flight finish with the provider they have (${counts.inFlight.paycrest.toLocaleString("en-KE")} with Paycrest, ${counts.inFlight.pretium.toLocaleString("en-KE")} with Pretium).`,
  ];
  if (provider === "pretium") {
    const unpayable = CASH_OUT_BANKS.filter(
      (bank) => bank.pretiumCode === null,
    ).length;
    const maxShillings = cashOutLimits("pretium").maxKesCents / 100n;
    lines.push(
      `${unpayable} of the ${CASH_OUT_BANKS.length} banks in Expendi's catalogue can't be paid through Pretium: a cash-out to one of them is refused before anything is sent.`,
      `Pretium pays at most KES ${maxShillings.toLocaleString("en-KE")} in one cash-out, so payroll splits larger salaries into smaller cash-outs.`,
    );
  }
  lines.push(
    "No money moves now, and nothing switches back by itself: if the new provider stops answering, change it back here.",
    "Audited under your name, with your reason.",
  );
  return lines;
}

const alreadyActive = (provider: CashOutProvider) =>
  new Conflict({
    message: `${NAMES[provider]} is already the active cash-out provider.`,
  });

const notReady = (provider: CashOutProvider, readiness: CashOutReadiness) =>
  new Conflict({
    message: `${NAMES[provider]} isn't ready to take cash-outs: ${readiness.problems.join(" ")}`,
    details: { problems: readiness.problems },
  });

/** Fails unless cash-outs could go through `provider` right now. */
function requireReady(
  provider: CashOutProvider,
): Effect.Effect<void, Conflict, Paycrest | Pretium> {
  return cashOutProviderReadiness(provider).pipe(
    Effect.flatMap((readiness) =>
      readiness.ready
        ? Effect.void
        : Effect.fail(notReady(provider, readiness)),
    ),
  );
}

export interface PreparedCashOutProviderChange {
  readonly token: string;
  readonly expiresAt: string;
  readonly provider: CashOutProvider;
  readonly currentProvider: CashOutProvider;
  readonly reason: string;
  readonly waitingForApproval: number;
  readonly inFlight: Readonly<Record<CashOutProvider, number>>;
  readonly consequences: readonly string[];
}

/**
 * Step one: checks the change makes sense and the provider is ready, and
 * returns a confirmation token. A provider that isn't ready gets no token.
 */
export function prepareCashOutProviderChange(
  staff: StaffMember,
  request: { readonly provider: CashOutProvider; readonly reason: string },
): Effect.Effect<
  PreparedCashOutProviderChange,
  Conflict | DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  const { provider, reason } = request;
  return Effect.gen(function* () {
    const current = yield* withStaffReadScope({}, activeCashOutProvider);
    if (current === provider) {
      return yield* Effect.fail(alreadyActive(provider));
    }
    const [counts] = yield* Effect.all(
      [countCashOuts(), requireReady(provider)],
      { concurrency: "unbounded" },
    );
    const issued = yield* withScope({}, (tx) =>
      issueConfirmation(tx, staff, {
        purpose: PURPOSE,
        target: PLATFORM,
        params: { provider, reason },
      }),
    );
    return {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      provider,
      currentProvider: current,
      reason,
      waitingForApproval: counts.waitingForApproval,
      inFlight: counts.inFlight,
      consequences: consequences(provider, current, counts),
    };
  });
}

export interface CashOutProviderChange {
  readonly activeProvider: CashOutProvider;
  readonly previousProvider: CashOutProvider;
}

/**
 * Step two: checks the provider is still ready, then applies the prepared
 * change, spending the token in the same transaction. Readiness is checked
 * before that transaction so no provider call holds the token's row lock;
 * any refusal leaves the token unspent, as the pause does.
 */
export function confirmCashOutProviderChange(
  staff: StaffMember,
  token: string,
): Effect.Effect<
  CashOutProviderChange,
  ConfirmationRefused | Conflict | DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  const expected = { purposes: [PURPOSE], target: PLATFORM } as const;
  return Effect.gen(function* () {
    const prepared = yield* withScope({}, (tx) =>
      peekConfirmation(tx, staff, token, expected),
    );
    const parsed = cashOutProviderSchema.safeParse(prepared.params.provider);
    if (!parsed.success) {
      return yield* Effect.dieMessage(
        "a change_cash_out_provider confirmation has no provider",
      );
    }
    const provider = parsed.data;
    const reason = prepared.params.reason ?? "";
    yield* requireReady(provider);

    const request = Option.getOrNull(yield* Effect.serviceOption(RequestMeta));
    return yield* withScope({}, (tx) =>
      Effect.gen(function* () {
        yield* spendConfirmation(tx, staff, token, expected);
        if ((yield* activeCashOutProvider(tx)) === provider) {
          return yield* Effect.fail(alreadyActive(provider));
        }
        const { rows } = yield* query(() =>
          tx.execute<{ previous: CashOutProvider }>(
            sql`SELECT set_active_cash_out_provider(${provider}::cash_out_provider, ${staff.staffUserId}::uuid, ${reason}, ${request?.requestId ?? null}, ${request?.ip ?? null}, ${request?.userAgent ?? null}) AS previous`,
          ),
        );
        const previous = rows[0]?.previous;
        if (previous === undefined) {
          return yield* Effect.dieMessage(
            "set_active_cash_out_provider returned no row",
          );
        }
        return { activeProvider: provider, previousProvider: previous };
      }),
    );
  });
}
