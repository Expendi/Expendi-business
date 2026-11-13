import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { markBillPaidOutside } from "../../services/bills/bills.js";
import { loadCardBalance } from "../../services/cards/loads.js";
import { applyCardTransaction } from "../../services/cards/transactions.js";
import { checkCash } from "../../services/overview/cash-check.js";
import { getSpendingOverview } from "../../services/overview/overview.js";
import { companyDetail } from "../../services/staff/companies.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import {
  createCardCompany,
  readPurchaseByToken,
} from "../helpers/card-purchases.js";
import { addCategory } from "../helpers/claims.js";
import {
  fakeLithicTransaction,
  makeFakePaycrest,
  makeFakePretium,
} from "../helpers/fakes.js";
import { createPayingCompany } from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * Every rate the apps show or value shillings at follows the active
 * cash-out provider. Changes the platform-wide setting, so it runs on its
 * own (vitest.serial.config.ts).
 */
const paycrest = makeFakePaycrest();
const pretium = makeFakePretium();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let staff: TestStaff;
let paying: PayingCompany;

const RATES = { paycrest: "128.68", pretium: "129.5" } as const;
const PROVIDERS = ["paycrest", "pretium"] as const;
type Provider = (typeof PROVIDERS)[number];

beforeAll(async () => {
  runtime = makeTestRuntime({
    paycrest: paycrest.layer,
    pretium: pretium.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  staff = await createStaff(owner, { role: "ops_admin" });
});

afterAll(async () => {
  await setProvider("paycrest");
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paycrest.state.reset();
  pretium.state.reset();
  await setProvider("paycrest");
  paying = await createPayingCompany(runtime, db);
});

afterEach(async () => {
  await setProvider("paycrest");
});

async function setProvider(provider: Provider): Promise<void> {
  await db.execute(
    sql`SELECT set_active_cash_out_provider(${provider}::cash_out_provider, ${staff.staffUserId}::uuid, 'Provider test', 'req-e2-rates', '203.0.113.9', 'e2-test')`,
  );
}

const tenant = (): Tenant => ({
  organizationId: paying.company.organizationId,
  userId: paying.company.admin.id,
  membershipId: paying.company.adminMembershipId,
  role: "admin",
});

describe.each(PROVIDERS)("while %s is active", (provider) => {
  const rate = RATES[provider];

  beforeEach(async () => {
    await setProvider(provider);
  });

  it("values the wallet at its rate", async () => {
    // #when
    const response = await app.request(
      `/organizations/${paying.company.organizationId}/wallet`,
      { headers: bearer(paying.company.admin.privyUserId) },
    );
    const body = (await response.json()) as {
      data: { kesEquivalent: { rate: string } | null };
    };

    // #then
    expect(body.data.kesEquivalent?.rate).toBe(rate);
  });

  it("values the cash check and the overview at its rate", async () => {
    // #when
    const cash = await runtime.runPromise(
      checkCash({
        organizationId: paying.company.organizationId,
        today: "2026-11-13",
        days: 7,
      }),
    );
    const overview = await runtime.runPromise(getSpendingOverview(tenant()));

    // #then
    expect([cash.rate, overview.cash.rate]).toEqual([rate, rate]);
  });

  it("shows staff the company's wallet at its rate", async () => {
    // #when
    const detail = await runtime.runPromise(
      companyDetail(paying.company.organizationId),
    );

    // #then
    expect(detail.wallet?.kesEquivalent?.rate).toBe(rate);
  });

  it("records a USD bill paid outside at its rate", async () => {
    // #given
    const payeeId = await insertPayee(db, paying.company);
    const categoryId = await addCategory(db, paying.company, "Software");
    const billId = await insertBill(db, paying.company, {
      payeeId,
      categoryId,
      currency: "usd",
      amountKes: null,
      amountUsdc: 20_000_000n,
    });

    // #when
    await runtime.runPromise(
      markBillPaidOutside(tenant(), billId, {
        paidOn: "2026-11-12",
        receiptFileIds: [],
      }),
    );

    // #then
    const { rows } = await owner.query<{ after: { rate: string } }>(
      "SELECT after FROM audit_log WHERE entity_id = $1 AND action = 'bill.marked_paid_outside'",
      [billId],
    );
    expect(rows.map((row) => row.after.rate)).toEqual([rate]);
  });

  it("counts a Card load and a Card purchase at its rate", async () => {
    // #given
    const card = await createCardCompany(db);
    const token = randomUUID();

    // #when
    const load = await runtime.runPromise(
      loadCardBalance(
        {
          organizationId: card.company.organizationId,
          userId: card.company.admin.id,
          membershipId: card.company.adminMembershipId,
          role: "admin",
        },
        { type: "load_balance", amountUsd: 10_000n },
        randomUUID(),
      ),
    );
    await runtime.runPromise(
      applyCardTransaction(
        fakeLithicTransaction({
          token,
          cardToken: card.cardToken,
          status: "SETTLED",
          settlement: -2500,
          events: ["AUTHORIZATION", "CLEARING"],
        }),
      ),
    );

    // #then
    const purchase = await readPurchaseByToken(db, card.company, token);
    expect([load.usdKesRate, purchase?.usdKesRate]).toEqual([rate, rate]);
  });
});
