import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { BillRow, Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { PayrollPerson } from "../helpers/payroll.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  floatMovements,
  floats,
  memberships,
  notificationOutbox,
  payouts,
} from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { sendPendingNotifications } from "../../services/notification/delivery.js";
import { notify } from "../../services/notification/notify.js";
import {
  queueBillReminders,
  queueWalletShortReminder,
  runSpendingReminders,
} from "../../services/notification/reminders.js";
import { applyPayoutOutcome } from "../../services/payout/subjects.js";
import { draftDuePayroll } from "../../services/payroll/drafts.js";
import { insertBill, insertBillPayout, insertPayee } from "../helpers/bills.js";
import { addCategory } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import { registerDevice } from "../helpers/devices.js";
import { makeFakeEmailSender, makeFakePaycrest } from "../helpers/fakes.js";
import { createPayingCompany, USDC } from "../helpers/payouts.js";
import {
  addEmployeePayee,
  billsOfRun,
  insertSalary,
  runsOf,
  settlePayrollBill,
} from "../helpers/payroll.js";
import { makeFakePushSender } from "../helpers/push.js";
import { makeTestRuntime } from "../helpers/runtime.js";

// Serial: the reminders job and the sending job sweep every company, so
// run beside other files they would remind and send for those too.

const push = makeFakePushSender();
const email = makeFakeEmailSender();
const paycrest = makeFakePaycrest();
let runtime: AppRuntime;
let db: Database;
let app: App;
let paying: PayingCompany;
let categoryId: string;
let supplierId: string;

