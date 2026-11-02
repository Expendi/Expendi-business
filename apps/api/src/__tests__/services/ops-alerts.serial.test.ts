import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { OpsAlertKind, Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  accountingConnections,
  accountingSyncs,
  expenses,
  opsAlerts,
  payouts,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { runAlerts } from "../../services/alerts/run-alerts.js";
import { nairobiDate } from "../../services/bills/status.js";
import { EmailSender } from "../../services/email/email-sender.js";
import { reconcilePaycrestJob } from "../../station/reconcile-paycrest.js";
import { insertBill, insertPayee, shiftDays } from "../helpers/bills.js";
import { randomTxHash } from "../helpers/chain.js";
import { addCategory } from "../helpers/claims.js";
import { createActiveWallet, createCompany } from "../helpers/db.js";
import {
  makeFakeEmailSender,
  makeFakePaycrest,
  signPaycrestBody,
} from "../helpers/fakes.js";
import { USDC } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const ALERT_LIST = ["ops@expendi.test", "oncall@expendi.test"];

const email = makeFakeEmailSender();
const paycrest = makeFakePaycrest();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime(
    { emailSender: email.layer, paycrest: paycrest.layer },
    { ALERT_EMAILS: ` ${ALERT_LIST.join(" , ")} ` },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

async function setHeartbeat(minutesAgo: number): Promise<void> {
  await owner.query(
    "UPDATE station_heartbeats SET last_finished_at = now() - make_interval(mins => $1) WHERE job = 'reconcile-paycrest'",
    [minutesAgo],
  );
}

beforeEach(async () => {
  email.state.reset();
  paycrest.state.reset();
  await setHeartbeat(0);
});

const runChecks = () => runtime.runPromise(runAlerts());

interface AlertRow {
  readonly id: string;
  readonly title: string;
  readonly occurrences: number;
  readonly resolved_at: Date | null;
  readonly notified_at: Date | null;
  readonly last_notify_error: string | null;
}

/** Every incident of `kind` about `subjectKey`, oldest first. */
async function incidents(
  kind: OpsAlertKind,
  subjectKey: string,
): Promise<AlertRow[]> {
  const { rows } = await owner.query<AlertRow>(
    "SELECT id, title, occurrences, resolved_at, notified_at, last_notify_error FROM ops_alerts WHERE kind = $1 AND subject_key = $2 ORDER BY opened_at, id",
    [kind, subjectKey],
  );
  return rows;
}

/** Who was emailed about each incident of `kind` about `subjectKey`. */
async function emailed(
  kind: OpsAlertKind,
  subjectKey: string,
): Promise<string[][]> {
  return (await incidents(kind, subjectKey)).map(({ id }) =>
    email.state.sent
      .filter((message) =>
        message.idempotencyKey?.startsWith(`ops-alert/${id}/`),
      )
      .map((message) => message.to)
      .sort(),
  );
}

const EVERYONE = [...ALERT_LIST].sort();

function emailTo(kind: OpsAlertKind, subjectKey: string) {
  return incidents(kind, subjectKey).then(([first]) =>
    email.state.sent.find((message) =>
      message.idempotencyKey?.startsWith(`ops-alert/${first?.id ?? ""}/`),
    ),
  );
}

const asAdmin = (company: TestCompany) => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

async function companyWithWallet(
  balance: bigint,
): Promise<{ company: TestCompany; wallet: TestWallet }> {
  const company = await createCompany(db);
  const wallet = await createActiveWallet(db, company);
  await deposit(company, wallet, balance);
  return { company, wallet };
}

async function deposit(
  company: TestCompany,
  wallet: TestWallet,
  usdc: bigint,
): Promise<void> {
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(walletTransactions).values({
      organizationId: company.organizationId,
      walletId: wallet.id,
      type: "deposit",
      usdcAmount: usdc,
      txHash: randomTxHash(),
      logIndex: 0,
      blockNumber: 1n,
    }),
  );
}

type PayoutState = Pick<Payout, "status"> &
  Partial<Pick<Payout, "approvedAt" | "updatedAt" | "failureReason">>;

/** A payout written straight to the table, in a state Paycrest left it in. */
async function insertPayout(
  company: TestCompany,
  wallet: TestWallet,
  state: PayoutState,
  subject: { subjectType: Payout["subjectType"] } = { subjectType: "claim" },
): Promise<string> {
  const approved = state.approvedAt !== null;
  const [payout] = await runInScope(db, asAdmin(company), (tx) =>
    tx
      .insert(payouts)
      .values({
        organizationId: company.organizationId,
        walletId: wallet.id,
        subjectType: subject.subjectType,
        subjectId: randomUUID(),
        idempotencyKey: `claim:${randomUUID()}:1`,
        method: "mpesa_phone",
        recipient: {
          method: "mpesa_phone",
          phone: "+254712345678",
          accountName: "Jane Wanjiku",
        },
        requestedKesCents: 150_000n,
        amountKes: 150_000n,
        quotedRate: "128.68",
        quotedUsdc: 11_660_000n,
        maxDebitUsdc: 12_000_000n,
        providerOrderId: `order-${randomUUID()}`,
        ...(approved && {
          approvalId: randomUUID(),
          approvedBy: company.admin.id,
          approvedAt: state.approvedAt ?? new Date(),
        }),
        status: state.status,
        failureReason: state.failureReason ?? null,
        ...(state.updatedAt && { updatedAt: state.updatedAt }),
      })
      .returning({ id: payouts.id }),
  );
  if (!payout) throw new Error("payout insert returned no row");
  return payout.id;
}

async function setPayoutStatus(
  company: TestCompany,
  payoutId: string,
  status: Payout["status"],
): Promise<void> {
  await runInScope(db, asAdmin(company), (tx) =>
    tx.update(payouts).set({ status }).where(eq(payouts.id, payoutId)),
  );
}

describe("Payout needs review", () => {
  it("emails the alert list once while the payout waits, and resolves when a person settles it", async () => {
    // #given
    const { company, wallet } = await companyWithWallet(100n * USDC);
    const payoutId = await insertPayout(company, wallet, {
      status: "needs_review",
      failureReason: "Funding started but no outcome was recorded.",
    });

    // #when the job runs three times while it waits, then once after
    await runChecks();
    await runChecks();
    await runChecks();
    await setPayoutStatus(company, payoutId, "failed");
    await runChecks();

    // #then
    const [incident] = await incidents("payout_needs_review", payoutId);
    expect({
      emailed: await emailed("payout_needs_review", payoutId),
      title: incident?.title,
      resolved: incident?.resolved_at !== null,
    }).toEqual({
      emailed: [EVERYONE],
      title: `Payout needs review at ${company.name}`,
      resolved: true,
    });
  });

  it("names the company, payout and reason, and never the amount", async () => {
    // #given
    const { company, wallet } = await companyWithWallet(100n * USDC);
    const payoutId = await insertPayout(company, wallet, {
      status: "needs_review",
      failureReason: "Funding started but no outcome was recorded.",
    });

    // #when
    await runChecks();

    // #then
    const message = await emailTo("payout_needs_review", payoutId);
    expect(message?.subject).toBe(
      `Expendi alert: Payout needs review at ${company.name}`,
    );
    expect(message?.text).toContain(`Payout: ${payoutId}`);
    expect(message?.text).toContain(
      "Reason: Funding started but no outcome was recorded.",
    );
    expect(message?.text).not.toMatch(/1,500|150000|11\.66/);
  });

  it("leaves an alert to the instance already emailing it, so a second instance sends nothing", async () => {
    // #given a second API instance whose first email hangs until released
    let entered: () => void = () => undefined;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const slowSender = Layer.succeed(EmailSender, {
      send: (message) =>
        Effect.promise(async () => {
          calls += 1;
          if (calls === 1) {
            entered();
            await released;
          }
          email.state.sent.push(message);
        }),
    });
    const slow = makeTestRuntime(
      { emailSender: slowSender, paycrest: paycrest.layer },
      { ALERT_EMAILS: ALERT_LIST.join(",") },
    );
    const { company, wallet } = await companyWithWallet(100n * USDC);
    const payoutId = await insertPayout(company, wallet, {
      status: "needs_review",
    });

    // #when this instance runs while the other is mid-send
    try {
      const other = slow.runPromise(runAlerts());
      await sending;
      await runChecks();
      release();
      await other;
    } finally {
      await slow.dispose();
    }

    // #then
    expect(await emailed("payout_needs_review", payoutId)).toEqual([EVERYONE]);
  });
});

describe("Payout failed", () => {
  it("emails once for a payout that failed after approval", async () => {
    // #given
    const { company, wallet } = await companyWithWallet(100n * USDC);
    const payoutId = await insertPayout(company, wallet, {
      status: "failed",
      approvedAt: new Date(),
      failureReason: "Paycrest refunded the order.",
    });

    // #when
    await runChecks();
    await runChecks();

    // #then
    expect(await emailed("payout_failed", payoutId)).toEqual([EVERYONE]);
  });

  it("stays quiet about a payout withdrawn before approval, or one that failed days ago", async () => {
    // #given
    const { company, wallet } = await companyWithWallet(100n * USDC);
    const discarded = await insertPayout(company, wallet, {
      status: "failed",
      approvedAt: null,
    });
    const old = await insertPayout(company, wallet, {
      status: "failed",
      approvedAt: new Date(Date.now() - 3 * 86_400_000),
      updatedAt: new Date(Date.now() - 25 * 3_600_000),
    });

    // #when
    await runChecks();

    // #then
    expect([
      await incidents("payout_failed", discarded),
      await incidents("payout_failed", old),
    ]).toEqual([[], []]);
  });

  it("never emails twice for the same payout, even once its incident has closed", async () => {
    // #given an incident already emailed and closed
    const { company, wallet } = await companyWithWallet(100n * USDC);
    const payoutId = await insertPayout(company, wallet, {
      status: "failed",
      approvedAt: new Date(),
    });
    await runChecks();
    await owner.query(
      "UPDATE ops_alerts SET resolved_at = now() WHERE kind = 'payout_failed' AND subject_key = $1",
      [payoutId],
    );

    // #when
    await runChecks();

    // #then
    expect(await emailed("payout_failed", payoutId)).toEqual([EVERYONE]);
  });
});

describe("Webhook signature failure", () => {
  async function badlySignedWebhook(): Promise<number> {
    const body = JSON.stringify({
      event: "payment_order.settled",
      data: { id: "order-forged" },
    });
    const response = await app.request("/webhooks/paycrest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paycrest-signature": signPaycrestBody(`${body} `),
      },
      body,
    });
    return response.status;
  }

  beforeEach(async () => {
    await owner.query(
      "UPDATE ops_alerts SET resolved_at = now() WHERE kind = 'webhook_signature_failure' AND resolved_at IS NULL",
    );
  });

  it("emails once however many forged deliveries arrive, then again after a quiet hour and a new one", async () => {
    // #given
    const before = (await incidents("webhook_signature_failure", "paycrest"))
      .length;

    // #when three forged deliveries and two runs
    const statuses = [
      await badlySignedWebhook(),
      await badlySignedWebhook(),
      await badlySignedWebhook(),
    ];
    await runChecks();
    await runChecks();
    const first = (await incidents("webhook_signature_failure", "paycrest"))
      .slice(before)
      .map((incident) => [incident.occurrences, incident.resolved_at]);

    // ...then an hour with none, and another
    await owner.query(
      "UPDATE ops_alerts SET last_seen_at = now() - interval '61 minutes' WHERE kind = 'webhook_signature_failure' AND resolved_at IS NULL",
    );
    await runChecks();
    await badlySignedWebhook();
    await runChecks();

    // #then
    expect({
      statuses,
      first,
      emailed: (await emailed("webhook_signature_failure", "paycrest")).slice(
        before,
      ),
    }).toEqual({
      statuses: [401, 401, 401],
      first: [[3, null]],
      emailed: [EVERYONE, EVERYONE],
    });
  });

  it("stays open while forged deliveries keep arriving", async () => {
    // #given an incident whose last failure was 30 minutes ago
    await badlySignedWebhook();
    await owner.query(
      "UPDATE ops_alerts SET last_seen_at = now() - interval '30 minutes' WHERE kind = 'webhook_signature_failure' AND resolved_at IS NULL",
    );

    // #when
    await runChecks();

    // #then
    const open = (
      await incidents("webhook_signature_failure", "paycrest")
    ).filter((incident) => incident.resolved_at === null);
    expect(open).toHaveLength(1);
  });
});

