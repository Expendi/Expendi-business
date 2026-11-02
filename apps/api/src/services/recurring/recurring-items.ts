import type { SQL } from "drizzle-orm";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";

import type {
  BillStatus,
  CreateRecurringItemFields,
  OverviewHeading,
  PayeeKind,
  PayeeMethod,
  RecurringItemState,
  RecurringPayVia,
  RecurringSchedule,
  UpdateRecurringItemFields,
} from "@expendi-business/shared";
import {
  defaultBillHeading,
  OUTSTANDING_BILL_STATUSES,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { RecurringItemRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor } from "../audit/audit-log.js";
import {
  bills,
  categories,
  payees,
  recurringItems,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { nairobiDate } from "../bills/status.js";
import { createNextRecurringBill, lockOutstandingBills } from "./next-bill.js";
import { dueOnOrAfter, firstDueOn } from "./schedule.js";

/**
 * Recurring payments (spec §6.20), for admins only (spec §4): the routes
 * admit admins, and row-level security hides them from any other role.
 *
 * - The payee, schedule, start date and how it's paid are set once. To
 *   change them, end the payment and set up a new one.
 * - Changes to the amount, category, heading, reminder or end date apply to
 *   bills still to come. The bill already created keeps its amount unless
 *   it's changed on the bill itself.
 * - Pausing stops new bills until resumed, and the bills already there
 *   stay. Resuming skips the due dates that passed while paused.
 * - Ending is final; the bills already there stay.
 * - Salaries are recurring payments too, but payroll (T38) sets them up
 *   and changes them, so these routes only read them.
 */

/** `RecurringItem` before serialisation turns bigints and dates into strings. */
export interface RecurringItemView {
  readonly id: string;
  readonly state: RecurringItemState;
  readonly payee: {
    readonly id: string;
    readonly name: string;
    readonly kind: PayeeKind;
    readonly method: PayeeMethod | null;
    readonly archived: boolean;
  };
  readonly overviewHeading: OverviewHeading;
  readonly category: { readonly id: string; readonly name: string };
  readonly variable: boolean;
  readonly amountKes: bigint | null;
  readonly schedule: RecurringSchedule;
  readonly scheduleDay: number;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly payVia: RecurringPayVia;
  readonly reminderDays: number;
  readonly active: boolean;
  readonly nextDueOn: string | null;
  readonly nextBill: {
    readonly id: string;
    readonly status: BillStatus;
    readonly dueOn: string;
    readonly amountKes: bigint | null;
  } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type ItemDeps = DatabaseService | AuditLog;
type ItemError = BadRequest | Conflict | NotFound | DatabaseError;

const itemNotFound = new NotFound({
  message: "That recurring payment wasn't found.",
});
const unknownPayee = new BadRequest({
  message: "Pick one of the company's payees.",
});
const archivedPayee = new BadRequest({
  message: "This payee is archived. Pick another, or add them again.",
});
const unknownCategory = new BadRequest({
  message: "Pick one of the company's categories.",
});
const startsInPast = new BadRequest({
  message: "The start date can't be in the past.",
});
const nothingDue = new BadRequest({
  message: "No payment falls due between the start and end dates.",
});
const endsBeforeStart = new BadRequest({
  message: "The end date can't be before the start date.",
});
const ended = new Conflict({
  message: "This recurring payment has ended, so it can't be changed.",
});
const payroll = new Conflict({
  message: "This is a salary. Change it in payroll.",
});

const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

function stateOf(
  item: Pick<RecurringItemRow, "active" | "nextDueOn">,
): RecurringItemState {
  if (item.nextDueOn === null) return "ended";
  return item.active ? "active" : "paused";
}

// ── Reading ──────────────────────────────────────────────────────────────

const nextBill = alias(bills, "next_bill");

const itemColumns = {
  item: recurringItems,
  payeeName: payees.name,
  payeeKind: payees.kind,
  payeeMethod: payees.method,
  payeeArchived: payees.archived,
  categoryName: categories.name,
  nextBillId: nextBill.id,
  nextBillStatus: nextBill.status,
  nextBillDueOn: nextBill.dueOn,
  nextBillAmountKes: nextBill.amountKes,
};

/** Each item with its bill still owed; the unique index allows at most one. */
const selectItems = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(itemColumns)
    .from(recurringItems)
    .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
    .innerJoin(categories, eq(categories.id, recurringItems.categoryId))
    .leftJoin(
      nextBill,
      and(
        eq(nextBill.recurringItemId, recurringItems.id),
        inArray(nextBill.status, [...OUTSTANDING_BILL_STATUSES]),
      ),
    )
    .where(where);

type SelectedItem = Awaited<ReturnType<typeof selectItems>>[number];

function toView(row: SelectedItem): RecurringItemView {
  const { item } = row;
  return {
    id: item.id,
    state: stateOf(item),
    payee: {
      id: item.payeeId,
      name: row.payeeName,
      kind: row.payeeKind,
      method: row.payeeMethod,
      archived: row.payeeArchived,
    },
    overviewHeading: item.overviewHeading,
    category: { id: item.categoryId, name: row.categoryName },
    variable: item.amountKes === null,
    amountKes: item.amountKes,
    schedule: item.schedule,
    scheduleDay: item.scheduleDay,
    startsOn: item.startsOn,
    endsOn: item.endsOn,
    payVia: item.payVia,
    reminderDays: item.reminderDays,
    active: item.active,
    nextDueOn: item.nextDueOn,
    nextBill:
      row.nextBillId === null ||
      row.nextBillStatus === null ||
      row.nextBillDueOn === null
        ? null
        : {
            id: row.nextBillId,
            status: row.nextBillStatus,
            dueOn: row.nextBillDueOn,
            amountKes: row.nextBillAmountKes,
          },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** Active first, then paused, then ended; each by when it's next due. */
export function listRecurringItems(
  tenant: Tenant,
  limit: number,
): Effect.Effect<RecurringItemView[], DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      selectItems(tx, eq(recurringItems.organizationId, tenant.organizationId))
        .orderBy(
          sql`${recurringItems.nextDueOn} IS NULL`,
          sql`NOT ${recurringItems.active}`,
          sql`coalesce(${nextBill.dueOn}, ${recurringItems.nextDueOn})`,
          asc(recurringItems.createdAt),
          asc(recurringItems.id),
        )
        .limit(limit),
    ).pipe(Effect.map((rows) => rows.map(toView))),
  );
}

export function getRecurringItem(
  tenant: Tenant,
  itemId: string,
): Effect.Effect<RecurringItemView, NotFound | DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      selectItems(
        tx,
        and(
          eq(recurringItems.organizationId, tenant.organizationId),
          eq(recurringItems.id, itemId),
        ),
      ).limit(1),
    ).pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(toView(row)) : Effect.fail(itemNotFound),
      ),
    ),
  );
}

