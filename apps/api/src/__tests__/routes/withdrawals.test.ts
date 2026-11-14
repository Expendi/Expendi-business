import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Exit } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { NearUsdcPayingCompany } from "../helpers/near-usdc-payouts.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  organizations,
  payouts,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  confirmAllowlistChange,
  requestAllowlistChange,
} from "../../services/allowlist/allowlist.js";
import { continueDelivery } from "../../services/payout/delivery.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { addMember, createUser } from "../helpers/db.js";
import { makeFakePaycrest, TEST_ORIGIN } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { saveTreasuryMove } from "../helpers/money-in.js";
import { readQuotes } from "../helpers/near-payouts.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
  registeredNearAccount,
  savedSends,
} from "../helpers/near-usdc-payouts.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import {
  allowlistAddress,
  claimRequest,
  ledgerBalance,
  payClaims,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const fakes = makeNearUsdcFakes();
const paycrest = makeFakePaycrest();
const oneClick = makeFakeOneClick();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let paying: NearUsdcPayingCompany;
let treasury: string;
let treasuryId: string;
let broadcastsBefore: number;

const createPayingCompany = (balance?: bigint) =>
  createNearUsdcPayingCompany(runtime, db, fakes, balance);

/** A NEAR account that can receive USDC, on `company`'s allowlist. */
const allowlistNearAccount = (
  company: NearUsdcPayingCompany,
  label?: string,
  account = registeredNearAccount(fakes),
) => allowlistAddress(runtime, company, account, label, "near");

/**
 * How many transactions reached the chain since the test began. The
 * treasury can already receive USDC, so each one is a send from a company
 * wallet.
 */
const sends = () => fakes.chain.state.broadcasts.length - broadcastsBefore;

beforeAll(async () => {
  runtime = makeTestRuntime({
    ...fakes.layers,
    paycrest: paycrest.layer,
    oneClick: oneClick.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paycrest.state.reset();
  paying = await createPayingCompany();
  treasury = registeredNearAccount(fakes);
  treasuryId = await allowlistNearAccount(paying, "Treasury", treasury);
  broadcastsBefore = fakes.chain.state.broadcasts.length;
});

interface Challenge {
  readonly challengeId: string;
  readonly options: Parameters<SoftwarePasskey["sign"]>[0];
  readonly withdrawal: {
    readonly id: string;
    readonly chain: string;
    readonly address: string;
    readonly label: string;
    readonly amountUsdc: string;
    readonly status: string;
  };
}

const base = (organizationId = paying.company.organizationId) =>
  `/organizations/${organizationId}/withdrawals`;

function post(path: string, body: unknown, privyUserId?: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearer(privyUserId ?? paying.company.admin.privyUserId),
    },
    body: JSON.stringify(body),
  });
}

function withdraw(
  amountUsdc: bigint,
  overrides: { addressId?: string; requestId?: string } = {},
) {
  return post(base(), {
    requestId: overrides.requestId ?? randomUUID(),
    addressId: overrides.addressId ?? treasuryId,
    amountUsdc: amountUsdc.toString(),
  });
}

async function challengeFor(
  amountUsdc: bigint,
  overrides: { addressId?: string; requestId?: string } = {},
): Promise<Challenge> {
  const response = await withdraw(amountUsdc, overrides);
  expect(response.status).toBe(201);
  return ((await response.json()) as { data: Challenge }).data;
}

function confirm(challenge: Challenge, key: SoftwarePasskey = paying.passkey) {
  return post(`${base()}/${challenge.challengeId}/confirm`, {
    response: key.sign(challenge.options, TEST_ORIGIN),
  });
}

async function withdrawalPayouts() {
  return runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx.select().from(payouts).where(eq(payouts.subjectType, "withdrawal")),
  );
}

async function auditActions(entityId: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE organization_id = $1 AND entity_id = $2 ORDER BY occurred_at",
    [paying.company.organizationId, entityId],
  );
  return rows.map((row) => row.action);
}

async function removeFromAllowlist(addressId: string) {
  const change = { action: "remove", addressId } as const;
  const challenge = await runtime.runPromise(
    requestAllowlistChange({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      change,
    }),
  );
  await runtime.runPromise(
    confirmAllowlistChange({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      challengeId: challenge.challengeId,
      response: paying.passkey.sign(challenge.options, TEST_ORIGIN),
      change,
    }),
  );
}

