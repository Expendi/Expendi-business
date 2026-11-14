import { eq } from "drizzle-orm";
import { Effect, Exit, Layer } from "effect";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ConfidentialAccountOptions } from "../../../scripts/lib/confidential-account-commands.js";
import type { Database } from "../../db/client.js";
import type { WalletBalanceHome } from "../../db/schema/wallets.js";
import type { AppDeps } from "../../layers/main.js";
import type { AppRuntime } from "../../runtime.js";
import type { OneClickShape } from "../../services/intents/one-click.js";
import type { FundedCompany } from "../helpers/money-in.js";
import type { NearUsdcPayingCompany } from "../helpers/near-usdc-payouts.js";
import {
  turnOff,
  turnOn,
} from "../../../scripts/lib/confidential-account-commands.js";
import { describeFailure } from "../../../scripts/lib/treasury-qa-commands.js";
import { DatabaseService } from "../../db/client.js";
import { intentQuotes, wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { OneClick, OneClickRefused } from "../../services/intents/one-click.js";
import { insertFundingPayout, insertOpenSend } from "../helpers/in-flight.js";
import { saveQuote, saveTreasuryMove } from "../helpers/money-in.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
} from "../helpers/near-usdc-payouts.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { USDC } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const fakes = makeNearUsdcFakes();
const oneClick = makeFakeOneClick();

let signInFails = false;
const wrapped: OneClickShape = {
  ...oneClick.service,
  authenticate: (signed) =>
    signInFails
      ? Effect.fail(
          new OneClickRefused({
            message: "1Click refused sign-in: fake refusal",
            httpStatus: 401,
          }),
        )
      : oneClick.service.authenticate(signed),
};
const runtime: AppRuntime = makeTestRuntime(
  { ...fakes.layers, oneClick: Layer.succeed(OneClick, wrapped) },
  fakes.env,
);
let db: Database;
let owner: pg.Pool;
let paying: NearUsdcPayingCompany;
let funded: FundedCompany;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  fakes.chain.state.fundWithUsdc(fakes.relayer.accountId, 1_000_000n * USDC);
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

afterEach(() => {
  signInFails = false;
});

async function newCompany(balanceHome: WalletBalanceHome = "company_wallet") {
  paying = await createNearUsdcPayingCompany(
    runtime,
    db,
    fakes,
    100n * USDC,
    undefined,
    balanceHome,
  );
  const [row] = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select({ transitAddress: wallets.transitAddress })
        .from(wallets)
        .where(eq(wallets.id, paying.wallet.id)),
  );
  if (!row?.transitAddress) throw new Error("wallet has no transit address");
  funded = {
    company: paying.company,
    walletId: paying.wallet.id,
    accountId: paying.wallet.address,
    transitAddress: row.transitAddress,
  };
}

/** Every guard satisfied; a test breaks one. */
const options = (
  overrides: Partial<ConfidentialAccountOptions> = {},
): ConfidentialAccountOptions => ({
  organizationId: paying.company.organizationId,
  companyName: paying.company.name,
  confirmed: true,
  demoOrganizationId: paying.company.organizationId,
  ...overrides,
});

const refusal = async (effect: Effect.Effect<unknown, unknown, AppDeps>) => {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a refusal");
  return describeFailure(exit.cause);
};

const balanceHome = async () => {
  const [row] = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select({ balanceHome: wallets.balanceHome })
        .from(wallets)
        .where(eq(wallets.id, paying.wallet.id)),
  );
  return row?.balanceHome;
};

const audited = async (action: string) => {
  const { rows } = await owner.query<{ before: unknown; after: unknown }>(
    "SELECT before, after FROM audit_log WHERE organization_id = $1 AND action = $2",
    [paying.company.organizationId, action],
  );
  return rows;
};