// ── Checks ───────────────────────────────────────────────────────────────

function findPayee(
  tx: Transaction,
  organizationId: string,
  payeeId: string,
): Effect.Effect<
  {
    readonly name: string;
    readonly kind: PayeeKind;
    readonly method: PayeeMethod | null;
  },
  BadRequest | DatabaseError
> {
  return query(() =>
    tx
      .select({
        name: payees.name,
        kind: payees.kind,
        method: payees.method,
        archived: payees.archived,
      })
      .from(payees)
      .where(
        and(eq(payees.organizationId, organizationId), eq(payees.id, payeeId)),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([payee]) => {
      if (!payee) return Effect.fail(unknownPayee);
      return payee.archived
        ? Effect.fail(archivedPayee)
        : Effect.succeed(payee);
    }),
  );
}

function checkCategory(
  tx: Transaction,
  organizationId: string,
  categoryId: string,
): Effect.Effect<void, BadRequest | DatabaseError> {
  return query(() =>
    tx
      .select({ archived: categories.archived })
      .from(categories)
      .where(
        and(
          eq(categories.organizationId, organizationId),
          eq(categories.id, categoryId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([category]) =>
      category && !category.archived
        ? Effect.void
        : Effect.fail(unknownCategory),
    ),
  );
}

/** An item that hasn't ended: it still has a next due date. */
type ScheduledItem = RecurringItemRow & { readonly nextDueOn: string };

/** The item, locked for the rest of the transaction; ended items and salaries can't change here. */
function lockChangeableItem(
  tx: Transaction,
  organizationId: string,
  itemId: string,
): Effect.Effect<ScheduledItem, NotFound | Conflict | DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(recurringItems)
      .where(
        and(
          eq(recurringItems.organizationId, organizationId),
          eq(recurringItems.id, itemId),
        ),
      )
      .for("update"),
  ).pipe(
    Effect.flatMap(
      ([row]): Effect.Effect<ScheduledItem, NotFound | Conflict> => {
        if (!row) return Effect.fail(itemNotFound);
        if (row.overviewHeading === "salaries") return Effect.fail(payroll);
        const { nextDueOn } = row;
        return nextDueOn === null
          ? Effect.fail(ended)
          : Effect.succeed({ ...row, nextDueOn });
      },
    ),
  );
}