describe("Reconciliation stopped", () => {
  beforeEach(async () => {
    await runChecks();
  });

  it("stays quiet while the job ran within 5 minutes", async () => {
    // #given
    const before = (
      await incidents("reconciliation_stopped", "reconcile-paycrest")
    ).length;
    await setHeartbeat(4);

    // #when
    await runChecks();

    // #then
    expect(
      await incidents("reconciliation_stopped", "reconcile-paycrest"),
    ).toHaveLength(before);
  });

  it("emails once when the job hasn't finished a run for over 5 minutes, and resolves when it runs again", async () => {
    // #given
    const before = (
      await incidents("reconciliation_stopped", "reconcile-paycrest")
    ).length;
    await setHeartbeat(6);

    // #when
    await runChecks();
    await runChecks();
    const whileStopped = (
      await incidents("reconciliation_stopped", "reconcile-paycrest")
    )
      .slice(before)
      .map((incident) => incident.resolved_at);
    await runtime.runPromise(reconcilePaycrestJob.run);
    await runChecks();

    // #then
    const after = (
      await incidents("reconciliation_stopped", "reconcile-paycrest")
    ).slice(before);
    expect({
      whileStopped,
      resolved: after.map((incident) => incident.resolved_at !== null),
      emailed: (
        await emailed("reconciliation_stopped", "reconcile-paycrest")
      ).slice(before),
    }).toEqual({
      whileStopped: [null],
      resolved: [true],
      emailed: [EVERYONE],
    });
  });
});

