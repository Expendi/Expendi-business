import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { ImportReport, ImportRequest } from "@expendi-business/shared";

import type {
  NewBill,
  NewExpense,
  NewFloat,
  NewPayee,
  NewRecurringItem,
} from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { StaffMember } from "../staff/staff-auth.js";
import {
  bills,
  categories,
  expenses,
  floats,
  importRows,
  importRuns,
  memberships,
  organizations,
  payees,
  recurringItems,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { expenseWarnings, nairobiToday } from "../expenses/rules.js";
import {
  cleanValues,
  importAmount,
  importDate,
  mappedRows,
  optionalValue,
  payeeKind,
  required,
  schedule,
  validateImportStatus,
} from "./parse.js";

type Action =
  | { table: "payee"; data: NewPayee }
  | { table: "recurring"; data: NewRecurringItem }
  | { table: "bill"; data: NewBill }
  | { table: "expense"; data: NewExpense }
  | { table: "float"; data: NewFloat };
interface PlannedRow {
  report: ImportReport["rows"][number];
  hash: string;
  action: Action | null;
}
const encode = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
const hash = (value: unknown): string =>
  createHash("sha256").update(encode(value)).digest("hex");
// A preview writes nothing. Tokens expire on restart (or a different replica),
// in which case staff preview again; no persisted signing secret is needed.
const previewKey = randomBytes(32);
const signature = (digest: string, expires: string) =>
  createHmac("sha256", previewKey).update(`${digest}:${expires}`).digest("hex");
const issueToken = (digest: string) => {
  const expires = String(Date.now() + 30 * 60_000);
  return `${expires}.${signature(digest, expires)}`;
};
function validToken(token: string, digest: string): boolean {
  const [expires = "", sig = ""] = token.split(".");
  if (
    !/^\d{13}$/.test(expires) ||
    Number(expires) < Date.now() ||
    !/^[a-f0-9]{64}$/.test(sig)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(sig, "hex"),
    Buffer.from(signature(digest, expires), "hex"),
  );
}

function oldestHistoryDate(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 3);
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

function loadContext(tx: Transaction, organizationId: string) {
  return Effect.gen(function* () {
    const [company] = yield* query(() =>
      tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId)),
    );
    if (!company)
      return yield* Effect.fail(
        new NotFound({ message: "Company not found." }),
      );
    const people = yield* query(() =>
      tx
        .select({
          id: memberships.id,
          role: memberships.role,
          email: users.email,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            ne(memberships.status, "removed"),
          ),
        ),
    );
    const categoryRows = yield* query(() =>
      tx
        .select()
        .from(categories)
        .where(eq(categories.organizationId, organizationId)),
    );
    const payeeRows = yield* query(() =>
      tx.select().from(payees).where(eq(payees.organizationId, organizationId)),
    );
    const existing = yield* query(() =>
      tx
        .select()
        .from(importRows)
        .where(eq(importRows.organizationId, organizationId)),
    );
    const codes = yield* query(() =>
      tx
        .select({ mpesaCode: expenses.mpesaCode })
        .from(expenses)
        .where(eq(expenses.organizationId, organizationId)),
    );
    const openFloats = yield* query(() =>
      tx
        .select()
        .from(floats)
        .where(
          and(
            eq(floats.organizationId, organizationId),
            eq(floats.status, "open"),
          ),
        ),
    );
    const salaries = yield* query(() =>
      tx
        .select()
        .from(recurringItems)
        .where(
          and(
            eq(recurringItems.organizationId, organizationId),
            eq(recurringItems.overviewHeading, "salaries"),
          ),
        ),
    );
    return {
      people,
      categoryRows,
      payeeRows,
      existing,
      codes,
      openFloats,
      salaries,
    };
  });
}
type Context = Effect.Effect.Success<ReturnType<typeof loadContext>>;

