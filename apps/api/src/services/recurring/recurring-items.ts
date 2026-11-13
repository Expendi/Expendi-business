import type { SQL } from "drizzle-orm";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";

import type {
  BillCurrency,
  BillStatus,
  CardState,
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
  currencyForPayeeMethod,
  defaultBillHeading,
  OUTSTANDING_BILL_STATUSES,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { BillRow, RecurringItemRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { ActiveCashOutLimits } from "../cash-out/active-limits.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { MerchantLinkChanges, PayingCard } from "./paid-by-card.js";
import {
  bills,
  cards,
  categories,
  payees,
  recurringItems,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { nairobiDate } from "../bills/status.js";
import { lockCardProgram } from "../cards/balance.js";
import {
  activeCashOutLimits,
  checkCashOutAmount,
} from "../cash-out/active-limits.js";
import { createNextRecurringBill, lockOutstandingBills } from "./next-bill.js";
import {
  changedMerchantLinks,
  lockMerchantsToSwitch,
  lockPayingCard,
  moveCardMerchants,
  releaseCardMerchants,
} from "./paid-by-card.js";
import { dueOnOrAfter, firstDueOn } from "./schedule.js";

/**
 * Recurring payments (spec §6.20), for admins only (spec §4): the routes
 * admit admins, and row-level security hides them from any other role.
 *
 * - The payee, schedule and start date are set once. To change them, end
 *   the payment and set up a new one.
 * - Changes to the amount, category, heading, reminder or end date apply to
 *   bills still to come. The bill already created keeps its amount unless
 *   it's changed on the bill itself.
 * - Changing how it's paid, e.g. from outside Expendi to a company-held
 *   card, or to another card, also rewrites the bill still to pay, whose
 *   currency and amount follow the payment's.
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
  readonly currency: BillCurrency;
  readonly amountKes: bigint | null;
  readonly amountUsdc: bigint | null;
  readonly schedule: RecurringSchedule;
  readonly scheduleDay: number;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly payVia: RecurringPayVia;
  /** The company-held card that pays it, exactly when `payVia` is `card`. */
  readonly card: {
    readonly id: string;
    readonly nickname: string;
    readonly lastFour: string;
    readonly state: CardState;
  } | null;
  readonly reminderDays: number;
  readonly active: boolean;
  readonly nextDueOn: string | null;
  readonly nextBill: {
    readonly id: string;
    readonly status: BillStatus;
    readonly dueOn: string;
    readonly currency: BillCurrency;
    readonly amountKes: bigint | null;
    readonly amountUsdc: bigint | null;
    readonly cardDeclinedAt: Date | null;
  } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RecurringItemFilters {
  /** Leaves out salaries, which payroll sets up and pays. */
  readonly excludeSalaries?: boolean | undefined;
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
const pickCard = new BadRequest({
  message: "Pick the company-held card that pays it.",
});
const billBeingPaid = new Conflict({
  message:
    "Its bill is being paid through Expendi. Change how it's paid once that payment finishes.",
});
const changedMeanwhile = new Conflict({
  message:
    "Someone changed how this recurring payment is paid just now. Try again.",
});
const billPaymentFailed = new Conflict({
  message:
    "Its bill's payment through Expendi failed. Retry it, mark it paid or cancel it before changing how it's paid.",
});

const paidOutsideOnly = (payeeName: string) =>
  new BadRequest({
    message: `${payeeName} is paid outside Expendi, so this payment is too.`,
  });

const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

export function recurringItemState(
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
  nextBillCurrency: nextBill.currency,
  nextBillAmountKes: nextBill.amountKes,
  nextBillAmountUsdc: nextBill.amountUsdc,
  nextBillCardDeclinedAt: nextBill.cardDeclinedAt,
  cardNickname: cards.nickname,
  cardLastFour: cards.lastFour,
  cardState: cards.state,
};

/** Each item with its bill still owed; the unique index allows at most one. */
const selectItems = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(itemColumns)
    .from(recurringItems)
    .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
    .innerJoin(categories, eq(categories.id, recurringItems.categoryId))
    .leftJoin(cards, eq(cards.id, recurringItems.cardId))
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
    state: recurringItemState(item),
    payee: {
      id: item.payeeId,
      name: row.payeeName,
      kind: row.payeeKind,
      method: row.payeeMethod,
      archived: row.payeeArchived,
    },
    overviewHeading: item.overviewHeading,
    category: { id: item.categoryId, name: row.categoryName },
    variable: item.amountKes === null && item.amountUsdc === null,
    currency: item.currency,
    amountKes: item.amountKes,
    amountUsdc: item.amountUsdc,
    schedule: item.schedule,
    scheduleDay: item.scheduleDay,
    startsOn: item.startsOn,
    endsOn: item.endsOn,
    payVia: item.payVia,
    card:
      item.cardId === null ||
      row.cardNickname === null ||
      row.cardLastFour === null ||
      row.cardState === null
        ? null
        : {
            id: item.cardId,
            nickname: row.cardNickname,
            lastFour: row.cardLastFour,
            state: row.cardState,
          },
    reminderDays: item.reminderDays,
    active: item.active,
    nextDueOn: item.nextDueOn,
    nextBill:
      row.nextBillId === null ||
      row.nextBillStatus === null ||
      row.nextBillDueOn === null ||
      row.nextBillCurrency === null
        ? null
        : {
            id: row.nextBillId,
            status: row.nextBillStatus,
            dueOn: row.nextBillDueOn,
            currency: row.nextBillCurrency,
            amountKes: row.nextBillAmountKes,
            amountUsdc: row.nextBillAmountUsdc,
            cardDeclinedAt: row.nextBillCardDeclinedAt,
          },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** Active first, then paused, then ended; each by when it's next due. */
export function listRecurringItems(
  tenant: Tenant,
  limit: number,
  filters: RecurringItemFilters = {},
): Effect.Effect<RecurringItemView[], DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      selectItems(
        tx,
        and(
          eq(recurringItems.organizationId, tenant.organizationId),
          filters.excludeSalaries
            ? ne(recurringItems.overviewHeading, "salaries")
            : undefined,
        ),
      )
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

/**
 * A payee paid in USDC is billed in USD, every other payee in KES (spec
 * §6.19), and a payment by company-held card in USD, the card's currency,
 * whoever the payee. An amount typed in the other currency is refused, not
 * converted.
 */
function currencyOf(
  payVia: RecurringPayVia,
  payeeMethod: PayeeMethod | null,
): BillCurrency {
  return payVia === "card" ? "usd" : currencyForPayeeMethod(payeeMethod);
}

function checkCurrency(
  payeeName: string,
  payVia: RecurringPayVia,
  currency: BillCurrency,
  fields: {
    readonly amountKes?: bigint | null | undefined;
    readonly amountUsd?: bigint | null | undefined;
  },
): Effect.Effect<void, BadRequest> {
  const typedIn: BillCurrency | null =
    fields.amountUsd !== undefined && fields.amountUsd !== null
      ? "usd"
      : fields.amountKes !== undefined && fields.amountKes !== null
        ? "kes"
        : null;
  if (typedIn === null || typedIn === currency) return Effect.void;
  const message =
    payVia === "card"
      ? "A payment by company-held card is estimated in USD. Enter the amount in USD."
      : currency === "usd"
        ? `${payeeName} is paid in USDC, so enter the amount in USD.`
        : `${payeeName} is paid in KES, so enter the amount in KES.`;
  return Effect.fail(new BadRequest({ message }));
}

/** The card that's to pay it when `payVia` is `card`, held against closing; otherwise none. */
function payingCardFor(
  tx: Transaction,
  organizationId: string,
  payVia: RecurringPayVia | undefined,
  cardId: string | null | undefined,
): Effect.Effect<PayingCard | null, BadRequest | Conflict | DatabaseError> {
  if (payVia !== "card") return Effect.succeed(null);
  return cardId == null
    ? Effect.fail(pickCard)
    : lockPayingCard(tx, organizationId, cardId);
}

/** The amount columns for `value` in `currency`; the other currency's is null. */
const amountColumns = (currency: BillCurrency, value: bigint | null) => ({
  currency,
  amountKes: currency === "kes" ? value : null,
  amountUsdc: currency === "usd" ? value : null,
});

/** The item's payee's name and method, archived or not. */
function payeeOfItem(
  tx: Transaction,
  row: RecurringItemRow,
): Effect.Effect<
  { readonly name: string; readonly method: PayeeMethod | null },
  DatabaseError
> {
  return query(() =>
    tx
      .select({ name: payees.name, method: payees.method })
      .from(payees)
      .where(
        and(
          eq(payees.organizationId, row.organizationId),
          eq(payees.id, row.payeeId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([payee]) =>
      payee
        ? Effect.succeed(payee)
        : Effect.dieMessage(`recurring item ${row.id} lost its payee`),
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
 * outside Expendi can only have payments made outside it, or by a
 * company-held card.
 */
export function createRecurringItem(
  tenant: Tenant,
  fields: CreateRecurringItemFields,
  now: Date = new Date(),
): Effect.Effect<RecurringItemView, ItemError, ItemDeps | Paycrest> {
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
    const amountKes = fields.variable ? null : (fields.amountKes ?? null);
    const limits =
      amountKes !== null && fields.payVia === "expendi"
        ? yield* activeCashOutLimits
        : null;

    const itemId = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        // The order in `merchants.ts`: a card's first purchase decides which
        // payment its merchant pays under the card program's lock.
        if (fields.payVia === "card") {
          yield* lockCardProgram(tx, organizationId);
        }
        const card = yield* payingCardFor(
          tx,
          organizationId,
          fields.payVia,
          fields.cardId,
        );
        const payee = yield* findPayee(tx, organizationId, fields.payeeId);
        if (payee.method === "outside" && fields.payVia === "expendi") {
          return yield* Effect.fail(paidOutsideOnly(payee.name));
        }
        yield* checkCategory(tx, organizationId, fields.categoryId);
        const currency = currencyOf(fields.payVia, payee.method);
        yield* checkCurrency(payee.name, fields.payVia, currency, fields);
        yield* checkCashOutAmount(payee.method, amountKes, limits);
        const values = {
          payeeId: fields.payeeId,
          overviewHeading:
            fields.overviewHeading ?? defaultBillHeading(payee.kind),
          categoryId: fields.categoryId,
          ...amountColumns(
            currency,
            fields.variable
              ? null
              : (fields.amountKes ?? fields.amountUsd ?? null),
          ),
          ...schedule,
          payVia: fields.payVia,
          cardId: card?.id ?? null,
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
  "payVia",
  "cardId",
  "currency",
  "amountKes",
  "amountUsdc",
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

type BillRewrite = Partial<
  Pick<
    BillRow,
    | "variable"
    | "currency"
    | "amountKes"
    | "amountUsdc"
    | "cardDeclinedAt"
    | "cardDeclineReason"
  >
>;

/** The payment's new currency, and the amount the request typed, if any. */
interface SwitchedCurrency {
  readonly currency: BillCurrency;
  readonly typed: bigint | null | undefined;
  /** Set when it's now paid through Expendi: what one cash-out can send. */
  readonly cashOut: {
    readonly method: PayeeMethod | null;
    readonly limits: ActiveCashOutLimits | null;
  } | null;
}

/**
 * How the payment is paid changed: its bill still to pay forgets a decline
 * by the card that no longer pays it and, if the payment changed its way of
 * paying, moves to the payment's currency. Its amount is then the one typed,
 * or none, which makes it variable; if the currency stays, it keeps its own
 * amount, variable or not. Now paid through Expendi, that amount must be one
 * a cash-out can send, as when a bill is entered. A bill being paid through
 * Expendi, or whose payment failed, has to finish first. Its lock is already
 * held (`lockOutstandingBills`).
 */
function rewriteOutstandingBill(
  tx: Transaction,
  tenant: Tenant,
  itemId: string,
  switched: SwitchedCurrency | null,
): Effect.Effect<void, BadRequest | Conflict | DatabaseError, AuditLog> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const [bill] = yield* query(() =>
      tx
        .select()
        .from(bills)
        .where(
          and(
            eq(bills.organizationId, organizationId),
            eq(bills.recurringItemId, itemId),
            inArray(bills.status, [...OUTSTANDING_BILL_STATUSES]),
          ),
        ),
    );
    if (!bill) return;
    if (bill.status === "paying") return yield* Effect.fail(billBeingPaid);
    if (bill.status === "payout_failed") {
      return yield* Effect.fail(billPaymentFailed);
    }
    const keepsOwn =
      switched !== null &&
      switched.typed === undefined &&
      switched.currency === bill.currency;
    const amounts =
      switched === null
        ? null
        : amountColumns(
            switched.currency,
            switched.typed !== undefined
              ? switched.typed
              : !keepsOwn
                ? null
                : switched.currency === "usd"
                  ? bill.amountUsdc
                  : bill.amountKes,
          );
    if (amounts !== null && switched?.cashOut) {
      yield* checkCashOutAmount(
        switched.cashOut.method,
        amounts.amountKes,
        switched.cashOut.limits,
      );
    }
    const next: BillRewrite = {
      ...(amounts && {
        ...amounts,
        variable: keepsOwn
          ? bill.variable
          : amounts.amountKes === null && amounts.amountUsdc === null,
      }),
      cardDeclinedAt: null,
      cardDeclineReason: null,
    };
    const before: BillRewrite = {};
    const after: BillRewrite = {};
    for (const key of Object.keys(next) as (keyof BillRewrite)[]) {
      if (next[key] !== bill[key]) {
        Object.assign(before, { [key]: bill[key] });
        Object.assign(after, { [key]: next[key] });
      }
    }
    if (Object.keys(after).length === 0) return;
    yield* query(() =>
      tx.update(bills).set(after).where(eq(bills.id, bill.id)),
    );
    yield* audit.record(tx, {
      actor: userActor(tenant),
      organizationId,
      action: "bill.updated",
      entity: { type: "bill", id: bill.id },
      before,
      after,
    });
  });
}

/**
 * Changes what the bills still to come will be. An end date before the
 * next due date ends the payment there. A new amount is in the payee's
 * currency as it is now: if their method changed between KES and USDC,
 * entering it moves the payment to that currency. A payment by
 * company-held card is in USD whoever the payee.
 *
 * Changing how it's paid moves it to that currency. Its amount carries over
 * when the currency stays; otherwise it's the one in the request, or none.
 * The bill still to pay is rewritten to match (`rewriteOutstandingBill`).
 * Leaving a card releases the merchants linked to the payment on it, and
 * moving to another card takes them along (`paid-by-card.ts`).
 */
export function updateRecurringItem(
  tenant: Tenant,
  itemId: string,
  changes: UpdateRecurringItemFields,
): Effect.Effect<RecurringItemView, ItemError, ItemDeps | Paycrest> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const limits =
      (changes.amountKes !== undefined && changes.amountKes !== null) ||
      changes.payVia === "expendi"
        ? yield* activeCashOutLimits
        : null;
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        // The card program, the card, then its merchants, then the bill,
        // then the item: the order in `merchants.ts`, since settling a bill,
        // by card or otherwise, locks the bill before its item.
        if (changes.payVia !== undefined) {
          yield* lockCardProgram(tx, organizationId);
        }
        const card = yield* payingCardFor(
          tx,
          organizationId,
          changes.payVia,
          changes.cardId,
        );
        const lockedCardId =
          changes.payVia === undefined
            ? undefined
            : yield* lockMerchantsToSwitch(
                tx,
                organizationId,
                itemId,
                card?.id ?? null,
              );
        if (changes.payVia !== undefined) {
          yield* lockOutstandingBills(tx, organizationId, itemId);
        }
        const row = yield* lockChangeableItem(tx, organizationId, itemId);
        if (lockedCardId !== undefined && lockedCardId !== row.cardId) {
          return yield* Effect.fail(changedMeanwhile);
        }
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
        const payVia = changes.payVia ?? row.payVia;
        const cardId = payVia === "card" ? (card?.id ?? row.cardId) : null;
        const switching = payVia !== row.payVia;
        const typed =
          changes.amountUsd !== undefined
            ? changes.amountUsd
            : changes.amountKes;
        const priced =
          typed === undefined && !switching
            ? null
            : yield* Effect.gen(function* () {
                const payee = yield* payeeOfItem(tx, row);
                if (
                  switching &&
                  payVia === "expendi" &&
                  payee.method === "outside"
                ) {
                  return yield* Effect.fail(paidOutsideOnly(payee.name));
                }
                const currency = currencyOf(payVia, payee.method);
                yield* checkCurrency(payee.name, payVia, currency, changes);
                const carried =
                  currency !== row.currency
                    ? null
                    : currency === "usd"
                      ? row.amountUsdc
                      : row.amountKes;
                const columns = amountColumns(
                  currency,
                  typed === undefined ? carried : typed,
                );
                if (payVia === "expendi") {
                  yield* checkCashOutAmount(
                    payee.method,
                    columns.amountKes,
                    limits,
                  );
                }
                return { columns, payeeMethod: payee.method };
              });
        const amounts = priced?.columns ?? null;
        const { before, after } = diff(row, {
          ...amounts,
          payVia,
          cardId,
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
        const howPaidChanged = switching || cardId !== row.cardId;
        if (howPaidChanged) {
          yield* rewriteOutstandingBill(
            tx,
            tenant,
            row.id,
            switching && priced !== null
              ? {
                  currency: priced.columns.currency,
                  typed,
                  cashOut:
                    payVia === "expendi"
                      ? { method: priced.payeeMethod, limits }
                      : null,
                }
              : null,
          );
        }
        const merchants: MerchantLinkChanges | null =
          row.cardId === null || !howPaidChanged
            ? null
            : cardId === null
              ? yield* releaseCardMerchants(tx, organizationId, row.id)
              : yield* moveCardMerchants(tx, organizationId, row.id, cardId);
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "recurring_item.updated",
          entity: { type: "recurring_item", id: row.id },
          before,
          after: {
            ...after,
            ...(merchants !== null &&
              changedMerchantLinks(merchants) && { cardMerchants: merchants }),
          },
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