describe("Low company balance", () => {
  /** A submitted claim straight to the table. */
  async function submitClaim(
    company: TestCompany,
    amountKes: bigint,
  ): Promise<string> {
    const categoryId = await addCategory(db, company, `Travel ${randomUUID()}`);
    const [claim] = await runInScope(db, asAdmin(company), (tx) =>
      tx
        .insert(expenses)
        .values({
          organizationId: company.organizationId,
          membershipId: company.adminMembershipId,
          kind: "claim",
          overviewHeading: "petty_cash",
          status: "submitted",
          categoryId,
          merchant: "Kenya Airways",
          amountKes,
          spentOn: nairobiDate(new Date()),
        })
        .returning({ id: expenses.id }),
    );
    if (!claim) throw new Error("claim insert returned no row");
    return claim.id;
  }

  it("emails once while unpaid claims are more than the wallet holds, again only after it recovers and drops", async () => {
    // #given 10 USDC (about KES 1,287) and a KES 2,000 claim
    const { company, wallet } = await companyWithWallet(10n * USDC);
    await submitClaim(company, 200_000n);

    // #when it runs short twice, is topped up, then runs short again
    await runChecks();
    await runChecks();
    await deposit(company, wallet, 100n * USDC);
    await runChecks();
    const afterTopUp = (
      await incidents("low_company_balance", company.organizationId)
    ).map((incident) => incident.resolved_at !== null);
    await submitClaim(company, 2_000_000n);
    await runChecks();

    // #then
    expect({
      afterTopUp,
      emailed: await emailed("low_company_balance", company.organizationId),
    }).toEqual({ afterTopUp: [true], emailed: [EVERYONE, EVERYONE] });
  });

  it("counts bills due in the next 7 days, but not later ones, and never shows what's due", async () => {
    // #given about KES 1,287 and a KES 50,000 bill due in 5 days
    const { company } = await companyWithWallet(10n * USDC);
    const quiet = await companyWithWallet(10n * USDC);
    const today = nairobiDate(new Date());
    for (const [target, dueOn] of [
      [company, shiftDays(today, 5)],
      [quiet.company, shiftDays(today, 10)],
    ] as const) {
      await insertBill(db, target, {
        payeeId: await insertPayee(db, target),
        categoryId: await addCategory(db, target, `Utilities ${randomUUID()}`),
        amountKes: 5_000_000n,
        dueOn,
      });
    }

    // #when
    await runChecks();

    // #then
    const message = await emailTo(
      "low_company_balance",
      company.organizationId,
    );
    expect({
      due: (await emailed("low_company_balance", company.organizationId))
        .length,
      later: (
        await incidents("low_company_balance", quiet.company.organizationId)
      ).length,
      subject: message?.subject,
      showsTotal: message?.text.includes("50,000"),
    }).toEqual({
      due: 1,
      later: 0,
      subject: `Expendi alert: Low wallet balance at ${company.name}`,
      showsTotal: false,
    });
  });

  it("leaves an open alert as it is while Paycrest's rate is unavailable", async () => {
    // #given an open alert
    const { company, wallet } = await companyWithWallet(10n * USDC);
    await submitClaim(company, 200_000n);
    await runChecks();
    await deposit(company, wallet, 100n * USDC);

    // #when the wallet is topped up but can't be valued
    paycrest.state.failRate = true;
    await runChecks();

    // #then
    const [incident] = await incidents(
      "low_company_balance",
      company.organizationId,
    );
    expect(incident?.resolved_at).toBeNull();
  });
});

