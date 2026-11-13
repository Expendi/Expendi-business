import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CashOutReceipt } from "@expendi-business/shared";
import {
  billDetailSchema,
  billsResponseSchema,
  claimDetailSchema,
  claimsPageSchema,
  expenseDetailSchema,
  expensesPageSchema,
  floatDetailSchema,
  mySalaryPaymentsResponseSchema,
  payrollRunDetailSchema,
  walletHistoryResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { NewPayout, Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser, TestWallet } from "../helpers/db.js";
import type { PayrollPerson } from "../helpers/payroll.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  bills,
  payouts,
  payrollRuns,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import { randomTxHash } from "../helpers/chain.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import { asAdmin, exportSeeder } from "../helpers/exports.js";
import { makeFakeFileStorage, randomAddress } from "../helpers/fakes.js";
import { addEmployeePayee } from "../helpers/payroll.js";
import { makeTestRuntime } from "../helpers/runtime.js";

/**
 * `paymentReceipts` on everything a cash-out pays: the M-Pesa or bank
 * receipt of each paid cash-out, never a USDC payout's hash. Payouts are
 * written straight to the table in the state each case needs; the provider
 * paths that put the receipt there are tested with the bill payments and
 * the Pretium cash-outs.
 */

let runtime: AppRuntime;
let db: Database;
let app: App;

let company: TestCompany;
let wallet: TestWallet;
let employee: PayrollPerson;
let categoryId: string;
let seed: ReturnType<typeof exportSeeder>;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  company = await createCompany(db);
  wallet = await createActiveWallet(db, company);
  employee = await addEmployeePayee(db, company);
  categoryId = await addCategory(db, company, "Travel");
  seed = exportSeeder(db, company, wallet.id, makeFakeFileStorage());
});

const companyPath = (path: string) =>
  `/organizations/${company.organizationId}${path}`;