const later = (a: string, b: string): string => (a > b ? a : b);
const earlier = (a: string, b: string): string => (a < b ? a : b);

// ── Changes ──────────────────────────────────────────────────────────────

/**
 * Sets up a recurring payment and creates its first bill, due on the
 * schedule's first date on or after the start (spec §6.20). A payee paid
 * outside Expendi can only have payments made outside it.
 */
export function createRecurringItem(
  tenant: Tenant,
  fields: CreateRecurringItemFields,
  now: Date = new Date(),
): Effect.Effect<RecurringItemView, ItemError, ItemDeps> {
  const { organizationId } = tenant;
  const today = nairobiDate(now);
  return Effect.gen(function* () {
    if (fields.startsOn < today) return yield* Effect.fail(startsInPast);
    const schedule = {
      schedule: fields.schedule,
      scheduleDay: fields.scheduleDay,
      startsOn: fields.startsOn,
      endsOn: fields.endsOn ?? null,
    };
    const nextDueOn = firstDueOn(schedule);
    if (nextDueOn === null) return yield* Effect.fail(nothingDue);

    const itemId = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const payee = yield* findPayee(tx, organizationId, fields.payeeId);
        if (payee.method === "outside" && fields.payVia === "expendi") {
          return yield* Effect.fail(
            new BadRequest({
              message: `${payee.name} is paid outside Expendi, so this payment is too.`,
            }),
          );
        }
        yield* checkCategory(tx, organizationId, fields.categoryId);
        const values = {
          payeeId: fields.payeeId,
          overviewHeading:
            fields.overviewHeading ?? defaultBillHeading(payee.kind),
          categoryId: fields.categoryId,
          amountKes: fields.variable ? null : (fields.amountKes ?? null),
          ...schedule,
          payVia: fields.payVia,
          reminderDays: fields.reminderDays,
          nextDueOn,
        };
        const [created] = yield* query(() =>
          tx
            .insert(recurringItems)
            .values({ organizationId, ...values })
            .returning({ id: recurringItems.id }),
        );
        if (!created) {
          return yield* Effect.dieMessage("recurring item insert wrote no row");
        }
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "recurring_item.created",
          entity: { type: "recurring_item", id: created.id },
          after: values,
        });
        yield* createNextRecurringBill(tx, organizationId, created.id, today);
        return created.id;
      }),
    );
    return yield* getRecurringItem(tenant, itemId);
  });
}

const CHANGEABLE = [
  "amountKes",
  "categoryId",
  "overviewHeading",
  "reminderDays",
  "endsOn",
  "nextDueOn",
] as const satisfies readonly (keyof RecurringItemRow)[];

type ItemChanges = Partial<Pick<RecurringItemRow, (typeof CHANGEABLE)[number]>>;

/** The fields that differ, as they were and as they'll be, for the audit log. */
function diff(
  row: RecurringItemRow,
  next: ItemChanges,
): { before: ItemChanges; after: ItemChanges } {
  const before: ItemChanges = {};
  const after: ItemChanges = {};
  const compare = <K extends keyof ItemChanges>(key: K) => {
    const value = next[key];
    if (value !== undefined && value !== row[key]) {
      before[key] = row[key];
      after[key] = value;
    }
  };
  CHANGEABLE.forEach(compare);
  return { before, after };
}

/**
 * Changes what the bills still to come will be. An end date before the
 * next due date ends the payment there.
 */