describe("Zoho sync failing", () => {
  async function insertConnection(
    company: TestCompany,
    status: "needs_reconnect" | "active",
  ): Promise<string> {
    const [connection] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .insert(accountingConnections)
          .values({ organizationId: company.organizationId, status })
          .returning({ id: accountingConnections.id }),
    );
    if (!connection) throw new Error("connection insert returned no row");
    return connection.id;
  }

  async function insertFailedSync(company: TestCompany): Promise<string> {
    const [sync] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .insert(accountingSyncs)
          .values({
            organizationId: company.organizationId,
            subjectType: "expense",
            subjectId: randomUUID(),
            status: "failed",
            attempts: 5,
            lastError: "Zoho didn't answer in time.",
          })
          .returning({ id: accountingSyncs.id }),
    );
    if (!sync) throw new Error("sync insert returned no row");
    return sync.id;
  }

  it("emails once when Zoho rejects a company's connection, and resolves once it's dealt with", async () => {
    // #given
    const company = await createCompany(db);
    const connectionId = await insertConnection(company, "needs_reconnect");

    // #when
    await runChecks();
    await runChecks();
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(accountingConnections)
        .set({ status: "disconnected" })
        .where(eq(accountingConnections.id, connectionId)),
    );
    await runChecks();

    // #then
    const message = await emailTo("zoho_sync_failing", company.organizationId);
    expect({
      emailed: await emailed("zoho_sync_failing", company.organizationId),
      resolved: (
        await incidents("zoho_sync_failing", company.organizationId)
      ).map((incident) => incident.resolved_at !== null),
      reconnect: message?.text.includes("Zoho rejected it"),
    }).toEqual({ emailed: [EVERYONE], resolved: [true], reconnect: true });
  });

  it("emails once when a sync runs out of retries, and again if one fails after staff retried it", async () => {
    // #given
    const company = await createCompany(db);
    const syncId = await insertFailedSync(company);
    const setSyncStatus = (status: "pending" | "failed") =>
      runInScope(db, { organizationId: company.organizationId }, (tx) =>
        tx
          .update(accountingSyncs)
          .set({ status })
          .where(eq(accountingSyncs.id, syncId)),
      );

    // #when it fails, staff retry it, and it fails again
    await runChecks();
    await runChecks();
    await setSyncStatus("pending");
    await runChecks();
    await setSyncStatus("failed");
    await runChecks();

    // #then
    const message = await emailTo("zoho_sync_failing", company.organizationId);
    expect({
      emailed: await emailed("zoho_sync_failing", company.organizationId),
      failedSyncs: message?.text.includes("Failed syncs: 1 ran out of retries"),
      noErrorText: message?.text.includes("Zoho didn't answer"),
    }).toEqual({
      emailed: [EVERYONE, EVERYONE],
      failedSyncs: true,
      noErrorText: false,
    });
  });
});

