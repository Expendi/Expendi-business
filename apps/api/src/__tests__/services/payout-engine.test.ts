import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { KesPayoutRequest } from "../../services/payout/payout-service.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import { DatabaseService } from "../../db/client.js";
import {
  organizations,
  payouts,
  payrollRuns,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  finishPasskeyEnrolment,
  startPasskeyEnrolment,
} from "../../services/approval/passkeys.js";
import {
  approveAndPay,
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { randomTxHash } from "../helpers/chain.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import {
  makeFakePaycrest,
  makeFakePrivyWallets,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let company: TestCompany;
let wallet: TestWallet;
let passkey: SoftwarePasskey;

const USDC = 1_000_000n;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  company = await createCompany(db);
  wallet = await createActiveWallet(db, company);
  await deposit(100n * USDC);
  passkey = SoftwarePasskey.create();
  const options = await runtime.runPromise(
    startPasskeyEnrolment(company.admin.id),
  );
  await runtime.runPromise(
    finishPasskeyEnrolment(
      company.admin.id,
      passkey.register(options, TEST_ORIGIN),
    ),
  );
});

/** Another admin of the company, with their own approval passkey. */
async function enrolAdmin(): Promise<{ userId: string; key: SoftwarePasskey }> {
  const admin = await createUser(db);
  await addMember(db, company, admin, { role: "admin" });
  const key = SoftwarePasskey.create();
  const options = await runtime.runPromise(startPasskeyEnrolment(admin.id));
  await runtime.runPromise(
    finishPasskeyEnrolment(admin.id, key.register(options, TEST_ORIGIN)),
  );
  return { userId: admin.id, key };
}

async function deposit(amount: bigint): Promise<void> {
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(walletTransactions).values({
      organizationId: company.organizationId,
      walletId: wallet.id,
      type: "deposit",
      usdcAmount: amount,
      txHash: randomTxHash(),
      logIndex: 0,
      blockNumber: 1n,
    }),
  );
}

function claim(overrides: Partial<KesPayoutRequest> = {}): KesPayoutRequest {
  return {
    subjectType: "claim",
    subjectId: randomUUID(),
    idempotencyKey: `claim:${randomUUID()}:1`,
    recipient: {
      method: "mpesa_phone",
      phone: "+254712345678",
      accountName: "Jane Wanjiku",
    },
    amountKesCents: 149_950n,
    ...overrides,
  };
}

const prepare = (...requests: KesPayoutRequest[]) =>
  runtime.runPromise(
    preparePayouts({
      organizationId: company.organizationId,
      actor: { type: "user", id: company.admin.id },
      requests,
    }),
  );

async function pay(
  batch: readonly Payout[],
  options: {
    readonly between?: () => Promise<void>;
    readonly userId?: string;
    readonly key?: SoftwarePasskey;
  } = {},
) {
  const userId = options.userId ?? company.admin.id;
  const approval = await runtime.runPromise(
    requestPayoutApproval({
      organizationId: company.organizationId,
      userId,
      payoutIds: batch.map((payout) => payout.id),
    }),
  );
  await options.between?.();
  return runtime.runPromiseExit(
    approveAndPay({
      organizationId: company.organizationId,
      userId,
      challengeId: approval.challengeId,
      response: (options.key ?? passkey).sign(approval.options, TEST_ORIGIN),
    }),
  );
}

const rejection = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "succeeded";
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  if (failure && typeof failure === "object") {
    if ("reason" in failure) return failure.reason;
    if ("_tag" in failure) return failure._tag;
  }
  return String(failure);
};

const payoutRow = async (id: string) =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.select().from(payouts).where(eq(payouts.id, id)),
  ).then(([row]) => row);

const debits = () =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .select({
        usdcAmount: walletTransactions.usdcAmount,
        payoutId: walletTransactions.payoutId,
      })
      .from(walletTransactions)
      .where(eq(walletTransactions.type, "payout")),
  );

async function auditActions(payoutId: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE entity_type = 'payout' AND entity_id = $1 ORDER BY occurred_at, id",
    [payoutId],
  );
  return rows.map((row) => row.action);
}

const setCompany = (changes: Partial<typeof organizations.$inferInsert>) =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .update(organizations)
      .set(changes)
      .where(eq(organizations.id, company.organizationId)),
  );

