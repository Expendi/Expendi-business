import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ExpenseStatus } from "@expendi-business/shared";
import {
  companyDetailSchema,
  companySearchResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { expenses, organizations, wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { withStaffReadScope } from "../../services/staff/staff-scope.js";
import { addCategory } from "../helpers/claims.js";
import {
  addMember,
  createActiveNearWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import { makeFakePaycrest } from "../helpers/fakes.js";
import { randomNearAccount } from "../helpers/near.js";
import {
  claimRequest,
  createPayingCompany,
  payClaims,
  USDC,
} from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const paycrest = makeFakePaycrest();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let viewer: TestStaff;

beforeAll(async () => {
  runtime = makeTestRuntime({ paycrest: paycrest.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  viewer = await createStaff(owner, { role: "ops_viewer" });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(() => {
  paycrest.state.reset();
});

async function get(path: string, staff = viewer): Promise<Response> {
  return app.request(path, { headers: bearer(staff.privyUserId) });
}

async function dataOf(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

async function setKraPin(company: TestCompany, kraPin: string): Promise<void> {
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .update(organizations)
      .set({ kraPin })
      .where(sql`${organizations.id} = ${company.organizationId}`),
  );
}

async function addClaim(
  company: TestCompany,
  status: ExpenseStatus,
  amountKes: bigint,
): Promise<void> {
  const categoryId = await addCategory(db, company, `Travel ${randomUUID()}`);
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(expenses).values({
      organizationId: company.organizationId,
      membershipId: company.adminMembershipId,
      kind: "claim",
      overviewHeading: "transactions",
      categoryId,
      merchant: "Naivas",
      amountKes,
      spentOn: "2026-11-01",
      status,
      rejectedReason: status === "rejected" ? "Not a business expense" : null,
    }),
  );
}

describe("GET /internal/companies", () => {
  it("finds companies by any part of the name, in any case, for a viewer", async () => {
    // #given
    const tag = randomUUID().slice(0, 8);
    const company = await createCompany(db, `Acme ${tag} Logistics`);
    await createCompany(db, `Other ${randomUUID().slice(0, 8)}`);

    // #when
    const result = companySearchResponseSchema.parse(
      await dataOf(
        await get(`/internal/companies?search=${tag.toUpperCase()}`),
      ),
    );

    // #then
    expect(result.companies).toEqual([
      expect.objectContaining({
        id: company.organizationId,
        name: company.name,
        payoutsPaused: false,
      }),
    ]);
  });

  it("finds a company by its exact KRA PIN", async () => {
    // #given
    const company = await createCompany(db);
    const kraPin = `P${Math.floor(Math.random() * 1e9)
      .toString()
      .padStart(9, "0")}Z`;
    await setKraPin(company, kraPin);

    // #when
    const result = companySearchResponseSchema.parse(
      await dataOf(
        await get(`/internal/companies?search=${kraPin.toLowerCase()}`),
      ),
    );

    // #then
    expect(result.companies.map((found) => found.id)).toEqual([
      company.organizationId,
    ]);
  });

  it("pages by name without skipping or repeating", async () => {
    // #given
    const tag = randomUUID().slice(0, 8);
    const names = ["b", "a", "c"].map((letter) => `${tag} ${letter}`);
    await Promise.all(names.map((name) => createCompany(db, name)));
    const base = `/internal/companies?search=${tag}&limit=2`;

    // #when
    const first = companySearchResponseSchema.parse(
      await dataOf(await get(base)),
    );
    const second = companySearchResponseSchema.parse(
      await dataOf(await get(`${base}&cursor=${first.nextCursor ?? ""}`)),
    );

    // #then
    expect(
      [...first.companies, ...second.companies].map((found) => found.name),
    ).toEqual([`${tag} a`, `${tag} b`, `${tag} c`]);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a company admin who isn't staff", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const response = await app.request("/internal/companies", {
      headers: bearer(company.admin.privyUserId),
    });

    // #then
    expect(response.status).toBe(403);
  });
});

describe("GET /internal/companies/:id", () => {
  let paying: PayingCompany;
  let other: PayingCompany;

  beforeEach(async () => {
    [paying, other] = await Promise.all([
      createPayingCompany(runtime, db, 50n * USDC),
      createPayingCompany(runtime, db),
    ]);
  });

  it("shows members, wallet, cap, pause, unpaid claims and recent payouts", async () => {
    // #given
    const employee = await createUser(db);
    await addMember(db, paying.company, employee);
    await addClaim(paying.company, "submitted", 150_000n);
    await addClaim(paying.company, "payout_failed", 250_000n);
    await addClaim(paying.company, "paid", 999_900n);
    await addClaim(paying.company, "rejected", 10_000n);
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);

    // #when
    const detail = companyDetailSchema.parse(
      await dataOf(
        await get(`/internal/companies/${paying.company.organizationId}`),
      ),
    );

    // #then
    expect(detail).toMatchObject({
      id: paying.company.organizationId,
      name: paying.company.name,
      payoutsPaused: false,
      platformPayoutsPaused: false,
      dailyPayoutCapKesCents: "20000000",
      wallet: {
        status: "active",
        address: paying.wallet.address,
        usdcBalance: (
          50n * USDC -
          (payout?.amountToTransferUsdc ?? 0n)
        ).toString(),
        kesEquivalent: { rate: "128.68" },
      },
      unpaidClaims: { count: 2, totalKesCents: "400000" },
    });
    expect(
      detail.members.map(({ email, role, status }) => ({
        email,
        role,
        status,
      })),
    ).toEqual(
      expect.arrayContaining([
        { email: paying.company.admin.email, role: "admin", status: "active" },
        { email: employee.email, role: "employee", status: "active" },
      ]),
    );
    expect(detail.recentPayouts.map((recent) => recent.id)).toEqual([
      payout?.id,
    ]);
  });

  it("shows where the company keeps its USDC, and no reading for a company that keeps it in the company wallet", async () => {
    // #when
    const detail = companyDetailSchema.parse(
      await dataOf(
        await get(`/internal/companies/${paying.company.organizationId}`),
      ),
    );

    // #then
    expect(detail.wallet).toMatchObject({
      balanceHome: "company_wallet",
      confidentialUsdc: null,
      confidentialUsdcReadAt: null,
    });
  });

  it("shows the confidential account reading the alert check last saved, without reading it", async () => {
    // #given
    const company = await createCompany(db);
    const wallet = await createActiveNearWallet(
      db,
      company,
      { privyWalletId: `near-${randomUUID()}`, accountId: randomNearAccount() },
      undefined,
      "confidential_account",
    );
    const readAt = new Date("2026-11-13T09:30:00.000Z");
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(wallets)
        .set({ confidentialUsdc: 12_500_000n, confidentialUsdcReadAt: readAt })
        .where(eq(wallets.id, wallet.id)),
    );

    // #when
    const detail = companyDetailSchema.parse(
      await dataOf(await get(`/internal/companies/${company.organizationId}`)),
    );

    // #then
    expect(detail.wallet).toMatchObject({
      balanceHome: "confidential_account",
      confidentialUsdc: "12500000",
      confidentialUsdcReadAt: readAt.toISOString(),
    });
  });

  it("shows no reading for a confidential company the check hasn't read yet", async () => {
    // #given
    const company = await createCompany(db);
    await createActiveNearWallet(
      db,
      company,
      { privyWalletId: `near-${randomUUID()}`, accountId: randomNearAccount() },
      undefined,
      "confidential_account",
    );

    // #when
    const detail = companyDetailSchema.parse(
      await dataOf(await get(`/internal/companies/${company.organizationId}`)),
    );

    // #then
    expect(detail.wallet).toMatchObject({
      balanceHome: "confidential_account",
      confidentialUsdc: null,
      confidentialUsdcReadAt: null,
    });
  });

  it("shows nothing of another company", async () => {
    // #given
    await payClaims(runtime, db, other, [claimRequest()]);

    // #when
    const detail = companyDetailSchema.parse(
      await dataOf(
        await get(`/internal/companies/${paying.company.organizationId}`),
      ),
    );

    // #then
    expect(detail.members.map((member) => member.email)).toEqual([
      paying.company.admin.email,
    ]);
    expect(detail.recentPayouts).toEqual([]);
    expect(detail.wallet?.address).toBe(paying.wallet.address);
  });

  it("leaves out the KES equivalent while Paycrest is down", async () => {
    // #given
    paycrest.state.failRate = true;

    // #when
    const detail = companyDetailSchema.parse(
      await dataOf(
        await get(`/internal/companies/${paying.company.organizationId}`),
      ),
    );

    // #then
    expect(detail.wallet?.kesEquivalent).toBeNull();
  });

  it.each(["not-a-uuid", randomUUID()])("returns 404 for %s", async (id) => {
    // #when
    const response = await get(`/internal/companies/${id}`);

    // #then
    expect(response.status).toBe(404);
  });
});

describe("staff reads", () => {
  it("run in a read-only transaction, so even a company's scope can't be written", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const attempt = runtime.runPromise(
      withStaffReadScope({ organizationId: company.organizationId }, (tx) =>
        Effect.tryPromise(() =>
          tx
            .update(organizations)
            .set({ payoutsPaused: true })
            .where(sql`${organizations.id} = ${company.organizationId}`),
        ),
      ),
    );

    // #then
    await expect(attempt).rejects.toThrow();
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx.select({ paused: organizations.payoutsPaused }).from(organizations),
    );
    expect(row?.paused).toBe(false);
  });
});

describe("staff logins on customer routes", () => {
  it("get no company's data through them", async () => {
    // #given
    const admin = await createStaff(owner, { role: "ops_admin" });
    const company = await createCompany(db);
    const base = `/organizations/${company.organizationId}`;

    // #when
    const statuses = await Promise.all(
      ["", "/wallet", "/claims", "/members", "/withdrawals", "/payees"].map(
        async (path) =>
          (
            await app.request(`${base}${path}`, {
              headers: bearer(admin.privyUserId),
            })
          ).status,
      ),
    );

    // #then
    expect(statuses).toEqual([403, 403, 403, 403, 403, 403]);
  });
});