export function updateRecurringItem(
  tenant: Tenant,
  itemId: string,
  changes: UpdateRecurringItemFields,
): Effect.Effect<RecurringItemView, ItemError, ItemDeps> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockChangeableItem(tx, organizationId, itemId);
        if (
          changes.categoryId !== undefined &&
          changes.categoryId !== row.categoryId
        ) {
          yield* checkCategory(tx, organizationId, changes.categoryId);
        }
        const endsOn =
          changes.endsOn === undefined ? row.endsOn : changes.endsOn;
        if (endsOn !== null && endsOn < row.startsOn) {
          return yield* Effect.fail(endsBeforeStart);
        }
        const { before, after } = diff(row, {
          amountKes: changes.amountKes,
          categoryId: changes.categoryId,
          overviewHeading: changes.overviewHeading,
          reminderDays: changes.reminderDays,
          endsOn: changes.endsOn,
          nextDueOn:
            endsOn !== null && row.nextDueOn > endsOn ? null : undefined,
        });
        if (Object.keys(after).length === 0) return;

        yield* query(() =>
          tx
            .update(recurringItems)
            .set(after)
            .where(eq(recurringItems.id, row.id)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "recurring_item.updated",
          entity: { type: "recurring_item", id: row.id },
          before,
          after,
        });
      }),
    );
    return yield* getRecurringItem(tenant, itemId);
  });
}

/** Stops new bills until resumed; the bills already there stay. */
export function pauseRecurringItem(
  tenant: Tenant,
  itemId: string,
): Effect.Effect<RecurringItemView, ItemError, ItemDeps> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockChangeableItem(tx, organizationId, itemId);
        if (!row.active) {
          return yield* Effect.fail(
            new Conflict({
              message: "This recurring payment is already paused.",
            }),
          );
        }
        yield* query(() =>
          tx
            .update(recurringItems)
            .set({ active: false })
            .where(eq(recurringItems.id, row.id)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "recurring_item.paused",
          entity: { type: "recurring_item", id: row.id },
          before: { active: true },
          after: { active: false },
        });
      }),
    );
    return yield* getRecurringItem(tenant, itemId);
  });
}

/**
 * Starts creating bills again from the first due date on or after today:
 * the dates that passed while it was paused are skipped. If it has no bill
 * still owed, its next one is created now.
 */
export function resumeRecurringItem(
  tenant: Tenant,
  itemId: string,
  now: Date = new Date(),
): Effect.Effect<RecurringItemView, ItemError, ItemDeps> {
  const { organizationId } = tenant;
  const today = nairobiDate(now);
  return Effect.gen(function* () {
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* lockOutstandingBills(tx, organizationId, itemId);
        const row = yield* lockChangeableItem(tx, organizationId, itemId);
        if (row.active) {
          return yield* Effect.fail(
            new Conflict({ message: "This recurring payment isn't paused." }),
          );
        }
        const nextDueOn = dueOnOrAfter(row, later(row.nextDueOn, today));
        if (nextDueOn === null) {
          return yield* Effect.fail(
            new Conflict({
              message:
                "Its end date has passed, so there's nothing to resume. End it instead.",
            }),
          );
        }
        yield* query(() =>
          tx
            .update(recurringItems)
            .set({ active: true, nextDueOn })
            .where(eq(recurringItems.id, row.id)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "recurring_item.resumed",
          entity: { type: "recurring_item", id: row.id },
          before: { active: false, nextDueOn: row.nextDueOn },
          after: { active: true, nextDueOn },
        });
        yield* createNextRecurringBill(tx, organizationId, row.id, today);
      }),
    );
    return yield* getRecurringItem(tenant, itemId);
  });
}

/**
 * Ends the payment for good: no more bills. Its end date becomes today,
 * unless it was earlier (or the payment hasn't started). The bills already
 * there stay.
 */
export function endRecurringItem(
  tenant: Tenant,
  itemId: string,
  now: Date = new Date(),
): Effect.Effect<RecurringItemView, ItemError, ItemDeps> {
  const { organizationId } = tenant;
  const today = nairobiDate(now);
  return Effect.gen(function* () {
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockChangeableItem(tx, organizationId, itemId);
        const endsOn = later(row.startsOn, earlier(row.endsOn ?? today, today));
        yield* query(() =>
          tx
            .update(recurringItems)
            .set({ endsOn, nextDueOn: null })
            .where(eq(recurringItems.id, row.id)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "recurring_item.ended",
          entity: { type: "recurring_item", id: row.id },
          before: { endsOn: row.endsOn, nextDueOn: row.nextDueOn },
          after: { endsOn, nextDueOn: null },
        });
      }),
    );
    return yield* getRecurringItem(tenant, itemId);
  });
}
