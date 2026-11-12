import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MeResponse } from "@expendi-business/shared";
import { meResponseSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { PayrollPerson } from "../helpers/payroll.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { users, walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { isReadRequest } from "../../middleware/tenant.js";
import { draftDuePayroll } from "../../services/payroll/drafts.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import { randomTxHash } from "../helpers/chain.js";
import {
  addCategory,
  claimRequest,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
  randomEmail,
} from "../helpers/db.js";
import { makeFakeFileStorage } from "../helpers/fakes.js";
import { createCustomerAndInvoice } from "../helpers/invoices.js";
import {
  addEmployeePayee,
  billsOfRun,
  insertSalary,
  runsOf,
} from "../helpers/payroll.js";
import { insertRecurringItem } from "../helpers/recurring.js";
import { fakePrivyEmails, makeTestRuntime } from "../helpers/runtime.js";

const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;

beforeAll(async () => {
  runtime = makeTestRuntime({ fileStorage: storage.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(async () => {
  await runtime.dispose();
});

/** 23 Nov in Nairobi: a salary paid on 28 Nov gets its run drafted. */
const NOV_23_MIDNIGHT_EAT = new Date("2026-11-22T21:00:00Z");

/** A company with something in every kind of record, and its accountant. */
interface Books {
  readonly company: TestCompany;
  readonly amina: PayrollPerson;
  readonly accountant: TestUser;
  readonly accountantMembershipId: string;
  /** A real ID for each route parameter, so every read finds something. */
  readonly ids: {
    readonly billId: string;
    readonly claimId: string;
    readonly customerId: string;
    readonly invoiceId: string;
    readonly floatId: string;
    readonly cardId: string;
    readonly itemId: string;
    readonly payeeId: string;
    readonly runId: string;
    readonly salaryId: string;
    readonly spendingId: string;
  };
}

async function created(response: Response): Promise<string> {
  if (response.status !== 201) {
    throw new Error(`answered ${response.status}: ${await response.text()}`);
  }
  const { data } = (await response.json()) as { data: { id: string } };
  return data.id;
}

async function submitClaim(
  company: TestCompany,
  user: TestUser,
  categoryId: string,
): Promise<string> {
  const photo = await uploadReceipt(app, storage, company, user);
  return created(
    await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      user,
      {
        method: "POST",
        body: claimRequest({
          categoryId,
          receiptFileIds: [photo.receiptFileId],
        }),
      },
    ),
  );
}

async function recordCompanySpending(
  company: TestCompany,
  categoryId: string,
): Promise<string> {
  const base = `/organizations/${company.organizationId}`;
  const accountId = await created(
    await sendJson(app, `${base}/paid-from-accounts`, company.admin, {
      method: "POST",
      body: { name: "KCB current account", kind: "bank" },
    }),
  );
  const photo = await uploadReceipt(app, storage, company, company.admin);
  return created(
    await sendJson(app, `${base}/company-spending`, company.admin, {
      method: "POST",
      body: {
        merchant: "Kenya Power",
        amountKes: "4,500.00",
        spentOn: "2026-10-20",
        categoryId,
        description: "October electricity",
        paidFromAccountId: accountId,
        receiptFileIds: [photo.receiptFileId],
      },
    }),
  );
}

/** A float written straight to the table, held by `membershipId`. */
async function openFloat(
  company: TestCompany,
  membershipId: string,
): Promise<string> {
  const [float] = await runInScope(
    db,
    {
      organizationId: company.organizationId,
      userId: company.admin.id,
      role: "admin",
    },
    (tx) =>
      tx.execute<{ id: string }>(
        sql`INSERT INTO floats (organization_id, membership_id) VALUES (${company.organizationId}, ${membershipId}) RETURNING id`,
      ),
  ).then((result) => result.rows);
  if (!float) throw new Error("float insert returned no row");
  return float.id;
}

/** A company with cards on and one card, written straight to the tables. */
async function openCard(
  company: TestCompany,
  membershipId: string,
  categoryId: string,
): Promise<string> {
  const { organizationId, admin } = company;
  const { rows } = await runInScope(
    db,
    { organizationId, userId: admin.id, role: "admin" },
    (tx) =>
      tx.execute<{ id: string }>(sql`
        WITH account AS (
          INSERT INTO paid_from_accounts (organization_id, name, kind)
          VALUES (${organizationId}, 'Expendi cards', 'card') RETURNING id
        ), program AS (
          INSERT INTO card_programs (organization_id, legal_name, kra_pin, address_line1, city, postal_code, phone, contact_first_name, contact_last_name, contact_email, contact_phone, lithic_account_holder_token, lithic_account_token, paid_from_account_id, turned_on_by)
          SELECT ${organizationId}, 'Books Ltd', 'P051234567X', 'Waiyaki Way', 'Nairobi', '00100', '+254700000001', 'Amina', 'Otieno', 'amina@example.com', '+254700000002', 'holder-books', 'account-books', account.id, ${admin.id}
          FROM account
        ), holder AS (
          INSERT INTO cardholders (organization_id, membership_id, lithic_account_holder_token, lithic_account_token)
          VALUES (${organizationId}, ${membershipId}, 'holder-amina', 'account-amina') RETURNING id
        )
        INSERT INTO cards (organization_id, cardholder_id, membership_id, lithic_card_token, nickname, last_four, monthly_limit_usd_cents, default_category_id, issued_by)
        SELECT ${organizationId}, holder.id, ${membershipId}, ${`card-${randomUUID()}`}, 'Books card', '4242', 50000, ${categoryId}, ${admin.id}
        FROM holder
        RETURNING id
      `),
  );
  const [card] = rows;
  if (!card) throw new Error("card insert returned no row");
  return card.id;
}

async function seedBooks(): Promise<Books> {
  const company = await createCompany(db);
  const wallet = await createActiveWallet(db, company);
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(walletTransactions).values({
      organizationId: company.organizationId,
      walletId: wallet.id,
      type: "deposit",
      usdcAmount: 250_000_000n,
      txHash: randomTxHash(),
      logIndex: 0,
      blockNumber: 1n,
    }),
  );
  const officeId = await addCategory(db, company, "Office");
  const salariesId = await addCategory(db, company, "Salaries");

  const amina = await addEmployeePayee(db, company, "Amina");
  const salaryId = await insertSalary(db, company, {
    payeeId: amina.payeeId,
    categoryId: salariesId,
    amountKes: 6_000_000n,
  });
  await runtime.runPromise(
    draftDuePayroll(company.organizationId, NOV_23_MIDNIGHT_EAT),
  );
  const [run] = await runsOf(db, company);
  if (!run) throw new Error("no payroll run drafted");

  const payeeId = await insertPayee(db, company);
  const itemId = await insertRecurringItem(db, company, {
    payeeId,
    categoryId: officeId,
  });
  const billId = await insertBill(db, company, {
    payeeId,
    categoryId: officeId,
  });
  const invoice = await createCustomerAndInvoice(db, company);
  const claimId = await submitClaim(company, amina.user, officeId);
  const spendingId = await recordCompanySpending(company, officeId);
  const floatId = await openFloat(company, amina.membershipId);
  const cardId = await openCard(company, amina.membershipId, officeId);

  const accountant = await createUser(db);
  const accountantMembershipId = await addMember(db, company, accountant, {
    role: "accountant",
  });
  return {
    company,
    amina,
    accountant,
    accountantMembershipId,
    ids: {
      billId,
      claimId,
      customerId: invoice.customerId,
      invoiceId: invoice.invoiceId,
      itemId,
      payeeId,
      runId: run.id,
      salaryId,
      spendingId,
      floatId,
      cardId,
    },
  };
}

interface Endpoint {
  readonly method: string;
  readonly path: string;
}

const COMPANY_ROUTES = "/organizations/:organizationId";

/**
 * Every route the app registers under a company, so these rules cover each
 * route added later without being edited.
 */
function companyEndpoints(target: App): Endpoint[] {
  const byRoute = new Map<string, Endpoint>();
  for (const route of target.routes) {
    // `use()` middleware is registered as method ALL on a wildcard path.
    if (!route.path.startsWith(COMPANY_ROUTES) || route.path.endsWith("*")) {
      continue;
    }
    const method = route.method === "ALL" ? "POST" : route.method;
    byRoute.set(`${method} ${route.path}`, { method, path: route.path });
  }
  return [...byRoute.values()];
}

const keyOf = ({ method, path }: Endpoint) => `${method} ${path}`;

/** Fills each `:param` from `values`, or with a random ID when none is given. */
function concretePath(
  path: string,
  values: Readonly<Record<string, string>>,
): string {
  return path.replace(
    /:([A-Za-z]+)/g,
    (_match, name: string) => values[name] ?? randomUUID(),
  );
}

const hasValueFor = (
  path: string,
  values: Readonly<Record<string, string>>,
): boolean =>
  (path.match(/:[A-Za-z]+/g) ?? []).every((param) => param.slice(1) in values);

/**
 * Reads that answer about the caller rather than the company, so an
 * accountant rightly gets a different answer from an admin.
 */
const ABOUT_THE_CALLER = new Map([
  [`GET ${COMPANY_ROUTES}`, "names the caller's own role"],
  [`GET ${COMPANY_ROUTES}/me/salary-payments`, "the caller's own salary"],
]);

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** Presigned links expire relative to the request, so their times differ. */
const withoutExpiry = (text: string): unknown =>
  text === ""
    ? null
    : (JSON.parse(text, (key, value: unknown) =>
        key === "expiresAt" ? "<expires>" : value,
      ) as unknown);

async function answer(
  path: string,
  user: Pick<TestUser, "privyUserId">,
  method = "GET",
): Promise<Answer> {
  const response = await sendJson(app, path, user, {
    method,
    body: isReadRequest(method) ? undefined : {},
  });
  const download = response.headers
    .get("content-disposition")
    ?.startsWith("attachment");
  return {
    status: response.status,
    // A downloaded file is compared byte for byte.
    body: download
      ? Buffer.from(await response.arrayBuffer()).toString("base64")
      : withoutExpiry(await response.text()),
  };
}

const dataOf = (body: unknown): unknown =>
  (body as { data?: unknown } | null)?.data;

let books: Books;

beforeEach(async () => {
  storage.state.reset();
  books = await seedBooks();
});

const companyPath = (company: TestCompany, rest = "") =>
  `/organizations/${company.organizationId}${rest}`;

const routeValues = (target: Books): Record<string, string> => ({
  organizationId: target.company.organizationId,
  personId: target.amina.membershipId,
  expenseId: target.ids.claimId,
  month: "2026-10",
  format: "workbook",
  ...target.ids,
});

describe("company routes for an accountant", () => {
  it("finds the routes, actions included", () => {
    // #then
    expect(companyEndpoints(app).map(keyOf)).toEqual(
      expect.arrayContaining([
        `GET ${COMPANY_ROUTES}/activity`,
        `GET ${COMPANY_ROUTES}/cards`,
        `GET ${COMPANY_ROUTES}/cards/:cardId`,
        `GET ${COMPANY_ROUTES}/cards/loads`,
        `GET ${COMPANY_ROUTES}/cards/program`,
        `POST ${COMPANY_ROUTES}/cards/program`,
        `POST ${COMPANY_ROUTES}/cards/confirmations`,
        `POST ${COMPANY_ROUTES}/cards/confirmations/:challengeId`,
        `POST ${COMPANY_ROUTES}/cards/:cardId/freeze`,
        `POST ${COMPANY_ROUTES}/cards/:cardId/close`,
        `POST ${COMPANY_ROUTES}/cards/:cardId/lower-limit`,
        `GET ${COMPANY_ROUTES}/categories`,
        `POST ${COMPANY_ROUTES}/categories`,
        `PATCH ${COMPANY_ROUTES}/categories/:categoryId`,
        `POST ${COMPANY_ROUTES}/categories/:categoryId/archive`,
        `POST ${COMPANY_ROUTES}/categories/:categoryId/restore`,
        `GET ${COMPANY_ROUTES}/claims`,
        `POST ${COMPANY_ROUTES}/claims`,
        `POST ${COMPANY_ROUTES}/claims/approval`,
        `GET ${COMPANY_ROUTES}/customers`,
        `POST ${COMPANY_ROUTES}/customers`,
        `PATCH ${COMPANY_ROUTES}/customers/:customerId`,
        `GET ${COMPANY_ROUTES}/invoices`,
        `GET ${COMPANY_ROUTES}/invoices/:invoiceId`,
        `POST ${COMPANY_ROUTES}/invoices/:invoiceId/send`,
        `POST ${COMPANY_ROUTES}/invoices/:invoiceId/void`,
        `GET ${COMPANY_ROUTES}/expenses`,
        `GET ${COMPANY_ROUTES}/expenses/:expenseId`,
        `GET ${COMPANY_ROUTES}/overview`,
        `GET ${COMPANY_ROUTES}/overview/people/:personId`,
        `GET ${COMPANY_ROUTES}/payroll-runs/:runId`,
        `GET ${COMPANY_ROUTES}/salaries`,
        `PATCH ${COMPANY_ROUTES}/salaries/:salaryId`,
        `GET ${COMPANY_ROUTES}/treasury`,
        `POST ${COMPANY_ROUTES}/treasury`,
        `POST ${COMPANY_ROUTES}/treasury/confirmations`,
        `POST ${COMPANY_ROUTES}/withdrawals`,
        `DELETE ${COMPANY_ROUTES}/members/:membershipId`,
        `POST ${COMPANY_ROUTES}/receipts/upload-url`,
        `GET ${COMPANY_ROUTES}/reports/:month/:format`,
        `GET ${COMPANY_ROUTES}/reports/exports`,
        `POST ${COMPANY_ROUTES}/reports/exports`,
        `GET ${COMPANY_ROUTES}/reports/exports/:exportId/files/:file`,
      ]),
    );
  });

  it("refuses every action to an accountant with a valid token", async () => {
    // #given
    const actions = companyEndpoints(app).filter(
      ({ method }) => !isReadRequest(method),
    );
    expect(actions.length).toBeGreaterThan(0);

    // #when
    const refusals = await Promise.all(
      actions.map(async (endpoint) => {
        const { status, body } = await answer(
          concretePath(endpoint.path, routeValues(books)),
          books.accountant,
          endpoint.method,
        );
        const tag = (body as { error?: { _tag?: string } } | null)?.error?._tag;
        return [keyOf(endpoint), status, tag];
      }),
    );

    // #then
    expect(refusals).toEqual(
      actions.map((endpoint) => [keyOf(endpoint), 403, "Forbidden"]),
    );
  });

  it("gives an accountant company-data reads, salaries included, while imports remain admin-only", async () => {
    // #given
    const values = routeValues(books);
    const reads = companyEndpoints(app).filter(({ method }) =>
      isReadRequest(method),
    );

    // #when
    const answers = await Promise.all(
      reads.map(async (endpoint) => {
        const path = concretePath(endpoint.path, values);
        const [asAdmin, asAccountant] = await Promise.all([
          answer(path, books.company.admin),
          answer(path, books.accountant),
        ]);
        return { key: keyOf(endpoint), endpoint, asAdmin, asAccountant };
      }),
    );

    // #then every read with real IDs finds something for the admin
    expect(
      answers
        .filter(({ endpoint }) => hasValueFor(endpoint.path, values))
        .filter(({ asAdmin }) => asAdmin.status !== 200)
        .map(({ key, asAdmin }) => [key, asAdmin.status]),
    ).toEqual([]);
    // Import provenance/results belong to the admin-only migration workspace.
    const importReads = new Set([
      `GET ${COMPANY_ROUTES}/imports`,
      `GET ${COMPANY_ROUTES}/imports/:id`,
    ]);
    expect(
      answers
        .filter(({ key }) => importReads.has(key))
        .map(({ asAccountant }) => asAccountant.status),
    ).toEqual([403, 403]);
    const companyReads = answers.filter(({ key }) => !importReads.has(key));
    // The accountant gets the same status for all other company reads.
    expect(
      companyReads.map(({ key, asAccountant }) => [key, asAccountant.status]),
    ).toEqual(companyReads.map(({ key, asAdmin }) => [key, asAdmin.status]));
    // and the same records, except where the answer is about the caller
    const aboutTheCompany = companyReads.filter(
      ({ key }) => !ABOUT_THE_CALLER.has(key),
    );
    expect(
      aboutTheCompany.map(({ key, asAccountant }) => [key, asAccountant.body]),
    ).toEqual(aboutTheCompany.map(({ key, asAdmin }) => [key, asAdmin.body]));
  });

  it("shows an accountant the salaries, payroll run, bills, claims, spending, floats and wallet history", async () => {
    // #given
    const { company, accountant, ids } = books;
    const read = async (rest: string) =>
      JSON.stringify(
        dataOf((await answer(companyPath(company, rest), accountant)).body),
      );

    // #when
    const seen = {
      salaries: await read("/salaries"),
      run: await read(`/payroll-runs/${ids.runId}`),
      bills: await read("/bills"),
      invoices: await read("/invoices"),
      customers: await read("/customers"),
      recurring: await read("/recurring-items"),
      claims: await read("/claims"),
      spending: await read("/company-spending"),
      floats: await read("/floats"),
      payees: await read("/payees"),
      team: await read("/members"),
      history: dataOf(
        (await answer(companyPath(company, "/wallet/history"), accountant))
          .body,
      ),
    };

    // #then
    const [aminaPay] = await billsOfRun(db, company, ids.runId);
    expect(aminaPay).toBeDefined();
    expect(seen.salaries).toContain(ids.salaryId);
    expect(seen.run).toContain(aminaPay?.id);
    expect(seen.bills).toContain(ids.billId);
    expect(seen.invoices).toContain(ids.invoiceId);
    expect(seen.customers).toContain(ids.customerId);
    expect(seen.recurring).toContain(ids.itemId);
    expect(seen.claims).toContain(ids.claimId);
    expect(seen.spending).toContain(ids.spendingId);
    expect(seen.floats).toContain(ids.floatId);
    expect(seen.payees).toContain(ids.payeeId);
    expect(seen.team).toContain(books.accountantMembershipId);
    expect(seen.history).toMatchObject({
      items: [expect.objectContaining({ type: "deposit" })],
    });
  });

  it("leaves employees seeing only their own claims and no admin records", async () => {
    // #given
    const { company, amina, ids } = books;
    const colleague = await createUser(db);
    await addMember(db, company, colleague);

    // #when
    const seen = {
      aminaClaims: JSON.stringify(
        dataOf(
          (await answer(companyPath(company, "/claims"), amina.user)).body,
        ),
      ),
      colleagueClaims: dataOf(
        (await answer(companyPath(company, "/claims"), colleague)).body,
      ),
      salaries: (await answer(companyPath(company, "/salaries"), amina.user))
        .status,
      bills: (await answer(companyPath(company, "/bills"), amina.user)).status,
      invoices: (await answer(companyPath(company, "/invoices"), amina.user))
        .status,
    };

    // #then
    expect(seen.aminaClaims).toContain(ids.claimId);
    expect(seen.colleagueClaims).toMatchObject({ claims: [] });
    expect([seen.salaries, seen.bills, seen.invoices]).toEqual([403, 403, 403]);
  });

  it("refuses a removed accountant on their very next request", async () => {
    // #given
    const { company, accountant, accountantMembershipId } = books;
    expect(
      (await answer(companyPath(company, "/claims"), accountant)).status,
    ).toBe(200);

    // #when
    const removal = await answer(
      companyPath(company, `/members/${accountantMembershipId}`),
      company.admin,
      "DELETE",
    );
    const next = await answer(companyPath(company, "/claims"), accountant);

    // #then
    expect(removal.status).toBe(200);
    expect(next.status).toBe(403);
  });
});

describe("an accountant linked by the accountant-logins migration", () => {
  it("claims the user on first sign-in and reads the company", async () => {
    // #given what the migration leaves: an active accountant whose user has
    // never signed in
    const email = randomEmail();
    const [user] = await db
      .insert(users)
      .values({ email, fullName: "Grace" })
      .returning({ id: users.id });
    if (!user) throw new Error("user insert returned no row");
    await addMember(
      db,
      books.company,
      { ...user, email, privyUserId: "" },
      { role: "accountant" },
    );
    const privyUserId = `did:privy:${randomUUID()}`;
    fakePrivyEmails.set(privyUserId, email);

    // #when
    const claims = await answer(companyPath(books.company, "/claims"), {
      privyUserId,
    });

    // #then
    expect(claims.status).toBe(200);
    expect(JSON.stringify(dataOf(claims.body))).toContain(books.ids.claimId);
    expect(
      await db.query.users.findFirst({ where: eq(users.id, user.id) }),
    ).toMatchObject({ privyUserId });
  });
});

describe("an accountant on several companies", () => {
  it("sees each company's records only in that company, and none elsewhere", async () => {
    // #given the same accountant keeps the books of a second company
    const other = await seedBooks();
    await addMember(db, other.company, books.accountant, {
      role: "accountant",
    });
    const stranger = await createCompany(db);
    const claimsOf = async (company: TestCompany) =>
      JSON.stringify(
        dataOf(
          (await answer(companyPath(company, "/claims"), books.accountant))
            .body,
        ),
      );

    // #when
    const first = await claimsOf(books.company);
    const second = await claimsOf(other.company);
    const elsewhere = await answer(
      companyPath(stranger, "/claims"),
      books.accountant,
    );

    // #then
    expect(first).toContain(books.ids.claimId);
    expect(first).not.toContain(other.ids.claimId);
    expect(second).toContain(other.ids.claimId);
    expect(second).not.toContain(books.ids.claimId);
    expect(elsewhere.status).toBe(403);
    expect(JSON.stringify(elsewhere.body)).not.toContain(stranger.name);
  });

  it("lists every company with its role on GET /me, so the app can send an accountant to the web dashboard", async () => {
    // #given
    const other = await createCompany(db);
    await addMember(db, other, books.accountant);

    // #when
    const me = await answer("/me", books.accountant);

    // #then
    expect(me.status).toBe(200);
    const { memberships } = meResponseSchema.parse(dataOf(me.body));
    expect(
      memberships.map(({ organizationId, role }) => ({ organizationId, role })),
    ).toEqual(
      expect.arrayContaining<
        Pick<MeResponse["memberships"][number], "organizationId" | "role">
      >([
        { organizationId: books.company.organizationId, role: "accountant" },
        { organizationId: other.organizationId, role: "employee" },
      ]),
    );
  });

  it("acts with each company's own role: an accountant in one, an employee in another", async () => {
    // #given
    const other = await createCompany(db);
    await addMember(db, other, books.accountant);

    // #when
    const statuses = {
      billsAsAccountant: (
        await answer(companyPath(books.company, "/bills"), books.accountant)
      ).status,
      billsAsEmployee: (
        await answer(companyPath(other, "/bills"), books.accountant)
      ).status,
      uploadAsAccountant: (
        await answer(
          companyPath(books.company, "/receipts/upload-url"),
          books.accountant,
          "POST",
        )
      ).status,
      uploadAsEmployee: (
        await answer(
          companyPath(other, "/receipts/upload-url"),
          books.accountant,
          "POST",
        )
      ).status,
    };

    // #then the employee's upload gets as far as checking the request
    expect(statuses).toEqual({
      billsAsAccountant: 200,
      billsAsEmployee: 403,
      uploadAsAccountant: 403,
      uploadAsEmployee: 400,
    });
  });
});

describe("row-level security for an accountant", () => {
  /** A deliberately unfiltered statement as the company's accountant. */
  function asAccountant<T extends Record<string, unknown>>(
    statement: ReturnType<typeof sql>,
  ) {
    return runInScope(
      db,
      {
        organizationId: books.company.organizationId,
        userId: books.accountant.id,
        role: "accountant",
      },
      (tx) => tx.execute<T>(statement),
    ).then((result) => result.rows);
  }

  it("reads salaries, payroll runs and their bills, other bills and floats", async () => {
    // #given
    const { company, ids } = books;
    const payrollBills = await billsOfRun(db, company, ids.runId);

    // #when
    const seen = {
      salaries: await asAccountant(
        sql`SELECT id FROM recurring_items WHERE overview_heading = 'salaries'`,
      ),
      runs: await asAccountant(sql`SELECT id FROM payroll_runs`),
      payrollBills: await asAccountant(
        sql`SELECT id FROM bills WHERE payroll_run_id IS NOT NULL`,
      ),
      bill: await asAccountant(
        sql`SELECT id FROM bills WHERE id = ${ids.billId}`,
      ),
      floats: await asAccountant(sql`SELECT id FROM floats`),
    };

    // #then
    expect(seen).toEqual({
      salaries: [{ id: ids.salaryId }],
      runs: [{ id: ids.runId }],
      payrollBills: payrollBills.map(({ id }) => ({ id })),
      bill: [{ id: ids.billId }],
      floats: [{ id: ids.floatId }],
    });
  });

  it("changes nothing: updates match no rows and inserts are refused", async () => {
    // #given
    const { company, ids } = books;

    // #when
    const updated = {
      salary: await asAccountant(
        sql`UPDATE recurring_items SET amount_kes = 1 WHERE id = ${ids.salaryId} RETURNING id`,
      ),
      run: await asAccountant(
        sql`UPDATE payroll_runs SET total_kes = 1 WHERE id = ${ids.runId} RETURNING id`,
      ),
      bill: await asAccountant(
        sql`UPDATE bills SET reference = 'tampered' WHERE id = ${ids.billId} RETURNING id`,
      ),
    };
    const inserts = await Promise.allSettled([
      asAccountant(
        sql`INSERT INTO bills (organization_id, payee_id, category_id, overview_heading, amount_kes, due_on, status)
            SELECT organization_id, payee_id, category_id, overview_heading, amount_kes, due_on, status
            FROM bills WHERE id = ${ids.billId}`,
      ),
      asAccountant(
        sql`INSERT INTO payroll_runs (organization_id, pay_date, total_kes, salaries_kes, cap_kes)
            VALUES (${company.organizationId}, '2027-01-28', 1, 1, 1)`,
      ),
    ]);

    // #then
    expect(updated).toEqual({ salary: [], run: [], bill: [] });
    expect(
      inserts.map((insert) =>
        insert.status === "rejected"
          ? (insert.reason as { cause?: { code?: string } }).cause?.code
          : "inserted",
      ),
    ).toEqual(["42501", "42501"]);
  });
});