describe("turning a company's confidential account on", () => {
  it("flips the balance home, audits it, and moves nothing itself", async () => {
    // #given
    await newCompany();
    oneClick.state.fundConfidential(paying.wallet.address, 7n * USDC);

    // #when
    const changed = await runtime.runPromise(turnOn(options()));

    // #then
    const quotes = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) => tx.select({ id: intentQuotes.id }).from(intentQuotes),
    );
    expect({
      changed,
      balanceHome: await balanceHome(),
      audit: await audited("wallet.balance_home_changed"),
      quotes,
      held: fakes.chain.state.usdcBalanceOf(paying.wallet.address),
    }).toEqual({
      changed: {
        companyName: paying.company.name,
        balanceHome: "confidential_account",
        confidentialUsdc: 7n * USDC,
      },
      balanceHome: "confidential_account",
      audit: [
        {
          before: { balanceHome: "company_wallet" },
          after: {
            balanceHome: "confidential_account",
            confidentialUsdc: (7n * USDC).toString(),
          },
        },
      ],
      quotes: [],
      held: 100n * USDC,
    });
  });

  it("refuses unless the environment names this company", async () => {
    // #given
    await newCompany();

    // #then
    for (const demoOrganizationId of [
      undefined,
      "00000000-0000-4000-8000-000000000000",
    ]) {
      expect(
        await refusal(turnOn(options({ demoOrganizationId }))),
        String(demoOrganizationId),
      ).toMatch(/CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID/);
    }
    expect(await balanceHome()).toBe("company_wallet");
  });

  it("refuses unless the company name is typed exactly", async () => {
    // #given
    await newCompany();

    // #then
    for (const companyName of [
      undefined,
      paying.company.name.toUpperCase(),
      `${paying.company.name} `,
    ]) {
      expect(
        await refusal(turnOn(options({ companyName }))),
        String(companyName),
      ).toMatch(/--company-name/);
    }
    expect(await balanceHome()).toBe("company_wallet");
  });

  it("refuses without --yes", async () => {
    // #given
    await newCompany();

    // #then
    expect(await refusal(turnOn(options({ confirmed: false })))).toMatch(
      /--yes/,
    );
    expect(await balanceHome()).toBe("company_wallet");
  });

  it("refuses while a quote is unsettled", async () => {
    // #given
    await newCompany();
    await saveQuote(runtime, db, funded, "base_hop");

    // #then
    expect(await refusal(turnOn(options()))).toMatch(
      /base_hop quote is quoted/,
    );
    expect(await balanceHome()).toBe("company_wallet");
  });

  it.each(["funding", "needs_review"] as const)(
    "refuses while a payout is %s",
    async (status) => {
      // #given
      await newCompany();
      await insertFundingPayout(db, paying, { status });

      // #then
      expect(await refusal(turnOn(options()))).toMatch(
        new RegExp(`payout is ${status}`),
      );
      expect(await balanceHome()).toBe("company_wallet");
    },
  );

  it("refuses while a Treasury move is open", async () => {
    // #given
    await newCompany();
    await saveTreasuryMove(db, funded);

    // #then
    expect(await refusal(turnOn(options()))).toMatch(/Treasury move is open/);
    expect(await balanceHome()).toBe("company_wallet");
  });

  it.each(["reserved", "signed"] as const)(
    "refuses while a company wallet send is %s",
    async (status) => {
      // #given
      await newCompany();
      await insertOpenSend(db, paying, status);

      // #then
      expect(await refusal(turnOn(options()))).toMatch(
        new RegExp(`send is ${status}`),
      );
      expect(await balanceHome()).toBe("company_wallet");
    },
  );

  it("refuses when the confidential account can't be read", async () => {
    // #given
    await newCompany();
    signInFails = true;

    // #then
    expect(await refusal(turnOn(options()))).toMatch(
      /confidential account couldn't be read/,
    );
    expect(await balanceHome()).toBe("company_wallet");
  });

  it("refuses a company that is already on", async () => {
    // #given
    await newCompany("confidential_account");

    // #then
    expect(await refusal(turnOn(options()))).toMatch(/already/);
  });
});

describe("turning a company's confidential account off", () => {
  it("flips the balance home back and audits it", async () => {
    // #given
    await newCompany("confidential_account");

    // #when
    await runtime.runPromise(turnOff(options()));

    // #then
    expect({
      balanceHome: await balanceHome(),
      audit: (await audited("wallet.balance_home_changed")).map(
        ({ before, after }) => ({ before, after }),
      ),
    }).toMatchObject({
      balanceHome: "company_wallet",
      audit: [
        {
          before: { balanceHome: "confidential_account" },
          after: { balanceHome: "company_wallet" },
        },
      ],
    });
  });

  it.each([
    ["the name is wrong", { companyName: "Someone Else" }, /--company-name/],
    ["--yes is missing", { confirmed: false }, /--yes/],
  ] as const)("refuses when %s", async (_name, overrides, expected) => {
    // #given
    await newCompany("confidential_account");

    // #then
    expect(await refusal(turnOff(options(overrides)))).toMatch(expected);
    expect(await balanceHome()).toBe("confidential_account");
  });

  it("requests a durable move-out while the account holds USDC", async () => {
    // #given
    await newCompany("confidential_account");
    oneClick.state.fundConfidential(paying.wallet.address, 2n * USDC);

    // #then
    expect(await runtime.runPromise(turnOff(options()))).toMatchObject({
      draining: true,
    });
    expect(await balanceHome()).toBe("confidential_account");
  });

  it("is allowed once the confidential account holds exactly 0", async () => {
    // #given
    await newCompany("confidential_account");

    // #when
    const changed = await runtime.runPromise(turnOff(options()));

    // #then
    expect({ changed, balanceHome: await balanceHome() }).toMatchObject({
      changed: { confidentialUsdc: 0n },
      balanceHome: "company_wallet",
    });
  });

  it("refuses while something is in flight", async () => {
    // #given
    await newCompany("confidential_account");
    await saveQuote(runtime, db, funded, "move_in");

    // #then
    expect(await refusal(turnOff(options()))).toMatch(/move_in quote/);
    expect(await balanceHome()).toBe("confidential_account");
  });

  it("refuses when the confidential account can't be read", async () => {
    // #given
    await newCompany("confidential_account");
    signInFails = true;

    // #then
    expect(await refusal(turnOff(options()))).toMatch(
      /confidential account couldn't be read/,
    );
    expect(await balanceHome()).toBe("confidential_account");
  });
});