describe("delivery", () => {
  it("retries an email that failed, and still sends it once", async () => {
    // #given
    const { company, wallet } = await companyWithWallet(100n * USDC);
    const payoutId = await insertPayout(company, wallet, {
      status: "needs_review",
    });
    email.state.failNext(1);

    // #when it fails, then the retry falls due
    await runChecks();
    const [failed] = await incidents("payout_needs_review", payoutId);
    await runChecks();
    await owner.query(
      "UPDATE ops_alerts SET next_notify_at = now() WHERE id = $1",
      [failed?.id],
    );
    await runChecks();

    // #then
    expect({
      afterFailure: [failed?.notified_at, failed?.last_notify_error],
      emailed: await emailed("payout_needs_review", payoutId),
    }).toEqual({
      afterFailure: [null, "fake Resend failure"],
      emailed: [EVERYONE],
    });
  });

  it("logs the alert instead when ALERT_EMAILS isn't set, and starts without it", async () => {
    // #given
    const quietEmail = makeFakeEmailSender();
    const quiet = makeTestRuntime(
      { emailSender: quietEmail.layer, paycrest: paycrest.layer },
      { ALERT_EMAILS: undefined },
    );
    const { company, wallet } = await companyWithWallet(100n * USDC);
    const payoutId = await insertPayout(company, wallet, {
      status: "needs_review",
    });

    // #when
    try {
      await quiet.runPromise(runAlerts());
      await quiet.runPromise(runAlerts());
    } finally {
      await quiet.dispose();
    }

    // #then
    const [incident] = await incidents("payout_needs_review", payoutId);
    expect({
      sent: quietEmail.state.sent.length,
      handled: incident?.notified_at !== null,
    }).toEqual({ sent: 0, handled: true });
  });

  it("hides alerts from every company's own scope", async () => {
    // #given
    const { company, wallet } = await companyWithWallet(100n * USDC);
    await insertPayout(company, wallet, { status: "needs_review" });
    await runChecks();

    // #when
    const visible = await runInScope(db, asAdmin(company), (tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(opsAlerts),
    );

    // #then
    expect(visible[0]?.count).toBe(0);
  });
});