async function read(user: Pick<TestUser, "privyUserId">, path: string) {
  const response = await sendJson(app, companyPath(path), user);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

const admin = () => company.admin;

type Outcome = Pick<
  NewPayout,
  "provider" | "method" | "status" | "providerReference"
>;

const RECIPIENTS = {
  mpesa_phone: {
    method: "mpesa_phone",
    phone: "+254712345678",
    accountName: "Jane Wanjiku",
  },
  mpesa_till: {
    method: "mpesa_till",
    tillNumber: "123456",
    accountName: "Kenya Power",
  },
  mpesa_paybill: {
    method: "mpesa_paybill",
    paybillNumber: "888880",
    accountReference: "ACC-1",
    accountName: "Kenya Power",
  },
  bank: {
    method: "bank",
    bankCode: "KCB",
    accountNumber: "1234567890",
    accountName: "Jane Wanjiku",
  },
  usdc: {
    method: "usdc",
    chain: "base",
    address: randomAddress().toLowerCase(),
    accountName: "Vercel Inc",
  },
} as const satisfies Record<Payout["method"], NewPayout["recipient"]>;

const paidMpesa = (code: string): Outcome => ({
  provider: "pretium",
  method: "mpesa_phone",
  status: "paid",
  providerReference: code,
});

/** What a subject is, for its payouts. */
interface Subject {
  readonly subjectType: Payout["subjectType"];
  readonly subjectId: string;
  readonly payrollRunId: string | null;
}

/** One response that shows what a cash-out paid. */
interface Surface {
  readonly name: string;
  /** Whether one subject can be paid by several cash-outs: a split salary. */
  readonly splits: boolean;
  readonly subject: () => Promise<Subject>;
  readonly receiptsOf: (subjectId: string) => Promise<CashOutReceipt[]>;
}

async function payoutOf(
  subject: Subject,
  outcome: Outcome,
  part = 1,
): Promise<Payout> {
  const payout = await seed.payout(subject.subjectId, {
    subjectType: subject.subjectType,
    subjectPart: part,
    payrollRunId: subject.payrollRunId,
    recipient: RECIPIENTS[outcome.method],
    ...outcome,
    providerOrderId:
      outcome.status === "failed" ? null : `order-${randomUUID()}`,
    paidAt: outcome.status === "paid" ? new Date() : null,
  });
  await runInScope(db, asAdmin(company), (tx) =>
    tx.insert(walletTransactions).values({
      organizationId: company.organizationId,
      walletId: wallet.id,
      type: "payout",
      usdcAmount: -1_000_000n,
      txHash: randomTxHash(),
      logIndex: 0,
      blockNumber: 1n,
      payoutId: payout.id,
    }),
  );
  if (subject.subjectType === "bill") {
    // A bill paid through Expendi always names its latest payout.
    await runInScope(db, asAdmin(company), (tx) =>
      tx
        .update(bills)
        .set({ status: "paying", payoutId: payout.id })
        .where(eq(bills.id, subject.subjectId)),
    );
  }
  return payout;
}

async function supplierBill(): Promise<Subject> {
  const payeeId = await insertPayee(db, company, {
    method: "mpesa_till",
    tillNumber: "123456",
    accountName: "Kenya Power",
    detailsChangedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const billId = await insertBill(db, company, { payeeId, categoryId });
  return { subjectType: "bill", subjectId: billId, payrollRunId: null };
}

async function salaryBill(): Promise<Subject> {
  const [run] = await runInScope(db, asAdmin(company), (tx) =>
    tx
      .insert(payrollRuns)
      .values({
        organizationId: company.organizationId,
        payDate: "2026-11-28",
        status: "paid",
        totalKes: 5_000_000n,
        salariesKes: 5_000_000n,
        capKes: 6_000_000n,
      })
      .returning({ id: payrollRuns.id }),
  );
  if (!run) throw new Error("payroll run insert returned no row");
  const billId = await insertBill(db, company, {
    payeeId: employee.payeeId,
    categoryId,
    payrollRunId: run.id,
    overviewHeading: "salaries",
    amountKes: 5_000_000n,
  });
  runIds.set(billId, run.id);
  return { subjectType: "bill", subjectId: billId, payrollRunId: run.id };
}

async function employeeClaim(): Promise<Subject> {
  const claim = await seed.expense({
    categoryId,
    kind: "claim",
    status: "paid",
    membershipId: employee.membershipId,
    merchant: "Uber",
  });
  return { subjectType: "claim", subjectId: claim.id, payrollRunId: null };
}

async function floatIssue(): Promise<Subject> {
  const float = await seed.openFloat(employee.membershipId);
  const { movementId, payout } = await seed.floatPayment(
    float.id,
    "issue",
    500_000n,
    new Date(),
  );
  // Each case writes the issue's payouts itself.
  await runInScope(db, asAdmin(company), (tx) =>
    tx
      .update(payouts)
      .set({ status: "failed", paidAt: null })
      .where(eq(payouts.id, payout.id)),
  );
  floatIds.set(movementId, float.id);
  return { subjectType: "float", subjectId: movementId, payrollRunId: null };
}

/** The float each movement belongs to, and the run each salary is paid in. */
const floatIds = new Map<string, string>();
const runIds = new Map<string, string>();

function found<T>(item: T | undefined, what: string): T {
  if (item === undefined) throw new Error(`${what} isn't in the response`);
  return item;
}

const SURFACES: readonly Surface[] = [
  {
    name: "the bills list",
    splits: false,
    subject: supplierBill,
    receiptsOf: async (billId) => {
      const bills = billsResponseSchema.parse(await read(admin(), "/bills"));
      return found(
        bills.find((bill) => bill.id === billId),
        "the bill",
      ).paymentReceipts;
    },
  },
  {
    name: "a bill",
    splits: false,
    subject: supplierBill,
    receiptsOf: async (billId) =>
      billDetailSchema.parse(await read(admin(), `/bills/${billId}`))
        .paymentReceipts,
  },
  {
    name: "a salary's bill",
    splits: true,
    subject: salaryBill,
    receiptsOf: async (billId) =>
      billDetailSchema.parse(await read(admin(), `/bills/${billId}`))
        .paymentReceipts,
  },
  {
    name: "a payroll run's payment",
    splits: true,
    subject: salaryBill,
    receiptsOf: async (billId) => {
      const run = payrollRunDetailSchema.parse(
        await read(
          admin(),
          `/payroll-runs/${found(runIds.get(billId), "the run")}`,
        ),
      );
      return found(
        run.payments.find((payment) => payment.billId === billId),
        "the payment",
      ).paymentReceipts;
    },
  },
  {
    name: "the employee's own salary payments",
    splits: true,
    subject: salaryBill,
    receiptsOf: async (billId) => {
      const payments = mySalaryPaymentsResponseSchema.parse(
        await read(employee.user, "/me/salary-payments"),
      );
      return found(
        payments.find((payment) => payment.id === billId),
        "the payment",
      ).paymentReceipts;
    },
  },
  {
    name: "the employee's own claims",
    splits: false,
    subject: employeeClaim,
    receiptsOf: async (claimId) => {
      const page = claimsPageSchema.parse(await read(employee.user, "/claims"));
      return found(
        page.claims.find((claim) => claim.id === claimId),
        "the claim",
      ).paymentReceipts;
    },
  },
  {
    name: "the employee's own claim",
    splits: false,
    subject: employeeClaim,
    receiptsOf: async (claimId) =>
      claimDetailSchema.parse(await read(employee.user, `/claims/${claimId}`))
        .paymentReceipts,
  },
  {
    name: "a claim, to the approver",
    splits: false,
    subject: employeeClaim,
    receiptsOf: async (claimId) =>
      claimDetailSchema.parse(await read(admin(), `/claims/${claimId}`))
        .paymentReceipts,
  },
  {
    name: "the expenses list",
    splits: false,
    subject: employeeClaim,
    receiptsOf: async (claimId) => {
      const page = expensesPageSchema.parse(await read(admin(), "/expenses"));
      return found(
        page.expenses.find((expense) => expense.id === claimId),
        "the expense",
      ).paymentReceipts;
    },
  },
  {
    name: "an expense",
    splits: false,
    subject: employeeClaim,
    receiptsOf: async (claimId) =>
      expenseDetailSchema.parse(await read(admin(), `/expenses/${claimId}`))
        .paymentReceipts,
  },
  {
    name: "a float's issue, to its holder",
    splits: false,
    subject: floatIssue,
    receiptsOf: async (movementId) => {
      const float = floatDetailSchema.parse(
        await read(
          employee.user,
          `/floats/${found(floatIds.get(movementId), "the float")}`,
        ),
      );
      return found(
        float.movements.find((movement) => movement.id === movementId),
        "the movement",
      ).paymentReceipts;
    },
  },
  {
    name: "the wallet history",
    splits: false,
    subject: supplierBill,
    receiptsOf: async (billId) => {
      const history = walletHistoryResponseSchema.parse(
        await read(admin(), "/wallet/history"),
      );
      return history.items
        .filter((item) => item.payout?.subjectId === billId)
        .reverse()
        .flatMap((item) => item.payout?.paymentReceipts ?? []);
    },
  },
];

describe.each(SURFACES)("paymentReceipts on $name", (surface) => {
  it("shows a paid M-Pesa cash-out's receipt", async () => {
    // #given
    const subject = await surface.subject();
    await payoutOf(subject, paidMpesa("UKDCW299LW"));

    // #when
    const receipts = await surface.receiptsOf(subject.subjectId);

    // #then
    expect(receipts).toEqual([{ kind: "mpesa", code: "UKDCW299LW" }]);
  });

  it("shows a paid bank cash-out's reference", async () => {
    // #given
    const subject = await surface.subject();
    await payoutOf(subject, {
      provider: "paycrest",
      method: "bank",
      status: "paid",
      providerReference: "FT26317XK9QZ",
    });

    // #when
    const receipts = await surface.receiptsOf(subject.subjectId);

    // #then
    expect(receipts).toEqual([{ kind: "bank", code: "FT26317XK9QZ" }]);
  });

  it.each<[string, Outcome]>([
    [
      "still being paid",
      { ...paidMpesa("UKDCW299LW"), status: "paying", providerReference: null },
    ],
    ["failed", { ...paidMpesa("UKDCW299LW"), status: "failed" }],
    ["paid with no receipt yet", { ...paidMpesa(""), providerReference: null }],
    ["paid with an empty receipt", paidMpesa("")],
    [
      "a USDC payout, whose hash is no receipt",
      {
        provider: "onchain",
        method: "usdc",
        status: "paid",
        providerReference: randomTxHash(),
      },
    ],
  ])("shows none for a payout %s", async (_name, outcome) => {
    // #given
    const subject = await surface.subject();
    await payoutOf(subject, outcome);

    // #when
    const receipts = await surface.receiptsOf(subject.subjectId);

    // #then
    expect(receipts).toEqual([]);
  });

  it("shows only the paid retry's receipt after a failed attempt", async () => {
    // #given
    const subject = await surface.subject();
    await payoutOf(subject, { ...paidMpesa("UKDFAILED1"), status: "failed" });
    await payoutOf(subject, paidMpesa("UKDRETRY22"));

    // #when
    const receipts = await surface.receiptsOf(subject.subjectId);

    // #then
    expect(receipts).toEqual([{ kind: "mpesa", code: "UKDRETRY22" }]);
  });
});

describe.each(SURFACES.filter((surface) => surface.splits))(
  "paymentReceipts of a split salary on $name",
  (surface) => {
    it("shows each cash-out, in part order", async () => {
      // #given parts written out of order
      const subject = await surface.subject();
      await payoutOf(subject, paidMpesa("UKDPART002"), 2);
      await payoutOf(subject, paidMpesa("UKDPART001"), 1);

      // #when
      const receipts = await surface.receiptsOf(subject.subjectId);

      // #then
      expect(receipts).toEqual([
        { kind: "mpesa", code: "UKDPART001" },
        { kind: "mpesa", code: "UKDPART002" },
      ]);
    });
  },
);

describe("who sees paymentReceipts", () => {
  it("keeps another employee's claim, and its receipt, from them", async () => {
    // #given
    const subject = await employeeClaim();
    await payoutOf(subject, paidMpesa("UKDCW299LW"));
    const colleague = await createUser(db);
    await addMember(db, company, colleague);

    // #when
    const response = await sendJson(
      app,
      companyPath(`/claims/${subject.subjectId}`),
      colleague,
    );

    // #then
    expect(response.status).toBe(404);
  });

  it("sends an empty list for a bill never paid through Expendi", async () => {
    // #given
    const payeeId = await insertPayee(db, company);
    const { billId } = await seed.paidOutsideBill({ payeeId, categoryId });

    // #when
    const bill = (await read(admin(), `/bills/${billId}`)) as Record<
      string,
      unknown
    >;

    // #then
    expect(bill.paymentReceipts).toEqual([]);
  });
});
