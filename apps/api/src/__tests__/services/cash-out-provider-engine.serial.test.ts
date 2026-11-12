import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
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

import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type {
  KesPayoutRequest,
  PayoutRequest,
} from "../../services/payout/payout-service.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { DatabaseService } from "../../db/client.js";
import { withScope } from "../../db/scope.js";
import { kesCentsFor, usdcCovering } from "../../services/paycrest/amounts.js";
import { approvePayouts } from "../../services/payout/approve.js";
import { discardUnapprovedPayout } from "../../services/payout/discard.js";
import {
  preparePayouts,
  requestPayoutApproval,
  retryPayout,
} from "../../services/payout/payout-service.js";
import {
  makeFakePaycrest,
  makeFakePretium,
  makeFakePrivyWallets,
  randomAddress,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  allowlistAddress,
  claimRequest,
  createPayingCompany,
  readPayout,
  USDC,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * Which provider a cash-out goes through follows one platform-wide
 * setting, so this runs apart from the main suite (vitest.serial.config.ts).
 * Funding a Pretium cash-out is tested with its own builder's work; these
 * stop at approval.
 */
const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const pretium = makeFakePretium();
let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let staff: TestStaff;
let paying: PayingCompany;

const NEUTRAL = /paycrest|pretium/i;
const PRIME_BANK = "PRIEKENX";

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    pretium: pretium.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  staff = await createStaff(owner, { role: "ops_admin" });
});

afterAll(async () => {
  await setProvider("paycrest");
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  pretium.state.reset();
  await setProvider("paycrest");
  paying = await createPayingCompany(runtime, db, 10_000n * USDC);
});

afterEach(async () => {
  await setProvider("paycrest");
  await setPlatformPause(false);
});

async function setProvider(provider: "paycrest" | "pretium"): Promise<void> {
  await db.execute(
    sql`SELECT set_active_cash_out_provider(${provider}::cash_out_provider, ${staff.staffUserId}::uuid, 'Provider test', 'req-e2-test', '203.0.113.9', 'e2-test')`,
  );
}

async function setPlatformPause(pause: boolean): Promise<void> {
  await db.execute(
    sql`SELECT set_platform_payouts_paused(${pause}, ${staff.staffUserId}::uuid, 'Pause test', 'req-e2-test', '203.0.113.9', 'e2-test')`,
  );
}

const organizationId = () => paying.company.organizationId;
const adminId = () => paying.company.admin.id;

const prepare = (...requests: PayoutRequest[]) =>
  runtime.runPromiseExit(
    preparePayouts({
      organizationId: organizationId(),
      actor: { type: "user", id: adminId() },
      requests,
    }),
  );

async function prepared(...requests: PayoutRequest[]): Promise<Payout[]> {
  const exit = await prepare(...requests);
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
}

async function approve(batch: readonly Payout[]) {
  const approval = await runtime.runPromise(
    requestPayoutApproval({
      organizationId: organizationId(),
      userId: adminId(),
      payoutIds: batch.map((payout) => payout.id),
    }),
  );
  return { approval, approveNow: () => approveWith(approval) };
}

function approveWith(approval: {
  readonly challengeId: string;
  readonly options: Parameters<PayingCompany["passkey"]["sign"]>[0];
}) {
  return runtime.runPromiseExit(
    approvePayouts({
      organizationId: organizationId(),
      userId: adminId(),
      challengeId: approval.challengeId,
      response: paying.passkey.sign(approval.options, TEST_ORIGIN),
    }),
  );
}

function failureOf(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) return { outcome: "succeeded" } as const;
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  if (failure && typeof failure === "object" && "_tag" in failure) {
    return {
      tag: String(failure._tag),
      reason: "reason" in failure ? String(failure.reason) : null,
      message: "message" in failure ? String(failure.message) : null,
    };
  }
  throw new Error(Cause.pretty(exit.cause));
}

const bankClaim = (
  bankCode: string,
  overrides: Partial<KesPayoutRequest> = {},
): KesPayoutRequest =>
  claimRequest({
    recipient: {
      method: "bank",
      bankCode,
      accountNumber: "0123456789",
      accountName: "Jane Wanjiku",
    },
    ...overrides,
  });

const read = (payout: Payout) => readPayout(db, paying.company, payout.id);

async function auditOf(payoutId: string, action: string) {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string;
    before: unknown;
    after: unknown;
  }>(
    "SELECT actor_type, actor_id, before, after FROM audit_log WHERE entity_type = 'payout' AND entity_id = $1 AND action = $2 ORDER BY occurred_at, id",
    [payoutId, action],
  );
  return rows;
}

