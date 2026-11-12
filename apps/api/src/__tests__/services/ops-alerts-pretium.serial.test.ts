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

import type { SystemHealth } from "@expendi-business/shared";
import { systemHealthSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { OpsAlertKind, Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { payouts, walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { webhookSignatureFailure } from "../../services/alerts/alert-checks.js";
import { raiseAlert } from "../../services/alerts/ops-alerts.js";
import { runAlerts } from "../../services/alerts/run-alerts.js";
import { nairobiDate } from "../../services/bills/status.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../../services/pretium/settlement.js";
import { insertBill, insertPayee, shiftDays } from "../helpers/bills.js";
import { randomTxHash } from "../helpers/chain.js";
import { addCategory } from "../helpers/claims.js";
import { createActiveWallet, createCompany } from "../helpers/db.js";
import {
  makeFakeEmailSender,
  makeFakePaycrest,
  makeFakePretium,
} from "../helpers/fakes.js";
import { USDC } from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * Serial: alerts and job heartbeats are platform-wide. The ops alerts and
 * system health page for Pretium cash-outs, next to Paycrest's.
 */

const email = makeFakeEmailSender();
const paycrest = makeFakePaycrest();
const pretium = makeFakePretium();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let viewer: TestStaff;
let opsAdmin: TestStaff;

beforeAll(async () => {
  runtime = makeTestRuntime(
    {
      emailSender: email.layer,
      paycrest: paycrest.layer,
      pretium: pretium.layer,
    },
    { ALERT_EMAILS: "ops@expendi.test" },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  viewer = await createStaff(owner, { role: "ops_viewer" });
  opsAdmin = await createStaff(owner, { role: "ops_admin" });
});

afterAll(async () => {
  await setProvider("paycrest");
  await Promise.all([runtime.dispose(), owner.end()]);
});

afterEach(async () => {
  await setProvider("paycrest");
});

async function setProvider(provider: "paycrest" | "pretium"): Promise<void> {
  await db.execute(
    sql`SELECT set_active_cash_out_provider(${provider}::cash_out_provider, ${opsAdmin.staffUserId}::uuid, 'Provider test', 'req-alerts-pretium', '203.0.113.9', 'alerts-test')`,
  );
}

async function setHeartbeat(job: string, minutesAgo: number): Promise<void> {
  await owner.query(
    `INSERT INTO station_heartbeats (job, last_finished_at)
     VALUES ($1, now() - make_interval(mins => $2))
     ON CONFLICT (job) DO UPDATE SET last_finished_at = excluded.last_finished_at`,
    [job, minutesAgo],
  );
}

beforeEach(async () => {
  email.state.reset();
  paycrest.state.reset();
  pretium.state.reset();
  await setHeartbeat("reconcile-paycrest", 0);
  await setHeartbeat("reconcile-pretium", 0);
  await owner.query(
    "UPDATE ops_alerts SET resolved_at = now() WHERE kind = 'webhook_signature_failure' AND resolved_at IS NULL",
  );
});

const runChecks = () => runtime.runPromise(runAlerts());

interface Incident {
  readonly id: string;
  readonly title: string;
  readonly details: readonly { label: string; value: string }[];
  readonly occurrences: number;
  readonly resolved_at: Date | null;
}

/** Every incident of `kind` about `subjectKey`, oldest first. */
async function incidents(
  kind: OpsAlertKind,
  subjectKey: string,
): Promise<Incident[]> {
  const { rows } = await owner.query<Incident>(
    "SELECT id, title, details, occurrences, resolved_at FROM ops_alerts WHERE kind = $1 AND subject_key = $2 ORDER BY opened_at, id",
    [kind, subjectKey],
  );
  return rows;
}

async function health(): Promise<SystemHealth> {
  const response = await app.request("/internal/health", {
    headers: bearer(viewer.privyUserId),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return systemHealthSchema.parse(body.data);
}

async function companyWithWallet(): Promise<{
  company: TestCompany;
  wallet: TestWallet;
}> {
  const company = await createCompany(db);
  return { company, wallet: await createActiveWallet(db, company) };
}

/** A cash-out under review, written straight to the table. */
async function payoutUnderReview(
  company: TestCompany,
  wallet: TestWallet,
  provider: Extract<Payout["provider"], "paycrest" | "pretium">,
  sent: { readonly code: string | null; readonly txHash: string | null },
): Promise<string> {
  const [payout] = await runInScope(
    db,
    {
      organizationId: company.organizationId,
      userId: company.admin.id,
      role: "admin",
    },
    (tx) =>
      tx
        .insert(payouts)
        .values({
          organizationId: company.organizationId,
          walletId: wallet.id,
          subjectType: "claim",
          subjectId: randomUUID(),
          idempotencyKey: `claim:${randomUUID()}:1`,
          provider,
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
          providerOrderId: sent.code,
          depositAddress:
            provider === "pretium"
              ? PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase()
              : null,
          txHash: sent.txHash,
          approvalId: randomUUID(),
          approvedBy: company.admin.id,
          approvedAt: new Date(),
          status: "needs_review",
          failureReason: "Funding started but no outcome was recorded.",
        })
        .returning({ id: payouts.id }),
  );
  if (!payout) throw new Error("payout insert returned no row");
  return payout.id;
}

const detail = (incident: Incident | undefined, label: string) =>
  incident?.details.find((line) => line.label === label)?.value ?? null;

describe("Pretium webhook signature failure", () => {
  it("opens an incident named for Pretium, kept apart from Paycrest's", async () => {
    // #when
    await runtime.runPromise(raiseAlert(webhookSignatureFailure("pretium")));
    await runtime.runPromise(raiseAlert(webhookSignatureFailure("pretium")));
    await runChecks();

    // #then
    const open = (
      await incidents("webhook_signature_failure", "pretium")
    ).filter((incident) => incident.resolved_at === null);
    expect(
      open.map(({ title, occurrences, details }) => ({
        title,
        occurrences,
        source: details.find((line) => line.label === "Source")?.value,
      })),
    ).toEqual([
      {
        title: "Pretium webhook failed signature verification",
        occurrences: 2,
        source: "Pretium webhook",
      },
    ]);
  });
});

describe("Pretium reconciliation stopped", () => {
  it("opens an incident naming Pretium when its job hasn't run for over 5 minutes, and resolves when it runs again", async () => {
    // #given
    await runChecks();
    const before = (
      await incidents("reconciliation_stopped", "reconcile-pretium")
    ).length;
    await setHeartbeat("reconcile-pretium", 6);

    // #when
    await runChecks();
    const whileStopped = (
      await incidents("reconciliation_stopped", "reconcile-pretium")
    ).slice(before);
    await setHeartbeat("reconcile-pretium", 0);
    await runChecks();

    // #then
    const after = (
      await incidents("reconciliation_stopped", "reconcile-pretium")
    ).slice(before);
    expect({
      whileStopped: whileStopped.map(({ title, resolved_at }) => ({
        title,
        resolved: resolved_at !== null,
      })),
      meaning: detail(whileStopped[0], "What it means"),
      resolved: after.map((incident) => incident.resolved_at !== null),
      paycrest: (
        await incidents("reconciliation_stopped", "reconcile-paycrest")
      ).filter((incident) => incident.resolved_at === null),
    }).toEqual({
      whileStopped: [
        { title: "Pretium reconciliation has stopped", resolved: false },
      ],
      meaning:
        "Cash-outs aren't being checked against Pretium, so stuck or failed payments go unnoticed until it runs again. Check the API's logs.",
      resolved: [true],
      paycrest: [],
    });
  });

  it("stays quiet while Pretium's job ran within 5 minutes", async () => {
    // #given
    await runChecks();
    await setHeartbeat("reconcile-pretium", 4);

    // #when
    await runChecks();

    // #then
    expect(
      (await incidents("reconciliation_stopped", "reconcile-pretium")).filter(
        (incident) => incident.resolved_at === null,
      ),
    ).toEqual([]);
  });
});

describe("payout alerts name the provider", () => {
  it("names Pretium's transaction, or the Base transfer before Pretium gave one, and Paycrest's order", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const hash = randomTxHash();
    const [withCode, withHash, paycrest] = [
      await payoutUnderReview(company, wallet, "pretium", {
        code: "TXALERT01",
        txHash: randomTxHash(),
      }),
      await payoutUnderReview(company, wallet, "pretium", {
        code: null,
        txHash: hash,
      }),
      await payoutUnderReview(company, wallet, "paycrest", {
        code: "order-alert-01",
        txHash: null,
      }),
    ];

    // #when
    await runChecks();

    // #then
    const [codeAlert] = await incidents("payout_needs_review", withCode);
    const [hashAlert] = await incidents("payout_needs_review", withHash);
    const [paycrestAlert] = await incidents("payout_needs_review", paycrest);
    expect({
      withCode: [
        detail(codeAlert, "Pretium transaction"),
        detail(codeAlert, "Paycrest order"),
      ],
      withHash: [
        detail(hashAlert, "Base transfer to Pretium"),
        detail(hashAlert, "Pretium transaction"),
      ],
      paycrest: [
        detail(paycrestAlert, "Paycrest order"),
        detail(paycrestAlert, "Pretium transaction"),
      ],
    }).toEqual({
      withCode: ["TXALERT01", null],
      withHash: [hash, null],
      paycrest: ["order-alert-01", null],
    });
  });
});

describe("system health for both cash-out providers", () => {
  it("reports Pretium's reconciliation heartbeat as Paycrest's is reported", async () => {
    // #given
    await setHeartbeat("reconcile-paycrest", 1);
    await setHeartbeat("reconcile-pretium", 7);

    // #when
    const result = await health();

    // #then
    expect({
      paycrest: [result.reconciliation.job, result.reconciliation.stale],
      pretium: {
        ...result.pretiumReconciliation,
        lastFinishedAt: result.pretiumReconciliation.lastFinishedAt !== null,
      },
    }).toEqual({
      paycrest: ["reconcile-paycrest", false],
      pretium: {
        job: "reconcile-pretium",
        lastFinishedAt: true,
        staleAfterMinutes: 5,
        stale: true,
      },
    });
  });

  it("shows Pretium's reconciliation as stopped when it has never finished a run", async () => {
    // #given
    await owner.query(
      "DELETE FROM station_heartbeats WHERE job = 'reconcile-pretium'",
    );

    // #when
    const result = await health();

    // #then
    expect(result.pretiumReconciliation).toEqual({
      job: "reconcile-pretium",
      lastFinishedAt: null,
      staleAfterMinutes: 5,
      stale: true,
    });
  });

  it("shows each webhook's own signature incident", async () => {
    // #given only Pretium's webhook is failing
    await runtime.runPromise(raiseAlert(webhookSignatureFailure("paycrest")));
    await owner.query(
      "UPDATE ops_alerts SET resolved_at = now() - interval '1 minute' WHERE kind = 'webhook_signature_failure' AND subject_key = 'paycrest' AND resolved_at IS NULL",
    );
    await runtime.runPromise(raiseAlert(webhookSignatureFailure("pretium")));
    await runtime.runPromise(raiseAlert(webhookSignatureFailure("pretium")));
    await runtime.runPromise(raiseAlert(webhookSignatureFailure("lithic")));

    // #when
    const result = await health();

    // #then
    const [pretiumIncident] = (
      await incidents("webhook_signature_failure", "pretium")
    ).filter((incident) => incident.resolved_at === null);
    expect({
      paycrestOpen: result.paycrestWebhook.signatureFailures?.open,
      pretium: {
        resolvesAfterQuietMinutes:
          result.pretiumWebhook.resolvesAfterQuietMinutes,
        alertId: result.pretiumWebhook.signatureFailures?.alertId,
        open: result.pretiumWebhook.signatureFailures?.open,
        count: result.pretiumWebhook.signatureFailures?.count,
      },
    }).toEqual({
      paycrestOpen: false,
      pretium: {
        resolvesAfterQuietMinutes: 60,
        alertId: pretiumIncident?.id,
        open: true,
        count: 2,
      },
    });
  });
});

describe("low company balance under the active cash-out provider", () => {
  /** About KES 1,295 against a KES 50,000 bill due in 5 days. */
  async function shortCompany(): Promise<TestCompany> {
    const { company, wallet } = await companyWithWallet();
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx.insert(walletTransactions).values({
        organizationId: company.organizationId,
        walletId: wallet.id,
        type: "deposit",
        usdcAmount: 10n * USDC,
        txHash: randomTxHash(),
        logIndex: 0,
        blockNumber: 1n,
      }),
    );
    await insertBill(db, company, {
      payeeId: await insertPayee(db, company),
      categoryId: await addCategory(db, company, `Utilities ${randomUUID()}`),
      amountKes: 5_000_000n,
      dueOn: shiftDays(nairobiDate(new Date()), 5),
    });
    return company;
  }

  it("values the wallet at the active provider's rate, so Paycrest being down doesn't hide it under Pretium", async () => {
    // #given Paycrest's rate is unavailable
    paycrest.state.failRate = true;
    const company = await shortCompany();
    const open = async () =>
      (await incidents("low_company_balance", company.organizationId)).filter(
        (incident) => incident.resolved_at === null,
      ).length;

    // #when
    await runChecks();
    const underPaycrest = await open();
    await setProvider("pretium");
    await runChecks();

    // #then
    expect({ underPaycrest, underPretium: await open() }).toEqual({
      underPaycrest: 0,
      underPretium: 1,
    });
  });
});