beforeAll(async () => {
  runtime = makeTestRuntime({
    pushSender: push.layer,
    emailSender: email.layer,
    paycrest: paycrest.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(async () => {
  await runtime.dispose();
});

const deliver = () => runtime.runPromise(sendPendingNotifications(10_000));

beforeEach(async () => {
  await deliver();
  push.state.reset();
  email.state.reset();
  paycrest.state.reset();
  paycrest.state.rateFor = () => "100";
  paying = await createPayingCompany(runtime, db);
  categoryId = await addCategory(db, paying.company, "Utilities");
  supplierId = await insertPayee(db, paying.company, {
    name: "Kenya Power <Ltd>",
  });
});

const adminScope = () =>
  ({ organizationId: paying.company.organizationId, role: "admin" }) as const;

/** The company's outbox, oldest first. */
const outbox = () =>
  runInScope(db, adminScope(), (tx) =>
    tx
      .select()
      .from(notificationOutbox)
      .where(
        eq(notificationOutbox.organizationId, paying.company.organizationId),
      )
      .orderBy(notificationOutbox.createdAt),
  );

const queuedFor = async (billId: string) =>
  (await outbox())
    .filter((row) => row.data.billId === billId)
    .map((row) => `${row.kind}:${row.channel}`)
    .sort();

const bill = (dueOn: string, values: Partial<BillRow> = {}) =>
  insertBill(db, paying.company, {
    payeeId: supplierId,
    categoryId,
    dueOn,
    ...values,
  });

/** Nairobi is UTC+3 all year: 05:00Z is 08:00 there. */
const reminders = (at: string) =>
  runtime.runPromise(runSpendingReminders(new Date(at)));

const remindBills = (today: string) =>
  runtime.runPromise(
    withScope(adminScope(), (tx) =>
      queueBillReminders(tx, paying.company.organizationId, today),
    ),
  );

const checkWallet = (today: string) =>
  runtime.runPromise(
    queueWalletShortReminder(paying.company.organizationId, today),
  );

describe("bill reminders", () => {
  it("sends due soon, due today and overdue once each, on the right Nairobi morning", async () => {
    // #given a bill due Thu 5 Nov, reminded 3 days ahead by default
    const id = await bill("2026-11-05");

    // #then 23:59 on 1 Nov in Nairobi is still 4 days out
    await reminders("2026-11-01T20:59:59Z");
    expect(await queuedFor(id)).toEqual([]);

    // #then 2 Nov waits for 8:00 Nairobi time
    expect(await reminders("2026-11-02T04:59:59Z")).toBeNull();
    expect(await queuedFor(id)).toEqual([]);
    await reminders("2026-11-02T05:00:00Z");
    expect(await queuedFor(id)).toEqual([
      "bill_due_soon:email",
      "bill_due_soon:push",
    ]);

    // #when it runs again, twice at once, and on the days between
    await Promise.all([
      reminders("2026-11-02T05:00:00Z"),
      reminders("2026-11-02T05:15:00Z"),
    ]);
    await reminders("2026-11-03T05:00:00Z");
    await reminders("2026-11-04T20:59:59Z");
    expect(await queuedFor(id)).toHaveLength(2);

    // #then the due date's reminder waits for its own morning
    expect(await reminders("2026-11-04T21:00:00Z")).toBeNull();
    await reminders("2026-11-05T05:00:00Z");
    await reminders("2026-11-05T12:00:00Z");
    await reminders("2026-11-06T05:00:00Z");
    await reminders("2026-11-07T05:00:00Z");
    await reminders("2026-11-20T05:00:00Z");
    expect(await queuedFor(id)).toEqual([
      "bill_due_soon:email",
      "bill_due_soon:push",
      "bill_due_today:email",
      "bill_due_today:push",
      "bill_overdue:email",
      "bill_overdue:push",
    ]);
  });

  it("uses a recurring payment's own lead time, and none at 0 days", async () => {
    // #given
    const twoDays = await insertSalary(db, paying.company, {
      payeeId: supplierId,
      categoryId,
      overviewHeading: "subscriptions",
      reminderDays: 2,
    });
    const sameDay = await insertSalary(db, paying.company, {
      payeeId: await insertPayee(db, paying.company),
      categoryId,
      overviewHeading: "transactions",
      reminderDays: 0,
    });
    const early = await bill("2026-11-05", { recurringItemId: twoDays });
    const late = await bill("2026-11-05", { recurringItemId: sameDay });

    // #when
    await remindBills("2026-11-02");
    const beforeLeadTime = await queuedFor(early);
    await remindBills("2026-11-03");
    await remindBills("2026-11-04");

    // #then
    expect(beforeLeadTime).toEqual([]);
    expect(await queuedFor(early)).toEqual([
      "bill_due_soon:email",
      "bill_due_soon:push",
    ]);
    expect(await queuedFor(late)).toEqual([]);
    await remindBills("2026-11-05");
    expect(await queuedFor(late)).toEqual([
      "bill_due_today:email",
      "bill_due_today:push",
    ]);
  });

  it("sends only the current stage after downtime, and nothing for bills being paid, paid, cancelled or on payroll", async () => {
    // #given
    const late = await bill("2026-10-01");
    const variable = await bill("2026-11-02", {
      variable: true,
      amountKes: null,
    });
    const paid = await bill("2026-11-02", {
      status: "paid",
      payoutId: await insertBillPayout(db, paying.company, paying.wallet.id),
      paidOn: "2026-11-01",
      paidAt: new Date("2026-11-01T09:00:00Z"),
    });
    const beingPaid = await bill("2026-11-02", {
      status: "paying",
      payoutId: await insertBillPayout(db, paying.company, paying.wallet.id),
    });
    const cancelled = await bill("2026-11-02", {
      status: "cancelled",
      cancelledBy: paying.company.admin.id,
      cancelledAt: new Date(),
      cancelledReason: "Not owed",
    });
    const employee = await addEmployeePayee(db, paying.company);
    await insertSalary(db, paying.company, {
      payeeId: employee.payeeId,
      categoryId,
      nextDueOn: "2026-11-05",
    });
    await runtime.runPromise(
      draftDuePayroll(
        paying.company.organizationId,
        new Date("2026-11-02T05:00:00Z"),
      ),
    );

    // #when
    await remindBills("2026-11-02");

    // #then
    expect(await queuedFor(late)).toEqual([
      "bill_overdue:email",
      "bill_overdue:push",
    ]);
    expect(await queuedFor(variable)).toEqual([
      "bill_due_today:email",
      "bill_due_today:push",
    ]);
    expect(await queuedFor(paid)).toEqual([]);
    expect(await queuedFor(beingPaid)).toEqual([]);
    expect(await queuedFor(cancelled)).toEqual([]);
    expect(
      (await outbox()).filter((row) => row.kind.startsWith("bill_")),
    ).toHaveLength(4);
  });

  it("words the reminder with the amount and due day, and escapes it in the email", async () => {
    // #given
    const device = await registerDevice(app, paying.company.admin);
    await bill("2026-11-05", { amountKes: 1_250_000n });
    await remindBills("2026-11-02");

    // #when
    await deliver();

    // #then
    expect(push.state.deliveredTo(device)).toMatchObject([
      {
        title: "Bill due soon",
        body: "KES 12,500 to Kenya Power <Ltd> is due Thu 5 Nov.",
      },
    ]);
    const sent = email.state.sent.filter(
      (message) => message.to === paying.company.admin.email,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe(`Bill due soon: ${paying.company.name}`);
    expect(sent[0]?.html).toContain("Kenya Power &lt;Ltd&gt;");
    expect(sent[0]?.idempotencyKey).toMatch(/^notification:/);
  });

  it("queues nothing when the event's transaction rolls back", async () => {
    // #given
    const id = await bill("2026-11-02");

    // #when
    await runtime.runPromiseExit(
      withScope(adminScope(), (tx) =>
        notify(tx, {
          kind: "bill_due_today",
          organizationId: paying.company.organizationId,
          billId: id,
        }).pipe(Effect.zipRight(Effect.fail("rolled back"))),
      ),
    );

    // #then
    expect(await queuedFor(id)).toEqual([]);
    await remindBills("2026-11-02");
    expect(await queuedFor(id)).toHaveLength(2);
  });
});

describe("wallet short for the next 7 days", () => {
  // The wallet holds 100 USDC: KES 10,000 at the fake's rate of 100.

  it("warns the admins by push and email once a Nairobi day while short", async () => {
    // #given KES 10,001 due within 7 days
    await bill("2026-11-09", { amountKes: 1_000_100n });
    const device = await registerDevice(app, paying.company.admin);

    // #when
    const warned = await Promise.all([
      checkWallet("2026-11-02"),
      checkWallet("2026-11-02"),
    ]);
    await checkWallet("2026-11-02");

    // #then
    const shortRows = (await outbox()).filter(
      (row) => row.kind === "wallet_short",
    );
    expect(warned).toContain(true);
    expect(shortRows.map((row) => row.channel).sort()).toEqual([
      "email",
      "push",
    ]);
    await deliver();
    expect(push.state.deliveredTo(device)).toMatchObject([
      {
        title: "Wallet short for upcoming payments",
        body: "Payments due by Mon 9 Nov need KES 1 more than the wallet holds. Top up to pay them on time.",
      },
    ]);
    expect(
      email.state.sent.filter(
        (message) => message.to === paying.company.admin.email,
      ),
    ).toHaveLength(1);

    // #then the next Nairobi day warns again
    await checkWallet("2026-11-03");
    expect(
      (await outbox()).filter((row) => row.kind === "wallet_short"),
    ).toHaveLength(4);
  });

  it("stays quiet when covered, when the rest is due after 7 days, or when Paycrest's rate is unavailable", async () => {
    // #given exactly the balance due within the window, more on day 8
    await bill("2026-11-09", { amountKes: 1_000_000n });
    await bill("2026-11-10", { amountKes: 50_000_000n });

    // #when
    const covered = await checkWallet("2026-11-02");
    await bill("2026-11-04", { amountKes: 100n });
    paycrest.state.failRate = true;
    const unknown = await checkWallet("2026-11-02");

    // #then
    expect([covered, unknown]).toEqual([false, false]);
    expect(
      (await outbox()).filter((row) => row.kind === "wallet_short"),
    ).toEqual([]);

    // #when Paycrest answers again the same day
    paycrest.state.failRate = false;
    expect(await checkWallet("2026-11-02")).toBe(true);
  });

  it("runs from the reminders job, once a day", async () => {
    // #given
    await bill("2026-11-09", { amountKes: 5_000_000n });

    // #when
    const first = await reminders("2026-11-02T05:00:00Z");
    const again = await reminders("2026-11-02T05:15:00Z");

    // #then
    expect(first?.walletWarnings).toBeGreaterThanOrEqual(1);
    expect(again).toMatchObject({ bills: 0, walletWarnings: 0, failed: 0 });
    expect(
      (await outbox()).filter((row) => row.kind === "wallet_short"),
    ).toHaveLength(2);
  });
});

/** An employee on payroll, with a phone, paid on 28 Nov. */
async function salariedEmployee(): Promise<
  PayrollPerson & { readonly device: string }
> {
  const person = await addEmployeePayee(db, paying.company);
  await insertSalary(db, paying.company, {
    payeeId: person.payeeId,
    categoryId,
  });
  return { ...person, device: await registerDevice(app, person.user) };
}

const draftNovemberPayroll = () =>
  runtime.runPromise(
    draftDuePayroll(
      paying.company.organizationId,
      new Date("2026-11-23T05:00:00Z"),
    ),
  );

async function readPayoutAsAdmin(payoutId: string): Promise<Payout> {
  const [payout] = await runInScope(db, adminScope(), (tx) =>
    tx.select().from(payouts).where(eq(payouts.id, payoutId)),
  );
  if (!payout) throw new Error(`payout ${payoutId} not found`);
  return payout;
}

/** Drafts November's run and starts paying `person`'s salary in it. */
async function payingSalaryOf(person: PayrollPerson) {
  await draftNovemberPayroll();
  const [run] = await runsOf(db, paying.company);
  const salary = (await billsOfRun(db, paying.company, run?.id ?? "")).find(
    (row) => row.payeeId === person.payeeId,
  );
  if (!salary) throw new Error("no salary bill");
  const payoutId = await settlePayrollBill(
    db,
    paying.company,
    paying.wallet.id,
    salary,
    "paying",
  );
  return { salary, payout: await readPayoutAsAdmin(payoutId) };
}

/** The engine reporting the payout's outcome, as reconciliation does. */
const payoutEnds = (payout: Payout, status: "paid" | "failed") =>
  runtime.runPromise(
    withScope({ organizationId: payout.organizationId }, (tx) =>
      applyPayoutOutcome(tx, {
        ...payout,
        status,
        paidAt: status === "paid" ? new Date() : null,
      }),
    ),
  );

describe("payroll ready to review", () => {
  it("tells the admins once when the draft job creates the run, by push only and without amounts", async () => {
    // #given
    const adminDevice = await registerDevice(app, paying.company.admin);
    const employee = await salariedEmployee();
    const accountant = await createUser(db);
    await addMember(db, paying.company, accountant, { role: "accountant" });
    const accountantDevice = await registerDevice(app, accountant);

    // #when the run is drafted, a late salary joins it, and the job runs again
    await draftNovemberPayroll();
    await salariedEmployee();
    await draftNovemberPayroll();
    await deliver();

    // #then
    const ready = (await outbox()).filter(
      (row) => row.kind === "payroll_ready",
    );
    expect(ready.map((row) => row.channel)).toEqual(["push"]);
    expect(push.state.deliveredTo(adminDevice)).toMatchObject([
      {
        title: "Payroll ready to review",
        body: "Payroll for Sat 28 Nov has 1 payment to review before pay day.",
      },
    ]);
    expect(push.state.deliveredTo(employee.device)).toEqual([]);
    expect(push.state.deliveredTo(accountantDevice)).toEqual([]);
    expect(email.state.sent).toEqual([]);
  });
});

describe("salary paid", () => {
  it("goes only to the employee paid, without the amount, once their bill is paid", async () => {
    // #given two employees in a run, one being paid
    const adminDevice = await registerDevice(app, paying.company.admin);
    const paid = await salariedEmployee();
    const colleague = await salariedEmployee();
    const { salary, payout } = await payingSalaryOf(paid);
    await deliver();
    push.state.reset();

    // #when the payout is paid, and reported twice
    await payoutEnds(payout, "paid");
    await payoutEnds(payout, "paid");
    await deliver();

    // #then
    const salaryRows = (await outbox()).filter(
      (row) => row.kind === "salary_paid",
    );
    expect(salaryRows).toMatchObject([
      {
        channel: "push",
        audience: "member",
        recipientMembershipId: paid.membershipId,
        data: { billId: salary.id },
      },
    ]);
    expect(push.state.deliveredTo(paid.device)).toEqual([
      expect.objectContaining({
        title: "Salary paid",
        body: "Your salary for Sat 28 Nov has been paid.",
      }),
    ]);
    expect(JSON.stringify(salaryRows)).not.toContain("50,000");
    expect(push.state.deliveredTo(colleague.device)).toEqual([]);
    expect(push.state.deliveredTo(adminDevice)).toEqual([]);
    expect(email.state.sent).toEqual([]);
  });

  it("sends nothing when the payment fails", async () => {
    // #given
    const person = await salariedEmployee();
    const { payout } = await payingSalaryOf(person);

    // #when
    await payoutEnds(payout, "failed");

    // #then
    expect(
      (await outbox()).filter((row) => row.kind === "salary_paid"),
    ).toEqual([]);
  });
});

describe("petty cash float issued or topped up", () => {
  async function pendingMovement(
    floatId: string,
    type: "issue" | "top_up",
    amountKes: bigint,
  ): Promise<Payout> {
    return runInScope(db, adminScope(), async (tx) => {
      const movementId = randomUUID();
      const [payout] = await tx
        .insert(payouts)
        .values({
          organizationId: paying.company.organizationId,
          walletId: paying.wallet.id,
          subjectType: "float",
          subjectId: movementId,
          idempotencyKey: `float:${movementId}:1`,
          method: "mpesa_phone",
          recipient: {
            method: "mpesa_phone",
            phone: "+254712345678",
            accountName: "Jane Wanjiku",
          },
          requestedKesCents: amountKes,
          amountKes,
          quotedRate: "100.00",
          quotedUsdc: USDC,
          maxDebitUsdc: 2n * USDC,
          status: "failed",
        })
        .returning();
      if (!payout) throw new Error("payout insert returned no row");
      await tx.insert(floatMovements).values({
        id: movementId,
        organizationId: paying.company.organizationId,
        floatId,
        type,
        status: "pending",
        amountKes,
        payoutId: payout.id,
        recordedBy: paying.company.admin.id,
      });
      return payout;
    });
  }

  it("tells the holder once per paid issue or top-up, through the float payout hook", async () => {
    // #given
    const holder = await addEmployeePayee(db, paying.company);
    const device = await registerDevice(app, holder.user);
    const otherDevice = await registerDevice(
      app,
      (await addEmployeePayee(db, paying.company)).user,
    );
    const [float] = await runInScope(db, adminScope(), (tx) =>
      tx
        .insert(floats)
        .values({
          organizationId: paying.company.organizationId,
          membershipId: holder.membershipId,
        })
        .returning({ id: floats.id }),
    );
    if (!float) throw new Error("float insert returned no row");

    // #when an issue is paid (reported twice), a top-up fails, another is paid
    const issue = await pendingMovement(float.id, "issue", 1_000_000n);
    await payoutEnds(issue, "paid");
    await payoutEnds(issue, "paid");
    await payoutEnds(
      await pendingMovement(float.id, "top_up", 300_000n),
      "failed",
    );
    await payoutEnds(
      await pendingMovement(float.id, "top_up", 500_000n),
      "paid",
    );
    await deliver();

    // #then
    expect(
      push.state
        .deliveredTo(device)
        .map(({ title, body }) => ({ title, body })),
    ).toEqual([
      {
        title: "Petty cash float issued",
        body: "KES 10,000 was sent to you for petty cash.",
      },
      {
        title: "Petty cash float topped up",
        body: "KES 5,000 was added to your petty cash float.",
      },
    ]);
    expect(push.state.deliveredTo(otherDevice)).toEqual([]);
    expect(email.state.sent).toEqual([]);
  });
});

describe("removed members", () => {
  it("get nothing queued before their removal; current admins get it, accountants and employees don't", async () => {
    // #given an admin removed after the reminder was queued
    const adminDevice = await registerDevice(app, paying.company.admin);
    const removed = await createUser(db);
    const removedMembership = await addMember(db, paying.company, removed, {
      role: "admin",
    });
    const removedDevice = await registerDevice(app, removed);
    const accountant = await createUser(db);
    await addMember(db, paying.company, accountant, { role: "accountant" });
    const accountantDevice = await registerDevice(app, accountant);
    const employee = await addEmployeePayee(db, paying.company);
    const employeeDevice = await registerDevice(app, employee.user);
    await bill("2026-11-02");
    await remindBills("2026-11-02");
    await removeMembership(removedMembership);

    // #when
    await Promise.all([deliver(), deliver()]);

    // #then
    expect(push.state.deliveredTo(adminDevice)).toHaveLength(1);
    expect(push.state.deliveredTo(removedDevice)).toEqual([]);
    expect(push.state.deliveredTo(accountantDevice)).toEqual([]);
    expect(push.state.deliveredTo(employeeDevice)).toEqual([]);
    const companyEmails = [
      paying.company.admin.email,
      removed.email,
      accountant.email,
      employee.user.email,
    ];
    expect(
      email.state.sent
        .map((message) => message.to)
        .filter((to) => companyEmails.includes(to)),
    ).toEqual([paying.company.admin.email]);
  });

  it("get no salary notice queued before their removal", async () => {
    // #given
    const person = await salariedEmployee();
    const { payout } = await payingSalaryOf(person);
    await payoutEnds(payout, "paid");

    // #when
    await removeMembership(person.membershipId);
    await deliver();

    // #then
    expect(push.state.deliveredTo(person.device)).toEqual([]);
  });
});

describe("email delivery", () => {
  it("goes on sending pushes while Resend fails, and emails on a later run", async () => {
    // #given
    const device = await registerDevice(app, paying.company.admin);
    await bill("2026-11-02");
    await remindBills("2026-11-02");
    email.state.failNext(10);

    // #when
    const failedRun = await deliver();
    const pushedDuringOutage = push.state.deliveredTo(device).length;
    email.state.failNext(0);
    await deliver();

    // #then
    expect(failedRun.failed).toBe(1);
    expect(pushedDuringOutage).toBe(1);
    expect(
      email.state.sent.filter(
        (message) => message.to === paying.company.admin.email,
      ),
    ).toHaveLength(1);
  });

  it("keeps an email row's progress when Resend fails partway, and sends each admin one email", async () => {
    // #given
    const second = await createUser(db);
    await addMember(db, paying.company, second, { role: "admin" });
    await bill("2026-11-02");
    await remindBills("2026-11-02");
    const [emailRow] = (await outbox()).filter(
      (row) => row.channel === "email",
    );
    if (!emailRow) throw new Error("no email row");

    // #when the first send goes through and the second fails
    await runInScope(db, adminScope(), (tx) =>
      tx
        .update(notificationOutbox)
        .set({ emailRecipientsSent: [paying.company.admin.id] })
        .where(eq(notificationOutbox.id, emailRow.id)),
    );
    email.state.failNext(1);
    await deliver();
    const afterFailure = await readRow(emailRow.id);
    await deliver();

    // #then
    expect(afterFailure?.sentAt).toBeNull();
    expect(afterFailure?.lastError).toBe("fake Resend failure");
    expect(afterFailure?.emailRecipientsSent).toEqual([
      paying.company.admin.id,
    ]);
    expect(
      email.state.sent.filter((message) =>
        [paying.company.admin.email, second.email].includes(message.to),
      ),
    ).toEqual([expect.objectContaining({ to: second.email })]);
    expect((await readRow(emailRow.id))?.sentAt).not.toBeNull();
  });
});

async function removeMembership(membershipId: string): Promise<void> {
  await runInScope(db, adminScope(), (tx) =>
    tx
      .update(memberships)
      .set({ status: "removed" })
      .where(eq(memberships.id, membershipId)),
  );
}

async function readRow(id: string) {
  const [row] = await runInScope(db, adminScope(), (tx) =>
    tx
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.id, id),
          eq(notificationOutbox.organizationId, paying.company.organizationId),
        ),
      ),
  );
  return row;
}