const setCompany = (changes: Partial<typeof organizations.$inferInsert>) =>
  runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
    tx
      .update(organizations)
      .set(changes)
      .where(eq(organizations.id, paying.company.organizationId)),
  );

describe("withdrawing to an allowlisted address", () => {
  it("returns a passkey challenge for exactly the address and amount", async () => {
    // #when
    const challenge = await challengeFor(10n * USDC);

    // #then
    expect(challenge.withdrawal).toMatchObject({
      address: treasury,
      label: "Treasury",
      amountUsdc: "10000000",
      status: "awaiting_approval",
    });
  });

  it("says a NEAR account is on NEAR", async () => {
    // #when
    const challenge = await challengeFor(10n * USDC);

    // #then
    expect(challenge.withdrawal.chain).toBe("near");
  });

  it.each([
    ["a Base address", "base", "0x52908400098527886e0f7030069857d2e4169ee7"],
    [
      "a Solana address",
      "solana",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ],
  ] as const)(
    "challenges a withdrawal to %s on its own chain, exactly as allowlisted",
    async (_name, chain, address) => {
      // #given
      const addressId = await allowlistAddress(
        runtime,
        paying,
        address,
        "Elsewhere",
        chain,
      );

      // #when
      const challenge = await challengeFor(10n * USDC, { addressId });

      // #then
      expect(challenge.withdrawal).toMatchObject({
        chain,
        address,
        label: "Elsewhere",
        amountUsdc: "10000000",
      });
      const [payout] = await withdrawalPayouts();
      expect(payout?.recipient).toMatchObject({
        method: "usdc",
        chain,
        address,
      });
    },
  );

  it("sends exactly the amount once the admin's passkey confirms it", async () => {
    // #given
    const challenge = await challengeFor(10n * USDC);

    // #when
    const response = await confirm(challenge);

    // #then
    const saved = await savedSends(db, paying.company);
    expect({
      status: response.status,
      received: fakes.chain.state.usdcBalanceOf(treasury),
      left: fakes.chain.state.usdcBalanceOf(paying.wallet.address),
      sends: saved.map((send) => ({
        key: send.sendKey,
        to: send.receiverAccountId,
        amount: send.usdcAmount,
        status: send.status,
      })),
    }).toEqual({
      status: 200,
      received: 10n * USDC,
      left: 90n * USDC,
      sends: [
        {
          key: `payout-${challenge.withdrawal.id}`,
          to: treasury,
          amount: 10n * USDC,
          status: "executed",
        },
      ],
    });
  });

  it("records the debit as a withdrawal in the ledger", async () => {
    // #given
    const challenge = await challengeFor(10n * USDC);

    // #when
    await confirm(challenge);

    // #then
    const rows = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({
            type: walletTransactions.type,
            chain: walletTransactions.chain,
            usdcAmount: walletTransactions.usdcAmount,
          })
          .from(walletTransactions)
          .where(eq(walletTransactions.payoutId, challenge.withdrawal.id)),
    );
    expect({
      rows,
      balance: await ledgerBalance(db, paying.company),
    }).toEqual({
      rows: [{ type: "withdrawal", chain: "near", usdcAmount: -10n * USDC }],
      balance: 90n * USDC,
    });
  });

  it("answers with the withdrawal as sent", async () => {
    // #given
    const challenge = await challengeFor(10n * USDC);

    // #when
    const response = await confirm(challenge);

    // #then
    const body = (await response.json()) as {
      data: {
        id: string;
        status: string;
        amountUsdc: string;
        txHash: string;
        txChain?: string;
      };
    };
    expect({
      ...body.data,
      txHash: body.data.txHash === fakes.chain.state.broadcasts.at(-1),
    }).toMatchObject({
      id: challenge.withdrawal.id,
      status: "paying",
      amountUsdc: "10000000",
      address: treasury,
      txHash: true,
    });
    expect(body.data.txChain).toBeUndefined();
  });

  it("audits every step", async () => {
    // #given
    const challenge = await challengeFor(10n * USDC);

    // #when
    await confirm(challenge);

    // #then
    expect(await auditActions(challenge.withdrawal.id)).toEqual([
      "payout.prepared",
      "payout.approved",
      "payout.funding_started",
      "payout.funded",
    ]);
  });

  describe("pays exactly once", () => {
    it("refuses the same confirmation twice", async () => {
      // #given
      const challenge = await challengeFor(10n * USDC);
      const signed = paying.passkey.sign(challenge.options, TEST_ORIGIN);
      await post(`${base()}/${challenge.challengeId}/confirm`, {
        response: signed,
      });

      // #when
      const replay = await post(`${base()}/${challenge.challengeId}/confirm`, {
        response: signed,
      });

      // #then
      expect({
        status: replay.status,
        sends: sends(),
      }).toEqual({ status: 403, sends: 1 });
    });

    it("returns the same withdrawal for the same request ID", async () => {
      // #given
      const requestId = randomUUID();
      const first = await challengeFor(10n * USDC, { requestId });

      // #when
      const second = await challengeFor(10n * USDC, { requestId });

      // #then
      expect({
        same: second.withdrawal.id === first.withdrawal.id,
        withdrawals: (await withdrawalPayouts()).length,
      }).toEqual({ same: true, withdrawals: 1 });
    });

    it("can't start a paid withdrawal again", async () => {
      // #given
      const requestId = randomUUID();
      await confirm(await challengeFor(10n * USDC, { requestId }));

      // #when
      const again = await withdraw(10n * USDC, { requestId });

      // #then
      expect({ status: again.status, sends: sends() }).toEqual({
        status: 409,
        sends: 1,
      });
    });

    it("refuses a request ID reused for another amount", async () => {
      // #given
      const requestId = randomUUID();
      await challengeFor(10n * USDC, { requestId });

      // #when
      const response = await withdraw(20n * USDC, { requestId });

      // #then
      expect(response.status).toBe(409);
    });
  });

  describe("only to an address on the allowlist", () => {
    it("refuses an address that was never allowlisted", async () => {
      // #when
      const response = await withdraw(10n * USDC, { addressId: randomUUID() });

      // #then
      expect({
        status: response.status,
        withdrawals: await withdrawalPayouts(),
      }).toEqual({ status: 403, withdrawals: [] });
    });

    it("refuses an address that was removed", async () => {
      // #given
      await removeFromAllowlist(treasuryId);

      // #when
      const response = await withdraw(10n * USDC);

      // #then
      expect({
        status: response.status,
        withdrawals: await withdrawalPayouts(),
      }).toEqual({ status: 403, withdrawals: [] });
    });

    it("refuses another company's allowlisted address", async () => {
      // #given
      const other = await createPayingCompany();
      const theirs = await allowlistNearAccount(other);

      // #when
      const response = await withdraw(10n * USDC, { addressId: theirs });

      // #then
      expect(response.status).toBe(403);
    });

    it("sends nothing when the address is removed before the passkey confirms", async () => {
      // #given
      const challenge = await challengeFor(10n * USDC);
      await removeFromAllowlist(treasuryId);

      // #when
      const response = await confirm(challenge);

      // #then
      expect({
        status: response.status,
        sends: sends(),
        withdrawal: (
          await readPayout(db, paying.company, challenge.withdrawal.id)
        ).status,
      }).toEqual({ status: 403, sends: 0, withdrawal: "awaiting_approval" });
    });
  });

  describe("bound to the exact address and amount", () => {
    it("refuses an approval for amount X once the withdrawal says amount Y", async () => {
      // #given an approval signed for 10 USDC
      const challenge = await challengeFor(10n * USDC);
      await updatePayout(db, paying.company, challenge.withdrawal.id, {
        quotedUsdc: 50n * USDC,
        maxDebitUsdc: 50n * USDC,
      });

      // #when
      const response = await confirm(challenge);

      // #then
      expect({ status: response.status, sends: sends() }).toEqual({
        status: 403,
        sends: 0,
      });
    });

    it("refuses an approval once the withdrawal names another address", async () => {
      // #given another allowlisted address swapped in after signing
      const challenge = await challengeFor(10n * USDC);
      const other = registeredNearAccount(fakes);
      await allowlistNearAccount(paying, "Other", other);
      await updatePayout(db, paying.company, challenge.withdrawal.id, {
        recipient: {
          method: "usdc",
          chain: "near",
          address: other,
          accountName: "Treasury",
        },
      });

      // #when
      const response = await confirm(challenge);

      // #then
      expect({ status: response.status, sends: sends() }).toEqual({
        status: 403,
        sends: 0,
      });
    });

    it("refuses a signature from another passkey", async () => {
      // #given
      const challenge = await challengeFor(10n * USDC);

      // #when
      const response = await confirm(challenge, SoftwarePasskey.create());

      // #then
      expect({ status: response.status, sends: sends() }).toEqual({
        status: 403,
        sends: 0,
      });
    });

    it("can't use one withdrawal's signature for another", async () => {
      // #given
      const small = await challengeFor(1n * USDC);
      const large = await challengeFor(50n * USDC);

      // #when the small one's signature is presented for the large one
      const response = await post(`${base()}/${large.challengeId}/confirm`, {
        response: paying.passkey.sign(small.options, TEST_ORIGIN),
      });

      // #then
      expect({ status: response.status, sends: sends() }).toEqual({
        status: 403,
        sends: 0,
      });
    });
  });

  describe("limits", () => {
    it("refuses more than the per-transaction cap", async () => {
      // #given a wallet whose cap is 5,000 USDC, holding more
      paying = await createPayingCompany(6_000n * USDC);
      treasuryId = await allowlistNearAccount(paying);

      // #when
      const response = await withdraw(5_000n * USDC + 1n);

      // #then
      expect({
        status: response.status,
        withdrawals: await withdrawalPayouts(),
      }).toEqual({ status: 400, withdrawals: [] });
    });

    it("allows exactly the per-transaction cap", async () => {
      // #given
      paying = await createPayingCompany(6_000n * USDC);
      treasuryId = await allowlistNearAccount(paying);

      // #when
      const response = await withdraw(5_000n * USDC);

      // #then
      expect(response.status).toBe(201);
    });

    it("refuses more than the wallet has available", async () => {
      // #when
      const response = await withdraw(100n * USDC + 1n);

      // #then
      expect({
        status: response.status,
        withdrawals: await withdrawalPayouts(),
      }).toEqual({ status: 409, withdrawals: [] });
    });

    it("refuses what an open move to Treasury has reserved", async () => {
      // #given 100 USDC in the wallet, 60 of it reserved for a move to Treasury
      await saveTreasuryMove(
        db,
        { company: paying.company, walletId: paying.wallet.id },
        { requestedUsdc: 60n * USDC },
      );

      // #when
      const refused = await withdraw(40n * USDC + 1n);
      const allowed = await withdraw(40n * USDC);

      // #then
      expect({ refused: refused.status, allowed: allowed.status }).toEqual({
        refused: 409,
        allowed: 201,
      });
    });

    it("refuses a zero amount", async () => {
      // #when
      const response = await withdraw(0n);

      // #then
      expect(response.status).toBe(400);
    });

    it("isn't held to the daily cap, and leaves the cap to claims", async () => {
      // #given a KES 1,500 daily cap, and a withdrawal worth far more
      await setCompany({ dailyPayoutCapKes: 150_000n });
      const withdrawn = await confirm(await challengeFor(50n * USDC));

      // #when a KES 1,499.50 claim is approved the same day
      const [claim] = await payClaims(runtime, db, paying, [claimRequest()]);

      // #then the cap, which the withdrawal would have used up, let it through
      expect({
        withdrawal: withdrawn.status,
        claimApproved: claim?.approvedAt instanceof Date,
        claimFailed: claim?.status === "failed",
      }).toEqual({ withdrawal: 200, claimApproved: true, claimFailed: false });
    });
  });

  describe("paused payouts", () => {
    it("refuses a withdrawal while the company is paused", async () => {
      // #given
      await setCompany({ payoutsPaused: true });

      // #when
      const response = await withdraw(10n * USDC);

      // #then
      expect({
        status: response.status,
        withdrawals: await withdrawalPayouts(),
      }).toEqual({ status: 409, withdrawals: [] });
    });

    it("sends nothing when the company is paused before the passkey confirms", async () => {
      // #given
      const challenge = await challengeFor(10n * USDC);
      await setCompany({ payoutsPaused: true });

      // #when
      const response = await confirm(challenge);

      // #then
      expect({ status: response.status, sends: sends() }).toEqual({
        status: 409,
        sends: 0,
      });
    });
  });

  it("is approved on its own, never in a batch with other payouts", async () => {
    // #given
    const challenge = await challengeFor(10n * USDC);
    const [claim] = await runtime.runPromise(
      preparePayouts({
        organizationId: paying.company.organizationId,
        actor: { type: "user", id: paying.company.admin.id },
        requests: [claimRequest()],
      }),
    );

    // #when
    const exit = await runtime.runPromiseExit(
      requestPayoutApproval({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        payoutIds: [challenge.withdrawal.id, claim?.id ?? ""],
      }),
    );

    // #then
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { error: { _tag: "PayoutRejected", reason: "mixed_batch" } },
    });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("won't confirm a claim payout's challenge as a withdrawal", async () => {
    // #given
    const [claim] = await runtime.runPromise(
      preparePayouts({
        organizationId: paying.company.organizationId,
        actor: { type: "user", id: paying.company.admin.id },
        requests: [claimRequest()],
      }),
    );
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        payoutIds: [claim?.id ?? ""],
      }),
    );

    // #when
    const response = await post(`${base()}/${approval.challengeId}/confirm`, {
      response: paying.passkey.sign(approval.options, TEST_ORIGIN),
    });

    // #then
    expect({ status: response.status, sends: sends() }).toEqual({
      status: 404,
      sends: 0,
    });
  });

  it("answers 404 for a challenge ID that isn't one", async () => {
    // #when
    const response = await post(`${base()}/not-a-uuid/confirm`, {
      response: {},
    });

    // #then
    expect(response.status).toBe(404);
  });

  describe("admins only", () => {
    it("refuses an employee", async () => {
      // #given
      const employee = await createUser(db);
      await addMember(db, paying.company, employee, { role: "employee" });

      // #when
      const response = await post(
        base(),
        {
          requestId: randomUUID(),
          addressId: treasuryId,
          amountUsdc: "1000000",
        },
        employee.privyUserId,
      );

      // #then
      expect({
        status: response.status,
        withdrawals: await withdrawalPayouts(),
      }).toEqual({ status: 403, withdrawals: [] });
    });

    it("refuses an employee confirming an admin's withdrawal", async () => {
      // #given
      const employee = await createUser(db);
      await addMember(db, paying.company, employee, { role: "employee" });
      const challenge = await challengeFor(10n * USDC);

      // #when
      const response = await post(
        `${base()}/${challenge.challengeId}/confirm`,
        { response: paying.passkey.sign(challenge.options, TEST_ORIGIN) },
        employee.privyUserId,
      );

      // #then
      expect({ status: response.status, sends: sends() }).toEqual({
        status: 403,
        sends: 0,
      });
    });
  });
});