function actionFor(
  input: ImportRequest,
  row: Record<string, string>,
  ctx: Context,
  organizationId: string,
  today: string,
): Action {
  const person = () => {
    const email = required(row, "email").toLowerCase();
    const found = ctx.people.find(
      (p) => p.email === email && p.role !== "accountant",
    );
    if (!found)
      throw new Error(
        "Invite this employee/admin to this company first; email must match their membership.",
      );
    return found;
  };
  const category = () => {
    const name = required(row, "category").toLowerCase();
    const matches = ctx.categoryRows.filter(
      (c) => c.name.toLowerCase() === name && !c.archived,
    );
    if (matches.length !== 1 || !matches[0])
      throw new Error(
        "Category must match exactly one active category in this company.",
      );
    return matches[0].id;
  };
  const payee = () => {
    const name = required(row, "payee").toLowerCase();
    const matches = ctx.payeeRows.filter(
      (p) => p.name.toLowerCase() === name && !p.archived,
    );
    if (matches.length !== 1 || !matches[0])
      throw new Error(
        "Payee must match exactly one active payee; import payees first.",
      );
    return matches[0];
  };
  const heading = () => {
    const h = optionalValue(row.heading) ?? "transactions";
    if (
      h !== "transactions" &&
      h !== "subscriptions" &&
      h !== "salaries" &&
      h !== "petty_cash"
    )
      throw new Error(
        "Use transactions, subscriptions, salaries or petty_cash for heading.",
      );
    return h;
  };
  const name = () => {
    const n = required(row, "name");
    if (n.length > 120) throw new Error("Keep name to 120 characters.");
    return n;
  };
  if (input.kind === "payee") {
    const kind = payeeKind(row.payeeKind);
    return {
      table: "payee",
      data: {
        organizationId,
        name: name(),
        kind,
        membershipId: kind === "employee" ? person().id : null,
      },
    };
  }
  if (input.kind === "float") {
    const issued = importAmount(required(row, "issued"));
    const left = importAmount(required(row, "left"), true);
    if (left > issued)
      throw new Error("Float balance can't exceed the amount issued.");
    const date = importDate(required(row, "date"));
    if (date > today)
      throw new Error("An opening float can't be dated in the future.");
    return {
      table: "float",
      data: {
        organizationId,
        membershipId: person().id,
        importedIssuedKes: issued,
        importedSpentKes: issued - left,
        openedAt: new Date(`${date}T00:00:00+03:00`),
      },
    };
  }
  const date = importDate(required(row, "date"));
  const amountKes = importAmount(required(row, "amount"));
  const categoryId = category();
  if (input.kind === "claim" || input.kind === "history") {
    if (date > today) throw new Error("Spending can't be dated in the future.");
    const mpesaCode = optionalValue(row.mpesaCode)?.toUpperCase() ?? null;
    if (mpesaCode && !/^[A-Z0-9]{10}$/.test(mpesaCode))
      throw new Error("M-Pesa code must have 10 letters/numbers.");
    return {
      table: "expense",
      data: {
        organizationId,
        membershipId: person().id,
        categoryId,
        kind: "claim",
        overviewHeading: heading(),
        merchant: name(),
        amountKes,
        spentOn: date,
        description: optionalValue(row.description) ?? null,
        source: "import",
        status: input.kind === "claim" ? "submitted" : "paid_outside",
        mpesaCode,
        etimsStatus: "none",
        paidAt:
          input.kind === "history" ? new Date(`${date}T00:00:00+03:00`) : null,
      },
    };
  }
  const target = payee();
  if (input.kind === "bill") {
    const h = heading();
    if (h === "petty_cash" || h === "salaries")
      throw new Error(
        "Use transactions/subscriptions for bills; import salaries separately.",
      );
    return {
      table: "bill",
      data: {
        organizationId,
        payeeId: target.id,
        categoryId,
        overviewHeading: h,
        amountKes,
        dueOn: date,
        status: date < today ? "overdue" : date === today ? "due" : "upcoming",
        notes: optionalValue(row.description) ?? null,
      },
    };
  }
  const salary = input.kind === "salary";
  if (salary && target.kind !== "employee")
    throw new Error("A salary needs an employee payee.");
  const h = salary ? "salaries" : heading();
  if (h === "petty_cash" || (!salary && h === "salaries"))
    throw new Error("Use transactions/subscriptions for recurring bills.");
  const cadence = salary ? "monthly" : schedule(row.schedule);
  const day = optionalValue(row.scheduleDay) ?? date.slice(-2);
  if (
    !/^\d{1,2}$/.test(day) ||
    Number(day) < 1 ||
    Number(day) > (cadence === "weekly" ? 7 : 31)
  )
    throw new Error("scheduleDay must be 1–7 for weekly or 1–31 otherwise.");
  const due = new Date(`${date}T00:00:00Z`);
  const lastDay = new Date(
    Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0),
  ).getUTCDate();
  if (
    (cadence === "weekly" ? due.getUTCDay() || 7 : due.getUTCDate()) !==
    (cadence === "weekly" ? Number(day) : Math.min(Number(day), lastDay))
  )
    throw new Error(
      "The next due date must match scheduleDay (clamped at month end).",
    );
  const payVia = salary ? "expendi" : (optionalValue(row.payVia) ?? "expendi");
  if (payVia !== "expendi" && payVia !== "outside")
    throw new Error("payVia must be expendi or outside.");
  return {
    table: "recurring",
    data: {
      organizationId,
      payeeId: target.id,
      categoryId,
      overviewHeading: h,
      amountKes,
      schedule: cadence,
      scheduleDay: Number(day),
      startsOn: date,
      nextDueOn: date,
      payVia,
    },
  };
}