describe("preparing a cash-out", () => {
  it("prices with Paycrest and stores it as Paycrest's while Paycrest is active", async () => {
    // #when
    const [payout] = await prepared(claimRequest({ amountKesCents: 149_950n }));

    // #then
    expect(payout).toMatchObject({
      provider: "paycrest",
      requestedKesCents: 149_950n,
      amountKes: 150_000n,
      quotedRate: "128.68",
      quotedUsdc: usdcCovering(150_000n, "128.68"),
    });
    expect(pretium.state.rateCalls).toBe(0);
  });

  it("prices with Pretium, in whole shillings, and stores it as Pretium's while Pretium is active", async () => {
    // #given
    await setProvider("pretium");

    // #when
    const [payout] = await prepared(claimRequest({ amountKesCents: 149_950n }));

    // #then
    expect(payout).toMatchObject({
      provider: "pretium",
      requestedKesCents: 149_950n,
      amountKes: 150_000n,
      quotedRate: "129.5",
      quotedUsdc: usdcCovering(150_000n, "129.5"),
    });
    expect(paycrest.state.rateCalls).toEqual([]);
  });

  it("refuses a bank Pretium can't pay while Pretium is active, in words that name no provider", async () => {
    // #given
    await setProvider("pretium");

    // #when
    const failure = failureOf(await prepare(bankClaim(PRIME_BANK)));

    // #then
    expect(failure).toEqual({
      tag: "PayoutRejected",
      reason: "invalid_recipient",
      message:
        "That bank can't be paid right now. Choose another bank or another way to pay.",
    });
  });

  it("pays that bank while Paycrest is active, from the catalogue alone", async () => {
    // #when
    const [payout] = await prepared(bankClaim(PRIME_BANK));

    // #then
    expect(payout?.provider).toBe("paycrest");
  });

  it.each(["paycrest", "pretium"] as const)(
    "refuses a bank code the catalogue doesn't know while %s is active",
    async (provider) => {
      // #given
      await setProvider(provider);

      // #when
      const failure = failureOf(await prepare(bankClaim("NOTABANK")));

      // #then
      expect(failure).toMatchObject({
        tag: "PayoutRejected",
        reason: "invalid_recipient",
      });
      expect(failure.message).not.toMatch(NEUTRAL);
    },
  );

  it("refuses more than KES 250,000 in one cash-out while Pretium is active", async () => {
    // #given
    await setProvider("pretium");

    // #when
    const failure = failureOf(
      await prepare(claimRequest({ amountKesCents: 25_000_100n })),
    );

    // #then
    expect(failure).toEqual({
      tag: "PayoutRejected",
      reason: "invalid_amount",
      message:
        "A single payment can send at most KES 250,000.00. Split it into smaller payments.",
    });
  });

  it("takes exactly KES 250,000 while Pretium is active", async () => {
    // #given
    await setProvider("pretium");

    // #when
    const [payout] = await prepared(
      claimRequest({ amountKesCents: 25_000_000n }),
    );

    // #then
    expect(payout?.amountKes).toBe(25_000_000n);
  });

  it("refuses less than KES 20 while Pretium is active", async () => {
    // #given
    await setProvider("pretium");

    // #when
    const failure = failureOf(
      await prepare(claimRequest({ amountKesCents: 1_900n })),
    );

    // #then
    expect(failure.tag).toBe("AmountTooSmall");
  });

  it("values a USDC payout at the active provider's rate, and keeps it on chain", async () => {
    // #given
    const address = randomAddress().toLowerCase();
    await allowlistAddress(runtime, paying, address);
    await setProvider("pretium");

    // #when
    const [payout] = await prepared({
      subjectType: "claim",
      subjectId: randomUUID(),
      idempotencyKey: `claim:${randomUUID()}:1`,
      recipient: {
        method: "usdc",
        chain: "base",
        address,
        accountName: "Treasury",
      },
      amountUsdc: 10n * USDC,
    });

    // #then
    expect(payout).toMatchObject({
      provider: "onchain",
      quotedRate: "129.5",
      amountKes: kesCentsFor(10n * USDC, "129.5"),
    });
    expect(paycrest.state.rateCalls).toEqual([]);
  });
});