describe("withdrawing out of a confidential account", () => {
  it("pays through a quote out of the account, and debits it as a withdrawal only when 1Click delivers", async () => {
    // #given a company whose USDC is in a confidential account
    oneClick.state.costPerQuote = 0n;
    paying = await createNearUsdcPayingCompany(
      runtime,
      db,
      fakes,
      100n * USDC,
      undefined,
      "confidential_account",
    );
    oneClick.state.fundConfidential(paying.wallet.address, 100n * USDC);
    treasury = registeredNearAccount(fakes);
    treasuryId = await allowlistNearAccount(paying, "Treasury", treasury);
    broadcastsBefore = fakes.chain.state.broadcasts.length;
    const challenge = await challengeFor(10n * USDC);

    // #when the admin's passkey confirms it
    const response = await confirm(challenge);

    // #then the message is out and nothing was sent from the company wallet
    // or debited
    const body = (await response.json()) as {
      data: { id: string; status: string };
    };
    expect({
      status: response.status,
      withdrawal: body.data.status,
      sends: sends(),
      ledger: await ledgerBalance(db, paying.company),
      inAccount: oneClick.state.confidentialBalances.get(paying.wallet.address),
    }).toEqual({
      status: 200,
      withdrawal: "funding",
      sends: 0,
      ledger: 100n * USDC,
      inAccount: 90n * USDC,
    });

    // #when 1Click delivers
    const [quote] = await readQuotes(db, paying.company);
    if (!quote) throw new Error("no quote");
    oneClick.state.deliverIntentPayout(quote.depositAddress);
    await runtime.runPromise(continueDelivery(quote));

    // #then the withdrawal is paid and debited once, as a withdrawal
    const [payout] = await withdrawalPayouts();
    const rows = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({
            type: walletTransactions.type,
            usdcAmount: walletTransactions.usdcAmount,
            txHash: walletTransactions.txHash,
          })
          .from(walletTransactions)
          .where(eq(walletTransactions.payoutId, challenge.withdrawal.id)),
    );
    expect({ status: payout?.status, rows }).toEqual({
      status: "paid",
      rows: [{ type: "withdrawal", usdcAmount: -10n * USDC, txHash: null }],
    });
    oneClick.state.costPerQuote = 4_465n;
  });

  it("shows the withdrawal as pending, and the balance without it, from the moment it's approved", async () => {
    // #given a company whose USDC is in a confidential account
    oneClick.state.costPerQuote = 0n;
    paying = await createNearUsdcPayingCompany(
      runtime,
      db,
      fakes,
      100n * USDC,
      undefined,
      "confidential_account",
    );
    oneClick.state.fundConfidential(paying.wallet.address, 100n * USDC);
    treasuryId = await allowlistNearAccount(paying, "Treasury");
    const challenge = await challengeFor(10n * USDC);

    // #when the admin's passkey confirms it, before anything is debited
    expect((await confirm(challenge)).status).toBe(200);

    // #then the wallet can spend 10 USDC less and its history lists the
    // withdrawal first, as pending
    const pending = await walletNow();
    expect(pending).toEqual({
      usdcBalance: (100n * USDC).toString(),
      availableUsdc: (90n * USDC).toString(),
      first: {
        id: challenge.withdrawal.id,
        type: "withdrawal",
        usdcAmount: (-10n * USDC).toString(),
        pending: true,
        status: "funding",
      },
      withdrawals: 1,
    });

    // #when 1Click delivers and the ledger debits it
    const [quote] = await readQuotes(db, paying.company);
    if (!quote) throw new Error("no quote");
    oneClick.state.deliverIntentPayout(quote.depositAddress);
    await runtime.runPromise(continueDelivery(quote));

    // #then the ledger row takes the pending row's place, once
    const settled = await walletNow();
    expect({ ...settled, first: { ...settled.first, id: undefined } }).toEqual({
      usdcBalance: (90n * USDC).toString(),
      availableUsdc: (90n * USDC).toString(),
      first: {
        id: undefined,
        type: "withdrawal",
        usdcAmount: (-10n * USDC).toString(),
        pending: false,
        status: "paid",
      },
      withdrawals: 1,
    });
    oneClick.state.costPerQuote = 4_465n;
  });
});