function plan(
  input: ImportRequest,
  raw: Record<string, string>[],
  ctx: Context,
  organizationId: string,
): PlannedRow[] {
  const today = nairobiToday();
  const seen = new Set(ctx.existing.map((r) => r.rowHash));
  const codes = new Set(ctx.codes.map((r) => r.mpesaCode));
  const names = new Set(
    ctx.payeeRows.filter((p) => !p.archived).map((p) => p.name.toLowerCase()),
  );
  const employeePayees = new Set(
    ctx.payeeRows.filter((p) => !p.archived).map((p) => p.membershipId),
  );
  const holders = new Set(ctx.openFloats.map((f) => f.membershipId));
  const salaries = new Set(
    ctx.salaries.filter((s) => s.nextDueOn).map((s) => s.payeeId),
  );
  return raw.map((values, i): PlannedRow => {
    const report: ImportReport["rows"][number] = {
      row: Number(values.$row) || i + 2,
      values: cleanValues(values),
      status: "ready",
      message: "Ready to import.",
    };
    if (values.$skip)
      return {
        action: null,
        hash: "",
        report: { ...report, status: "skipped", message: values.$skip },
      };
    try {
      validateImportStatus(input, values);
      const action = actionFor(input, values, ctx, organizationId, today);
      // Date-derived bill status is not source identity and changes overnight.
      const identity =
        action.table === "bill"
          ? { ...action.data, status: undefined }
          : action.data;
      const rowHash = hash([input.kind, values.$source, identity]);
      if (seen.has(rowHash))
        return {
          action,
          hash: rowHash,
          report: {
            ...report,
            status: "skipped",
            message: "Already imported or repeated in this file.",
          },
        };
      seen.add(rowHash);
      if (
        input.kind === "history" &&
        action.table === "expense" &&
        action.data.spentOn < oldestHistoryDate(today)
      )
        return {
          action,
          hash: rowHash,
          report: {
            ...report,
            status: "skipped",
            message: "Older than the last three months.",
          },
        };
      if (action.table === "expense" && action.data.mpesaCode) {
        if (codes.has(action.data.mpesaCode))
          throw new Error(
            "This M-Pesa code already exists in the company or this file.",
          );
        codes.add(action.data.mpesaCode);
      }
      if (action.table === "payee") {
        if (
          names.has(action.data.name.toLowerCase()) ||
          (action.data.membershipId &&
            employeePayees.has(action.data.membershipId))
        )
          throw new Error(
            "A payee with this name or employee membership already exists.",
          );
        names.add(action.data.name.toLowerCase());
        employeePayees.add(action.data.membershipId ?? null);
        report.message =
          "Payment details stay unset. An admin must add and confirm them before payment.";
      }
      if (action.table === "float") {
        if (holders.has(action.data.membershipId))
          throw new Error("This person already has an open float.");
        holders.add(action.data.membershipId);
      }
      if (input.kind === "salary" && action.table === "recurring") {
        if (salaries.has(action.data.payeeId))
          throw new Error("This payee already has an ongoing salary.");
        salaries.add(action.data.payeeId);
      }
      return { action, hash: rowHash, report };
    } catch (error) {
      return {
        action: null,
        hash: "",
        report: {
          ...report,
          status: "error",
          message: error instanceof Error ? error.message : "Invalid row.",
        },
      };
    }
  });
}