describe("approving a cash-out locks its provider", () => {
  it("moves a cash-out prepared under Paycrest to Pretium when Pretium is active at approval, and audits it", async () => {
    // #given
    const [payout] = await prepared(claimRequest());
    if (!payout) throw new Error("nothing prepared");
    const { approveNow } = await approve([payout]);
    await setProvider("pretium");

    // #when
    const exit = await approveNow();

    // #then
    expect(failureOf(exit)).toEqual({ outcome: "succeeded" });
    const after = await read(payout);
    expect(after).toMatchObject({
      status: "approved",
      provider: "pretium",
      quotedRate: payout.quotedRate,
      quotedUsdc: payout.quotedUsdc,
      maxDebitUsdc: payout.maxDebitUsdc,
      amountKes: payout.amountKes,
    });
    expect(await auditOf(payout.id, "payout.provider_changed")).toEqual([
      {
        actor_type: "user",
        actor_id: adminId(),
        before: { provider: "paycrest" },
        after: { provider: "pretium" },
      },
    ]);
  });

  it("leaves an approved cash-out with its provider when the setting changes afterwards", async () => {
    // #given
    const [payout] = await prepared(claimRequest());
    if (!payout) throw new Error("nothing prepared");
    const { approveNow } = await approve([payout]);
    expect(failureOf(await approveNow())).toEqual({ outcome: "succeeded" });

    // #when
    await setProvider("pretium");

    // #then
    expect(await read(payout)).toMatchObject({
      status: "approved",
      provider: "paycrest",
    });
    expect(await auditOf(payout.id, "payout.provider_changed")).toEqual([]);
  });

  it.each([
    ["a bank Pretium can't pay", bankClaim(PRIME_BANK)],
    [
      "more than Pretium pays at once",
      claimRequest({ amountKesCents: 26_000_000n }),
    ],
  ])(
    "refuses the whole approval for %s, and withdraws it so it is prepared again",
    async (_case, unpayable) => {
      // #given
      const batch = await prepared(claimRequest(), unpayable);
      const [payable, stranded] = batch;
      if (!payable || !stranded) throw new Error("nothing prepared");
      const { approveNow } = await approve(batch);
      await setProvider("pretium");

      // #when
      const failure = failureOf(await approveNow());

      // #then
      expect(failure).toMatchObject({
        tag: "PayoutRejected",
        reason: "cash_out_unavailable",
      });
      expect(failure.message).not.toMatch(NEUTRAL);
      expect(await read(payable)).toMatchObject({
        status: "awaiting_approval",
        provider: "paycrest",
        approvalId: null,
      });
      expect(await read(stranded)).toMatchObject({
        status: "failed",
        provider: "paycrest",
        approvalId: null,
      });
      expect(await auditOf(payable.id, "payout.provider_changed")).toEqual([]);
      expect({
        orders: paycrest.state.created.length,
        pretium: pretium.state.payRequests.length,
        sends: privy.state.sends.length,
      }).toEqual({ orders: 0, pretium: 0, sends: 0 });
    },
  );

  it("leaves the withdrawn payment's subject free to be prepared again under the active provider", async () => {
    // #given
    const subjectId = randomUUID();
    const [stale] = await prepared(
      claimRequest({
        subjectId,
        idempotencyKey: `claim:${subjectId}:1`,
        amountKesCents: 26_000_000n,
      }),
    );
    if (!stale) throw new Error("nothing prepared");
    const { approveNow } = await approve([stale]);
    await setProvider("pretium");
    failureOf(await approveNow());

    // #when
    const [again] = await prepared(
      claimRequest({
        subjectId,
        idempotencyKey: `claim:${subjectId}:2`,
        amountKesCents: 25_000_000n,
      }),
    );

    // #then
    expect(again).toMatchObject({
      provider: "pretium",
      status: "awaiting_approval",
    });
  });

  it("never touches a USDC payout", async () => {
    // #given
    const address = randomAddress().toLowerCase();
    await allowlistAddress(runtime, paying, address);
    const [payout] = await prepared({
      subjectType: "claim",
      subjectId: randomUUID(),
      idempotencyKey: `claim:${randomUUID()}:1`,
      recipient: {
        method: "usdc",
        chain: "base",
        address,
        accountName: "Treasury",
      },
      amountUsdc: 10n * USDC,
    });
    if (!payout) throw new Error("nothing prepared");
    const { approveNow } = await approve([payout]);
    await setProvider("pretium");

    // #when
    const exit = await approveNow();

    // #then
    expect(failureOf(exit)).toEqual({ outcome: "succeeded" });
    expect(await read(payout)).toMatchObject({
      status: "approved",
      provider: "onchain",
    });
    expect(await auditOf(payout.id, "payout.provider_changed")).toEqual([]);
  });

  it("is checked with the pause: a paused platform still refuses, and nothing moves", async () => {
    // #given
    const [payout] = await prepared(claimRequest());
    if (!payout) throw new Error("nothing prepared");
    const { approveNow } = await approve([payout]);
    await setProvider("pretium");
    await setPlatformPause(true);

    // #when
    const failure = failureOf(await approveNow());

    // #then
    expect(failure).toMatchObject({ tag: "PayoutRejected", reason: "paused" });
    expect(await read(payout)).toMatchObject({
      status: "awaiting_approval",
      provider: "paycrest",
    });
  });
});

describe("retrying a failed cash-out", () => {
  it("goes through the provider active at the retry, not the failed payout's", async () => {
    // #given
    const subjectId = randomUUID();
    const [failed] = await prepared(
      claimRequest({ subjectId, idempotencyKey: `claim:${subjectId}:1` }),
    );
    if (!failed) throw new Error("nothing prepared");
    await runtime.runPromise(
      withScope({ organizationId: organizationId() }, (tx) =>
        discardUnapprovedPayout(tx, {
          organizationId: organizationId(),
          payoutId: failed.id,
          reason: "Failed in a test.",
          actor: { type: "user", id: adminId() },
        }),
      ),
    );
    await setProvider("pretium");

    // #when
    const retry = await runtime.runPromise(
      retryPayout({
        organizationId: organizationId(),
        failedPayoutId: failed.id,
        idempotencyKey: `claim:${subjectId}:2`,
        actor: { type: "user", id: adminId() },
      }),
    );

    // #then
    expect(retry).toMatchObject({
      provider: "pretium",
      quotedRate: "129.5",
      requestedKesCents: failed.requestedKesCents,
    });
  });
});