describe("payout engine", () => {
  describe("paying one claim", () => {
    it("orders the whole-shilling payout and sends exactly what Paycrest asks", async () => {
      // #given
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");

      // #when
      const exit = await pay([payout]);

      // #then
      const [order] = paycrest.state.created;
      const [send] = privy.state.sends;
      const paid = await payoutRow(payout.id);
      expect({
        succeeded: Exit.isSuccess(exit),
        status: paid?.status,
        amountKes: paid?.amountKes,
        orderReference: order?.reference,
        refundAddress: order?.source.refundAddress,
        sentTo: send?.to,
        sentAmount: send?.amount,
        debits: await debits(),
      }).toEqual({
        succeeded: true,
        status: "paying",
        amountKes: 150_000n,
        orderReference: payout.id,
        refundAddress: wallet.address,
        sentTo: paid?.depositAddress,
        sentAmount: paid?.amountToTransferUsdc,
        debits: [
          {
            usdcAmount: -(paid?.amountToTransferUsdc ?? 0n),
            payoutId: payout.id,
          },
        ],
      });
    });

    it("writes an audit entry for every step", async () => {
      // #given
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");

      // #when
      await pay([payout]);

      // #then
      expect(await auditActions(payout.id)).toEqual([
        "payout.prepared",
        "payout.approved",
        "payout.order_created",
        "payout.funding_started",
        "payout.funded",
      ]);
    });

    it("pays the recipient copied at preparation, whatever the payee becomes", async () => {
      // #given
      const request = claim();
      const [payout] = await prepare(request);
      if (!payout) throw new Error("nothing prepared");

      // #when
      await pay([payout]);

      // #then
      expect(paycrest.state.created[0]?.destination.recipient).toMatchObject({
        accountIdentifier: "254712345678",
        accountName: "Jane Wanjiku",
      });
    });
  });

  describe("exactly once", () => {
    it("returns the same payout for the same idempotency key", async () => {
      // #given
      const request = claim();
      const [first] = await prepare(request);

      // #when
      const [second] = await prepare(request);

      // #then
      expect(second?.id).toBe(first?.id);
    });

    it("produces one order and one transfer for one idempotency key", async () => {
      // #given
      const request = claim();
      const [payout] = await prepare(request);
      if (!payout) throw new Error("nothing prepared");
      await pay([payout]);
      const [again] = await prepare(request);

      // #when trying to approve the same payout again
      const second = runtime.runPromiseExit(
        requestPayoutApproval({
          organizationId: company.organizationId,
          userId: company.admin.id,
          payoutIds: [again?.id ?? ""],
        }),
      );

      // #then
      expect({
        rejected: rejection(await second),
        orders: paycrest.state.created.length,
        sends: privy.state.sends.length,
      }).toEqual({ rejected: "not_awaiting_approval", orders: 1, sends: 1 });
    });

    it("refuses an idempotency key reused for a different amount", async () => {
      // #given
      const request = claim();
      await prepare(request);

      // #when
      const exit = await runtime.runPromiseExit(
        preparePayouts({
          organizationId: company.organizationId,
          actor: { type: "user", id: company.admin.id },
          requests: [{ ...request, amountKesCents: 999_900n }],
        }),
      );

      // #then
      expect(rejection(exit)).toBe("idempotency_key_reused");
    });

    it("won't prepare a second payout for a subject that's still paying", async () => {
      // #given
      const request = claim();
      await prepare(request);

      // #when
      const exit = await runtime.runPromiseExit(
        preparePayouts({
          organizationId: company.organizationId,
          actor: { type: "user", id: company.admin.id },
          requests: [
            { ...request, idempotencyKey: `${request.idempotencyKey}-again` },
          ],
        }),
      );

      // #then
      expect(rejection(exit)).toBe("subject_already_paying");
    });

    it("can't reuse an approval", async () => {
      // #given
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");
      const approval = await runtime.runPromise(
        requestPayoutApproval({
          organizationId: company.organizationId,
          userId: company.admin.id,
          payoutIds: [payout.id],
        }),
      );
      const response = passkey.sign(approval.options, TEST_ORIGIN);
      const approve = () =>
        runtime.runPromiseExit(
          approveAndPay({
            organizationId: company.organizationId,
            userId: company.admin.id,
            challengeId: approval.challengeId,
            response,
          }),
        );
      await approve();

      // #when
      const replay = await approve();

      // #then
      expect({
        replay: rejection(replay),
        sends: privy.state.sends.length,
      }).toEqual({ replay: "Forbidden", sends: 1 });
    });
  });

  describe("checks before paying: rejected with a reason, no order created", () => {
    it("rejects a short balance", async () => {
      // #given KES 20,000 needs about 155 USDC; the wallet holds 100
      const [payout] = await prepare(claim({ amountKesCents: 2_000_000n }));
      if (!payout) throw new Error("nothing prepared");

      // #when
      const exit = await pay([payout]);

      // #then
      expect({
        reason: rejection(exit),
        orders: paycrest.state.created.length,
        status: (await payoutRow(payout.id))?.status,
      }).toEqual({
        reason: "insufficient_balance",
        orders: 0,
        status: "awaiting_approval",
      });
    });

    it("rejects a payout over the daily cap", async () => {
      // #given
      await setCompany({ dailyPayoutCapKes: 100_000n });
      const [payout] = await prepare(claim({ amountKesCents: 150_000n }));
      if (!payout) throw new Error("nothing prepared");

      // #when
      const exit = await pay([payout]);

      // #then
      expect({
        reason: rejection(exit),
        orders: paycrest.state.created.length,
      }).toEqual({ reason: "daily_cap", orders: 0 });
    });

    it("counts what was already paid today towards the daily cap", async () => {
      // #given KES 1,500 already paid against a KES 2,000 cap
      await setCompany({ dailyPayoutCapKes: 200_000n });
      const [first] = await prepare(claim());
      if (!first) throw new Error("nothing prepared");
      await pay([first]);
      const [second] = await prepare(claim());
      if (!second) throw new Error("nothing prepared");

      // #when
      const exit = await pay([second]);

      // #then
      expect(rejection(exit)).toBe("daily_cap");
    });

    it("rejects while the company's payouts are paused", async () => {
      // #given
      await setCompany({ payoutsPaused: true });
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");

      // #when
      const exit = await pay([payout]);

      // #then
      expect({
        reason: rejection(exit),
        orders: paycrest.state.created.length,
      }).toEqual({ reason: "paused", orders: 0 });
    });

    it("rejects a payroll run over its cap", async () => {
      // #given a run capped at KES 2,000 with two KES 1,500 salaries
      const payrollRunId = randomUUID();
      await runInScope(
        db,
        { organizationId: company.organizationId, role: "admin" },
        (tx) =>
          tx.insert(payrollRuns).values({
            id: payrollRunId,
            organizationId: company.organizationId,
            payDate: "2026-11-25",
            totalKes: 300_000n,
            capKes: 200_000n,
          }),
      );
      const batch = await prepare(
        claim({ payrollRunId, amountKesCents: 150_000n }),
        claim({ payrollRunId, amountKesCents: 150_000n }),
      );

      // #when
      const exit = await pay(batch);

      // #then
      expect({
        reason: rejection(exit),
        orders: paycrest.state.created.length,
      }).toEqual({ reason: "payroll_cap", orders: 0 });
    });

    it("pays a payroll run within its cap, outside the daily cap", async () => {
      // #given a daily cap that the run alone would break
      await setCompany({ dailyPayoutCapKes: 100_000n });
      const payrollRunId = randomUUID();
      await runInScope(
        db,
        { organizationId: company.organizationId, role: "admin" },
        (tx) =>
          tx.insert(payrollRuns).values({
            id: payrollRunId,
            organizationId: company.organizationId,
            payDate: "2026-11-25",
            totalKes: 300_000n,
            capKes: 360_000n,
          }),
      );
      const batch = await prepare(
        claim({ payrollRunId, amountKesCents: 150_000n }),
        claim({ payrollRunId, amountKesCents: 150_000n }),
      );

      // #when
      const exit = await pay(batch);

      // #then
      expect({
        succeeded: Exit.isSuccess(exit),
        sends: privy.state.sends.length,
      }).toEqual({ succeeded: true, sends: 2 });
    });

    it("counts money promised to unfinished payouts against the balance", async () => {
      // #given ~60 USDC stuck under review out of 100
      paycrest.state.nextCreateFailure = "ambiguous";
      const [stuck] = await prepare(claim({ amountKesCents: 750_000n }));
      if (!stuck) throw new Error("nothing prepared");
      await pay([stuck]);
      const [next] = await prepare(claim({ amountKesCents: 750_000n }));
      if (!next) throw new Error("nothing prepared");

      // #when another ~60 USDC payout is approved
      const exit = await pay([next]);

      // #then
      expect(rejection(exit)).toBe("insufficient_balance");
    });

    it("queues concurrent approvals so together they can't overdraw", async () => {
      // #given 6 admins, each with a payout needing ~30 of the 100 USDC
      const admins = await Promise.all(
        Array.from({ length: 6 }, () => enrolAdmin()),
      );
      const batches = await Promise.all(
        admins.map(() => prepare(claim({ amountKesCents: 380_000n }))),
      );

      // #when they all approve at the same moment
      const exits = await Promise.all(
        admins.map((admin, index) =>
          pay(batches[index] ?? [], { userId: admin.userId, key: admin.key }),
        ),
      );

      // #then only as many as the balance covers go through
      const outcomes = exits.map(rejection);
      expect({
        succeeded: outcomes.filter((outcome) => outcome === "succeeded").length,
        short: outcomes.filter((outcome) => outcome === "insufficient_balance")
          .length,
      }).toEqual({ succeeded: 3, short: 3 });
    });

    it("refuses an employee", async () => {
      // #given
      const employee = await createUser(db);
      await addMember(db, company, employee, { role: "employee" });
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");

      // #when
      const exit = await runtime.runPromiseExit(
        requestPayoutApproval({
          organizationId: company.organizationId,
          userId: employee.id,
          payoutIds: [payout.id],
        }),
      );

      // #then
      expect(rejection(exit)).toBe("not_an_admin");
    });
  });

  describe("batches", () => {
    it("pays each of a batch of 3 exactly once under one approval", async () => {
      // #given
      const batch = await prepare(claim(), claim(), claim());

      // #when
      const exit = await pay(batch);

      // #then
      expect({
        succeeded: Exit.isSuccess(exit),
        orders: paycrest.state.created.length,
        sends: privy.state.sends.length,
        distinct: new Set(privy.state.sends.map((send) => send.idempotencyKey))
          .size,
      }).toEqual({ succeeded: true, orders: 3, sends: 3, distinct: 3 });
    });

    it("lets one payout in a batch fail without touching the others", async () => {
      // #given the second transfer is refused by the wallet's policy
      const batch = await prepare(claim(), claim(), claim());
      privy.state.nextSends("sent", "policy_violation", "sent");

      // #when
      await pay(batch);

      // #then
      const statuses = await Promise.all(
        batch.map(async (payout) => (await payoutRow(payout.id))?.status),
      );
      expect({
        statuses: statuses.sort(),
        debits: (await debits()).length,
      }).toEqual({ statuses: ["failed", "paying", "paying"], debits: 2 });
    });

    it("invalidates the approval if any amount changes after confirming", async () => {
      // #given
      const batch = await prepare(claim(), claim(), claim());
      const [, changed] = batch;

      // #when
      const exit = await pay(batch, {
        between: () =>
          runInScope(db, { organizationId: company.organizationId }, (tx) =>
            tx
              .update(payouts)
              .set({ amountKes: 160_000n, requestedKesCents: 160_000n })
              .where(eq(payouts.id, changed?.id ?? "")),
          ).then(() => undefined),
      });

      // #then
      expect({
        reason: rejection(exit),
        orders: paycrest.state.created.length,
      }).toEqual({ reason: "approval_mismatch", orders: 0 });
    });

    it("invalidates the approval if amounts move between payouts, even with the same total", async () => {
      // #given
      const batch = await prepare(claim(), claim());
      const [first, second] = batch;

      // #when KES 100 moves from one recipient to the other
      const exit = await pay(batch, {
        between: () =>
          runInScope(
            db,
            { organizationId: company.organizationId },
            async (tx) => {
              await tx
                .update(payouts)
                .set({ amountKes: 160_000n, requestedKesCents: 160_000n })
                .where(eq(payouts.id, first?.id ?? ""));
              await tx
                .update(payouts)
                .set({ amountKes: 140_000n, requestedKesCents: 140_000n })
                .where(eq(payouts.id, second?.id ?? ""));
            },
          ),
      });

      // #then
      expect({
        reason: rejection(exit),
        orders: paycrest.state.created.length,
      }).toEqual({ reason: "approval_mismatch", orders: 0 });
    });

    it("invalidates the approval if a payout is added to the batch", async () => {
      // #given an approval for two payouts
      const batch = await prepare(claim(), claim());
      const approval = await runtime.runPromise(
        requestPayoutApproval({
          organizationId: company.organizationId,
          userId: company.admin.id,
          payoutIds: batch.map((payout) => payout.id),
        }),
      );
      const [extra] = await prepare(claim());

      // #when its signature is presented with a third payout's challenge
      const larger = await runtime.runPromise(
        requestPayoutApproval({
          organizationId: company.organizationId,
          userId: company.admin.id,
          payoutIds: [...batch, ...(extra ? [extra] : [])].map((p) => p.id),
        }),
      );
      const exit = await runtime.runPromiseExit(
        approveAndPay({
          organizationId: company.organizationId,
          userId: company.admin.id,
          challengeId: larger.challengeId,
          response: passkey.sign(approval.options, TEST_ORIGIN),
        }),
      );

      // #then
      expect({
        reason: rejection(exit),
        sends: privy.state.sends.length,
      }).toEqual({ reason: "Forbidden", sends: 0 });
    });
  });

  describe("never sending money on an unclear outcome", () => {
    it("marks a payout for review when Paycrest's reply to the order is lost", async () => {
      // #given
      paycrest.state.nextCreateFailure = "ambiguous";
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");

      // #when
      await pay([payout]);

      // #then
      expect({
        status: (await payoutRow(payout.id))?.status,
        sends: privy.state.sends.length,
      }).toEqual({ status: "needs_review", sends: 0 });
    });

    it("fails a payout Paycrest refused, with nothing sent", async () => {
      // #given
      paycrest.state.nextCreateFailure = "refused";
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");

      // #when
      await pay([payout]);

      // #then
      expect({
        status: (await payoutRow(payout.id))?.status,
        sends: privy.state.sends.length,
      }).toEqual({ status: "failed", sends: 0 });
    });

    it("refuses to fund an unsafe order", async () => {
      // #given Paycrest answers with its deposit address set to our wallet
      paycrest.state.nextOrder = (order) => ({
        ...order,
        providerAccount: order.providerAccount
          ? { ...order.providerAccount, receiveAddress: wallet.address }
          : null,
      });
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");

      // #when
      await pay([payout]);

      // #then the problem is recorded for staff; the company's reason
      // names no provider
      const row = await payoutRow(payout.id);
      const { rows: failures } = await owner.query<{
        after: { problems?: string[] };
      }>(
        "SELECT after FROM audit_log WHERE entity_type = 'payout' AND entity_id = $1 AND action = 'payout.failed'",
        [payout.id],
      );
      expect({
        status: row?.status,
        reason: row?.failureReason,
        flagged: failures.some((failure) =>
          failure.after.problems?.includes(
            "deposit address is the company's own wallet",
          ),
        ),
        sends: privy.state.sends.length,
      }).toEqual({
        status: "failed",
        reason:
          "The cash-out failed our safety checks (unsafe). Nothing was sent.",
        flagged: true,
        sends: 0,
      });
    });

    it("refuses an order that would underpay after the rate dropped", async () => {
      // #given Paycrest's order comes back at a lower rate
      paycrest.state.nextOrder = (order) => ({ ...order, rate: "120" });
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");

      // #when
      await pay([payout]);

      // #then
      expect({
        status: (await payoutRow(payout.id))?.status,
        sends: privy.state.sends.length,
      }).toEqual({ status: "failed", sends: 0 });
    });

    it("marks a payout for review when the transfer's outcome is unknown, and never resends", async () => {
      // #given
      privy.state.nextSends("unknown");
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");

      // #when
      await pay([payout]);

      // #then
      expect({
        status: (await payoutRow(payout.id))?.status,
        sendAttempts: privy.state.sends.length,
        debits: (await debits()).length,
      }).toEqual({ status: "needs_review", sendAttempts: 1, debits: 0 });
    });

    it("fails before ordering when the rate moved past what was approved", async () => {
      // #given
      const [payout] = await prepare(claim());
      if (!payout) throw new Error("nothing prepared");
      paycrest.state.rateFor = () => "100";

      // #when
      await pay([payout]);

      // #then
      expect({
        status: (await payoutRow(payout.id))?.status,
        orders: paycrest.state.created.length,
      }).toEqual({ status: "failed", orders: 0 });
    });
  });
});