function insertAction(tx: Transaction, action: Action, id: string) {
  switch (action.table) {
    case "payee":
      return query(() => tx.insert(payees).values({ ...action.data, id }));
    case "recurring":
      return query(() =>
        tx.insert(recurringItems).values({ ...action.data, id }),
      );
    case "bill":
      return query(() => tx.insert(bills).values({ ...action.data, id }));
    case "float":
      return query(() => tx.insert(floats).values({ ...action.data, id }));
    case "expense":
      return Effect.gen(function* () {
        const warnings = yield* expenseWarnings(tx, {
          id: null,
          organizationId: action.data.organizationId,
          membershipId: action.data.membershipId,
          amountKes: action.data.amountKes,
          spentOn: action.data.spentOn,
        });
        return yield* query(() =>
          tx.insert(expenses).values({ ...action.data, id, warnings }),
        );
      });
  }
}

export function spreadsheetImport(
  staff: StaffMember,
  organizationId: string,
  input: ImportRequest,
  previewToken?: string,
) {
  return Effect.gen(function* () {
    if (staff.role !== "ops_admin")
      return yield* Effect.fail(
        new Forbidden({ message: "Only ops admins can import." }),
      );
    const raw = yield* Effect.try({
      try: () => mappedRows(input),
      catch: (e) =>
        new BadRequest({
          message: e instanceof Error ? e.message : "Invalid CSV.",
        }),
    });
    const audit = yield* AuditLog;
    return yield* withScope({ organizationId, role: "admin" }, (tx) =>
      Effect.gen(function* () {
        if (!previewToken)
          yield* query(() => tx.execute(sql`SET TRANSACTION READ ONLY`));
        else {
          // Serialize imports per company before reading the deduplication keys.
          yield* query(() =>
            tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${"import:" + organizationId}, 0))`,
            ),
          );
        }
        yield* query(() =>
          tx.execute(
            sql`SELECT set_config('app.import_staff_id', ${staff.staffUserId}, true)`,
          ),
        );
        const ctx = yield* loadContext(tx, organizationId);
        const planned = plan(input, raw, ctx, organizationId);
        const rows = planned.map((r) => r.report);
        const errors = rows.filter((r) => r.status === "error").length;
        const ready = rows.filter((r) => r.status === "ready").length;
        const skipped = rows.length - errors - ready;
        const digest = hash([
          staff.staffUserId,
          organizationId,
          input.kind,
          input.csv,
          Object.entries(input.mapping).sort(),
          planned.map((r) => r.hash),
        ]);
        if (!previewToken)
          return {
            type: "preview" as const,
            report: {
              rows,
              ready,
              skipped,
              errors,
              previewToken: errors ? null : issueToken(digest),
            },
          };
        if (errors || !validToken(previewToken, digest))
          return yield* Effect.fail(
            new Conflict({
              message:
                "The preview expired or the data changed. Preview again and review the report.",
            }),
          );
        const runId = randomUUID();
        yield* query(() =>
          tx.insert(importRuns).values({
            id: runId,
            organizationId,
            staffUserId: staff.staffUserId,
            fileName: input.fileName,
            fileHash: hash(input.csv),
            kind: input.kind,
            columnMapping: input.mapping,
            rowsTotal: rows.length,
            rowsImported: ready,
            rowsSkipped: skipped,
            report: rows,
          }),
        );
        for (const row of planned) {
          if (row.report.status !== "ready" || !row.action) continue;
          const id = randomUUID();
          yield* insertAction(tx, row.action, id);
          yield* query(() =>
            tx.insert(importRows).values({
              organizationId,
              rowHash: row.hash,
              runId,
              entityId: id,
            }),
          );
          yield* audit.record(tx, {
            actor: { type: "staff", id: staff.staffUserId },
            organizationId,
            action: `${row.action.table}.imported`,
            entity: { type: row.action.table, id },
            after: { runId, row: row.report.row, source: "import" },
          });
        }
        yield* audit.record(tx, {
          actor: { type: "staff", id: staff.staffUserId },
          organizationId,
          action: "import.completed",
          entity: { type: "import_run", id: runId },
          after: { imported: ready, skipped, fileHash: hash(input.csv) },
        });
        return {
          type: "committed" as const,
          result: { runId, imported: ready, skipped },
        };
      }),
    );
  });
}