interface HistoryRow {
  readonly id: string;
  readonly type: string;
  readonly usdcAmount: string;
  readonly pending?: boolean;
  readonly payout: { readonly status: string } | null;
}

/** The wallet's balances and the first row of its history, as the app reads them. */
async function walletNow() {
  const path = `/organizations/${paying.company.organizationId}/wallet`;
  const headers = bearer(paying.company.admin.privyUserId);
  const walletResponse = await app.request(path, { headers });
  const historyResponse = await app.request(`${path}/history`, { headers });
  const wallet = (await walletResponse.json()) as {
    data: { usdcBalance: string; availableUsdc: string };
  };
  const history = (await historyResponse.json()) as {
    data: { items: HistoryRow[] };
  };
  const items = history.data.items;
  const first = items[0];
  return {
    usdcBalance: wallet.data.usdcBalance,
    availableUsdc: wallet.data.availableUsdc,
    first: first && {
      id: first.id,
      type: first.type,
      usdcAmount: first.usdcAmount,
      pending: first.pending,
      status: first.payout?.status,
    },
    withdrawals: items.filter((item) => item.type === "withdrawal").length,
  };
}

describe("withdrawal routes keep companies apart", () => {
  it("POST /organizations/:id/withdrawals", async () => {
    // #given
    const fixture = await createIsolationFixture(db);

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: base(organizationId),
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: randomUUID(),
          addressId: randomUUID(),
          amountUsdc: "0",
        }),
      },
    }));
  });

  it("POST /organizations/:id/withdrawals/:challengeId/confirm", async () => {
    // #given
    const fixture = await createIsolationFixture(db);

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `${base(organizationId)}/${randomUUID()}/confirm`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: {} }),
      },
    }));
  });

  it("a challenge from company B can't be confirmed through company A", async () => {
    // #given
    const challenge = await challengeFor(10n * USDC);
    const other = await createPayingCompany();
    await addMember(db, other.company, paying.company.admin, {
      role: "admin",
    });

    // #when
    const response = await post(
      `${base(other.company.organizationId)}/${challenge.challengeId}/confirm`,
      { response: paying.passkey.sign(challenge.options, TEST_ORIGIN) },
    );

    // #then
    expect({ status: response.status, sends: sends() }).toEqual({
      status: 404,
      sends: 0,
    });
  });
});
