import { count } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { TreasuryOffer } from "@expendi-business/shared";
import {
  billPaymentSchema,
  payrollRunPaymentSchema,
  treasuryOfferSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { treasuryMoves, treasurySnapshots } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { nairobiDate } from "../../services/bills/status.js";
import { draftDuePayroll } from "../../services/payroll/drafts.js";
import { requestWithdrawal } from "../../services/withdrawal/withdrawals.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import { TEST_ORIGIN } from "../helpers/fakes.js";
import {
  createNearPayingCompany,
  makeNearPayoutWorld,
} from "../helpers/near-payouts.js";
import { allowlistAddress } from "../helpers/payouts.js";
import {
  insertPersonnelPayee,
  insertSalary,
  runsOf,
} from "../helpers/payroll.js";
import {
  createTreasuryCompany,
  fundVault,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";

/**
 * A payment refused for lack of available USDC says how much is short and
 * how much Treasury holds, and offers Move to wallet. It moves nothing.
 */

const world = makeNearPayoutWorld({}, { PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, privy, paycrest } = world;
let db: Database;
let app: App;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(() => {
  privy.state.reset();
  paycrest.state.reset();
});

/** Whoever pays: a company with its admin's passkey, Treasury on or not. */
type Payer = Pick<NearPayingCompany, "company" | "passkey">;

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];

/** A company with 5 USDC to spend, plus `inVault` in Treasury. */
async function shortCompany(inVault: bigint): Promise<TreasuryCompany> {
  const company = await createTreasuryCompany(world, db, {
    balance: 5n * USDC,
  });
  fundVault(world, company, inVault);
  return company;
}

const errorOf = async (response: Response) =>
  (
    (await response.json()) as {
      error: { message: string; details?: Record<string, unknown> };
    }
  ).error;

const dataOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { data: unknown }).data;

const offerOf = (details: Record<string, unknown> | undefined): TreasuryOffer =>
  treasuryOfferSchema.parse(details?.treasuryOffer);

const movesStarted = async (company: Payer): Promise<number> => {
  const [row] = await runInScope(
    db,
    { organizationId: company.company.organizationId },
    (tx) => tx.select({ n: count() }).from(treasuryMoves),
  );
  return row?.n ?? 0;
};

/** A KES 2,500 bill to a till, due today, prepared for payment and confirmed. */
async function payBill(company: Payer): Promise<Response> {
  const orgPath = `/organizations/${company.company.organizationId}`;
  const categoryId = await addCategory(db, company.company, "Utilities");
  const payeeId = await insertPayee(db, company.company, {
    name: "Kenya Power",
    method: "mpesa_till",
    tillNumber: "123456",
    accountName: "Kenya Power",
    detailsChangedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const billId = await insertBill(db, company.company, {
    payeeId,
    categoryId,
    amountKes: 250_000n,
    dueOn: nairobiDate(new Date()),
    status: "due",
  });
  const prepared = await sendJson(
    app,
    `${orgPath}/bills/payment`,
    company.company.admin,
    { method: "POST", body: { billIds: [billId] } },
  );
  expect(prepared.status).toBe(201);
  const data = await dataOf(prepared);
  const payment = billPaymentSchema.parse(data);
  const { options } = data as { options: SignOptions };
  return sendJson(
    app,
    `${orgPath}/bills/payment/${payment.challengeId}/confirm`,
    company.company.admin,
    {
      method: "POST",
      body: { response: company.passkey.sign(options, TEST_ORIGIN) },
    },
  );
}

/** A drafted payroll run of three people, prepared and confirmed. */
async function payPayroll(company: Payer): Promise<Response> {
  const categoryId = await addCategory(db, company.company, "Salaries");
  for (const [name, amountKes] of [
    ["Amina Wanjiru", 6_000_000n],
    ["Brian Otieno", 4_000_000n],
  ] as const) {
    const payeeId = await insertPersonnelPayee(db, company.company, name);
    await insertSalary(db, company.company, { payeeId, categoryId, amountKes });
  }
  await runtime.runPromise(
    draftDuePayroll(
      company.company.organizationId,
      new Date("2026-11-22T21:00:00Z"),
    ),
  );
  const [run] = await runsOf(db, company.company);
  if (!run) throw new Error("no run drafted");
  const runPath = `/organizations/${company.company.organizationId}/payroll-runs/${run.id}`;
  const prepared = await sendJson(
    app,
    `${runPath}/payment`,
    company.company.admin,
    { method: "POST", body: {} },
  );
  expect(prepared.status).toBe(201);
  const data = await dataOf(prepared);
  const payment = payrollRunPaymentSchema.parse(data);
  const { options } = data as { options: SignOptions };
  return sendJson(
    app,
    `${runPath}/payment/${payment.challengeId}/confirm`,
    company.company.admin,
    {
      method: "POST",
      body: { response: company.passkey.sign(options, TEST_ORIGIN) },
    },
  );
}

describe("a bill payment refused because the wallet is short", () => {
  it("says how much is short and how much Treasury holds, and offers Move to wallet", async () => {
    // #given 5 USDC to spend and 400 in Treasury
    const company = await shortCompany(400n * USDC);

    // #when
    const response = await payBill(company);

    // #then
    const error = await errorOf(response);
    const offer = offerOf(error.details);
    expect({
      status: response.status,
      action: offer.action,
      held: offer.inTreasuryUsdc,
      shortfallIsDetailed: error.details?.shortfallUsdc === offer.shortfallUsdc,
      keepsTopUp: typeof error.details?.topUpKes,
      message: error.message,
    }).toEqual({
      status: 409,
      action: "move_to_wallet",
      held: (400n * USDC).toString(),
      shortfallIsDetailed: true,
      keepsTopUp: "string",
      message: expect.stringMatching(
        /short by \d+(\.\d+)? USDC and Treasury holds 400 USDC\. Use Move to wallet, then approve again\. Nothing was sent\./,
      ) as string,
    });
    expect(BigInt(offer.suggestedUsdc)).toBeGreaterThanOrEqual(
      BigInt(offer.shortfallUsdc),
    );
  });

  it("moves nothing: no move is started and the wallet and vault are as they were", async () => {
    // #given
    const company = await shortCompany(400n * USDC);

    // #when
    await payBill(company);

    // #then
    expect({
      moves: await movesStarted(company),
      vault: privy.state.vaultAssetsOf(company.treasuryPrivyWalletId),
      earnCalls: privy.state.earnCalls.length,
    }).toEqual({ moves: 0, vault: 400n * USDC, earnCalls: 0 });
  });

  it("offers the most Treasury holds when that is less than a move's minimum", async () => {
    // #given 4 USDC in Treasury
    const company = await shortCompany(4n * USDC);

    // #when
    const offer = offerOf((await errorOf(await payBill(company))).details);

    // #then
    expect(offer.suggestedUsdc).toBe((4n * USDC).toString());
  });

  it("keeps the usual refusal for a company with nothing in Treasury", async () => {
    // #given
    const company = await shortCompany(0n);

    // #when
    const error = await errorOf(await payBill(company));

    // #then
    expect({
      message: error.message,
      offer: error.details?.treasuryOffer,
      topUp: typeof error.details?.topUpKes,
    }).toEqual({
      message: expect.stringContaining("Top up KES") as string,
      offer: undefined,
      topUp: "string",
    });
  });

  it("offers from the last snapshot when Privy can't be reached", async () => {
    // #given a snapshot of 90 USDC and a Privy that fails
    const company = await shortCompany(400n * USDC);
    await runInScope(
      db,
      { organizationId: company.company.organizationId },
      (tx) =>
        tx.insert(treasurySnapshots).values({
          organizationId: company.company.organizationId,
          snapshotDate: "2026-11-12",
          assetsInVault: 90n * USDC,
          sharesInVault: 90n * USDC,
          userApy: 519,
          readAt: new Date("2026-11-12T06:00:00Z"),
        }),
    );
    privy.state.failNext("vaultPosition");

    // #when
    const offer = offerOf((await errorOf(await payBill(company))).details);

    // #then
    expect(offer.inTreasuryUsdc).toBe((90n * USDC).toString());
  });
});

describe("a payment refused when Treasury is off", () => {
  it("keeps the usual refusal, with no offer", async () => {
    // #given a company that never turned Treasury on
    const company = await createNearPayingCompany(world, db, {
      balance: 5n * USDC,
    });

    // #when
    const error = await errorOf(await payBill(company));

    // #then
    expect({
      message: error.message,
      offer: error.details?.treasuryOffer,
    }).toEqual({
      message: expect.stringContaining("Top up KES") as string,
      offer: undefined,
    });
  });
});

describe("a payroll run refused because the wallet is short", () => {
  it("says how much is short and how much Treasury holds, and offers Move to wallet", async () => {
    // #given
    const company = await shortCompany(5_000n * USDC);

    // #when
    const response = await payPayroll(company);

    // #then
    const error = await errorOf(response);
    const offer = offerOf(error.details);
    expect({
      status: response.status,
      action: offer.action,
      held: offer.inTreasuryUsdc,
      moves: await movesStarted(company),
    }).toEqual({
      status: 409,
      action: "move_to_wallet",
      held: (5_000n * USDC).toString(),
      moves: 0,
    });
    expect(error.message).toContain("Treasury holds 5000 USDC");
  });

  it("keeps the usual refusal for a company with nothing in Treasury", async () => {
    // #given
    const company = await shortCompany(0n);

    // #when
    const error = await errorOf(await payPayroll(company));

    // #then
    expect({
      message: error.message,
      offer: error.details?.treasuryOffer,
    }).toEqual({
      message: expect.stringContaining("Top up KES") as string,
      offer: undefined,
    });
  });
});

describe("a withdrawal refused because the wallet is short", () => {
  it("offers Move to wallet before the admin is asked for a passkey", async () => {
    // #given an allowlisted address and 5 USDC to spend
    const company = await shortCompany(400n * USDC);
    const addressId = await allowlistAddress(
      runtime,
      company,
      `0x${"ab".repeat(20)}`,
      "Cold wallet",
    );

    // #when
    const exit = await runtime.runPromiseExit(
      requestWithdrawal({
        organizationId: company.company.organizationId,
        userId: company.company.admin.id,
        requestId: crypto.randomUUID(),
        addressId,
        amountUsdc: 50n * USDC,
      }),
    );

    // #then
    const rejection = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.failureOption(exit.cause))
      : null;
    expect(rejection).toMatchObject({
      _tag: "PayoutRejected",
      reason: "insufficient_balance",
      details: {
        treasuryOffer: {
          action: "move_to_wallet",
          shortfallUsdc: (45n * USDC).toString(),
          inTreasuryUsdc: (400n * USDC).toString(),
        },
      },
    });
  });
});
