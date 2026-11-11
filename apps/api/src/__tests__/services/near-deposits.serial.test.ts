import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { NearTransactionOutcome } from "../../services/chain/near.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { DatabaseService } from "../../db/client.js";
import { wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { runAlerts } from "../../services/alerts/run-alerts.js";
import { createFundIn } from "../../services/intents/fund-in.js";
import {
  DEPOSITS_HELD_ALERT_BLOCKS,
  NEAR_INTENTS_ACCOUNT_ID,
  watchNearDeposits,
} from "../../services/wallet/near-deposits.js";
import { randomAddress } from "../helpers/fakes.js";
import { makeFakeFastNear } from "../helpers/fast-near.js";
import {
  createFundedCompany,
  ledgerOf,
  readQuote,
  saveQuote,
} from "../helpers/money-in.js";
import {
  FAKE_RELAYER_ACCOUNT,
  ftTransferLog,
  makeFakeNearRpc,
  nearOutcome,
  randomNearAccount,
  randomNearTxHash,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const rpc = makeFakeNearRpc();
const fastNear = makeFakeFastNear();
const oneClick = makeFakeOneClick();
let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let funded: FundedCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({
    nearRpc: rpc.layer,
    fastNear: fastNear.layer,
    oneClick: oneClick.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

beforeEach(async () => {
  funded = await createFundedCompany(db);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

/** A final transaction in which the USDC contract moved `amount` to the company wallet. */
function usdcSent(
  from: string,
  amount: bigint,
  to = funded.accountId,
): NearTransactionOutcome {
  const outcome = nearOutcome(
    [
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [ftTransferLog([{ from, to, amount }])],
      },
    ],
    { signerId: from },
  );
  rpc.state.outcomes.set(outcome.txHash, outcome);
  return outcome;
}

/** The same, and the indexer lists it. */
function arrived(from: string, amount: bigint): NearTransactionOutcome {
  const outcome = usdcSent(from, amount);
  fastNear.state.index(funded.accountId, outcome);
  return outcome;
}

const watch = () => runtime.runPromise(watchNearDeposits());

const ledger = () => ledgerOf(db, funded);

async function resumeToken(): Promise<string | null> {
  const [row] = await runInScope(
    db,
    { organizationId: funded.company.organizationId },
    (tx) =>
      tx
        .select({ token: wallets.depositsResumeToken })
        .from(wallets)
        .where(eq(wallets.id, funded.walletId)),
  );
  return row?.token ?? null;
}

/** Makes the watcher read the wallet's transfers from the very start again. */
const forgetPosition = () =>
  owner.query("UPDATE wallets SET deposits_resume_token = NULL WHERE id = $1", [
    funded.walletId,
  ]);

/** USDC sent to a company wallet that the indexer lists and the RPC doesn't know yet. */
function notYetFinal(
  amount: bigint,
  to: FundedCompany = funded,
): NearTransactionOutcome {
  const sender = randomNearAccount();
  const outcome = nearOutcome(
    [
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [ftTransferLog([{ from: sender, to: to.accountId, amount }])],
      },
    ],
    { signerId: sender },
  );
  fastNear.state.index(to.accountId, outcome);
  return outcome;
}

/** Moves the chain's final block `blocks` past the block `outcome` is in. */
function chainPast(outcome: NearTransactionOutcome, blocks: bigint): void {
  rpc.state.height = outcome.blockHeight + blocks;
}

const LONG_ENOUGH = DEPOSITS_HELD_ALERT_BLOCKS + 100n;

interface HeldAlert {
  readonly subjectKey: string;
  readonly title: string;
  readonly details: readonly { label: string; value: string }[];
  readonly occurrences: number;
  readonly open: boolean;
}

/** Every held-deposits alert about the company, oldest first. */
async function heldAlerts(
  company: FundedCompany = funded,
): Promise<HeldAlert[]> {
  const { rows } = await owner.query<HeldAlert>(
    `SELECT subject_key AS "subjectKey", title, details, occurrences,
            resolved_at IS NULL AS open
     FROM ops_alerts
     WHERE kind = 'deposits_held' AND organization_id = $1
     ORDER BY opened_at, id`,
    [company.company.organizationId],
  );
  return rows;
}

const detail = (alert: HeldAlert | undefined, label: string) =>
  alert?.details.find((line) => line.label === label)?.value;

describe("watchNearDeposits", () => {
  it("credits USDC sent to a company wallet as a deposit, named by its receipt and its place in it", async () => {
    // #given
    const sender = randomNearAccount();
    const outcome = nearOutcome(
      [
        { executorId: "other.testnet", logs: ["first", "second"] },
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [
            "Refund 1 from someone",
            ftTransferLog([
              { from: sender, to: randomNearAccount(), amount: 9n },
              { from: sender, to: funded.accountId, amount: 20_000_000n },
            ]),
          ],
        },
      ],
      { signerId: sender },
    );
    rpc.state.outcomes.set(outcome.txHash, outcome);
    fastNear.state.index(funded.accountId, outcome);

    // #when
    await watch();

    // #then
    expect(await ledger()).toEqual([
      {
        type: "deposit",
        chain: "near",
        usdcAmount: 20_000_000n,
        txHash: outcome.txHash,
        receiptId: outcome.receipts[1]?.receiptId,
        logIndex: 1,
        transferIndex: 1,
        blockNumber: outcome.blockHeight,
        counterpartyAddress: sender,
        payoutId: null,
      },
    ]);
  });

  it("audits the deposit as the watcher's", async () => {
    // #given
    arrived(randomNearAccount(), 1_000_000n);

    // #when
    await watch();

    // #then
    const { rows } = await owner.query<{
      actor_type: string;
      actor_id: string;
    }>(
      "SELECT actor_type, actor_id FROM audit_log WHERE organization_id = $1 AND action = 'wallet.deposit_received'",
      [funded.company.organizationId],
    );
    expect(rows).toEqual([
      { actor_type: "system", actor_id: "near-deposit-watcher" },
    ]);
  });

  it("credits a transfer once when the same page is read again", async () => {
    // #given
    arrived(randomNearAccount(), 5_000_000n);
    await watch();
    await forgetPosition();

    // #when
    const run = await watch();

    // #then
    expect({
      alreadyCredited: run.alreadyCredited,
      rows: (await ledger()).length,
    }).toEqual({ alreadyCredited: 1, rows: 1 });
  });

  it("doesn't read a handled transfer again on the next run", async () => {
    // #given
    arrived(randomNearAccount(), 5_000_000n);
    await watch();

    // #when
    const run = await watch();

    // #then
    expect({
      credited: run.credited,
      alreadyCredited: run.alreadyCredited,
      token: await resumeToken(),
    }).toEqual({ credited: 0, alreadyCredited: 0, token: "1" });
  });

  it("doesn't credit an ft_transfer event another contract logged", async () => {
    // #given
    const sender = randomNearAccount();
    const forged = nearOutcome(
      [
        {
          executorId: "fake-usdc.testnet",
          logs: [
            ftTransferLog([
              { from: sender, to: funded.accountId, amount: 50_000_000n },
            ]),
          ],
        },
      ],
      { signerId: sender },
    );
    rpc.state.outcomes.set(forged.txHash, forged);
    fastNear.state.report(funded.accountId, {
      blockHeight: forged.blockHeight,
      transactionId: forged.txHash,
      receiptId: forged.receipts[0]?.receiptId ?? "",
      logIndex: 0,
      signerId: sender,
      otherAccountId: sender,
      amount: 50_000_000n,
    });

    // #when
    const run = await watch();

    // #then
    expect({
      unconfirmed: run.unconfirmed,
      ledger: await ledger(),
      token: await resumeToken(),
    }).toEqual({ unconfirmed: 1, ledger: [], token: "1" });
  });

  it("doesn't credit an amount the indexer reports but the chain doesn't show", async () => {
    // #given
    const outcome = usdcSent(randomNearAccount(), 1_000_000n);
    fastNear.state.report(funded.accountId, {
      blockHeight: outcome.blockHeight,
      transactionId: outcome.txHash,
      receiptId: outcome.receipts[0]?.receiptId ?? "",
      logIndex: 0,
      signerId: outcome.signerId,
      otherAccountId: outcome.signerId,
      amount: 900_000_000n,
    });

    // #when
    await watch();

    // #then
    expect(await ledger()).toEqual([]);
  });

  it("waits at a transfer the RPC doesn't confirm, then credits it once the RPC does", async () => {
    // #given
    const sender = randomNearAccount();
    const pending = nearOutcome(
      [
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [
            ftTransferLog([
              { from: sender, to: funded.accountId, amount: 7_000_000n },
            ]),
          ],
        },
      ],
      { signerId: sender },
    );
    fastNear.state.index(funded.accountId, pending);
    const first = await watch();
    const before = { ledger: await ledger(), token: await resumeToken() };

    // #when
    rpc.state.outcomes.set(pending.txHash, pending);
    await watch();

    // #then
    expect({
      held: first.held >= 1,
      before,
      after: (await ledger()).map((row) => row.usdcAmount),
    }).toEqual({
      held: true,
      before: { ledger: [], token: null },
      after: [7_000_000n],
    });
  });

  it("treats USDC from the gas relayer as internal", async () => {
    // #given
    arrived(FAKE_RELAYER_ACCOUNT, 53_815n);

    // #when
    const run = await watch();

    // #then
    expect({
      internal: run.internal,
      ledger: await ledger(),
      token: await resumeToken(),
    }).toEqual({ internal: 1, ledger: [], token: "1" });
  });

  it("holds a transfer from NEAR Intents while a Base hop is unsettled, then skips it once 1Click lists it as the hop's", async () => {
    // #given
    const hop = await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "depositing" },
    });
    oneClick.state.setStatus(hop.depositAddress, { status: "PROCESSING" });
    const refund = arrived(NEAR_INTENTS_ACCOUNT_ID, 50_539n);
    const later = arrived(randomNearAccount(), 3_000_000n);
    await watch();
    const whileHeld = { ledger: await ledger(), token: await resumeToken() };

    // #when
    oneClick.state.setStatus(hop.depositAddress, {
      status: "SUCCESS",
      nearTxHashes: [randomNearTxHash(), refund.txHash],
    });
    const run = await watch();

    // #then
    expect({
      whileHeld,
      internal: run.internal,
      ledger: (await ledger()).map((row) => row.txHash),
      token: await resumeToken(),
    }).toEqual({
      whileHeld: { ledger: [], token: null },
      internal: 1,
      ledger: [later.txHash],
      token: "2",
    });
  });

  it("holds a transfer from NEAR Intents when 1Click can't be asked about a quote that just settled", async () => {
    // #given
    await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "succeeded", settledAt: new Date() },
    });
    arrived(NEAR_INTENTS_ACCOUNT_ID, 50_539n);
    oneClick.state.failNextStatus();

    // #when
    await watch();

    // #then
    expect({ ledger: await ledger(), token: await resumeToken() }).toEqual({
      ledger: [],
      token: null,
    });
  });

  it("only saves what 1Click reports on a Base hop, never its status", async () => {
    // #given
    const hop = await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "depositing" },
    });
    const refund = arrived(NEAR_INTENTS_ACCOUNT_ID, 50_539n);
    oneClick.state.setStatus(hop.depositAddress, {
      status: "SUCCESS",
      nearTxHashes: [refund.txHash],
      destinationChainTxHashes: ["0xabc"],
      refundedAmount: 50_539n,
    });

    // #when
    await watch();

    // #then
    const saved = await readQuote(db, funded, hop.id);
    expect({
      status: saved.status,
      settledAt: saved.settledAt,
      oneClickStatus: saved.oneClickStatus,
      nearTxHashes: saved.nearTxHashes,
      destinationChainTxHashes: saved.destinationChainTxHashes,
      refundedAmount: saved.refundedAmount,
    }).toEqual({
      status: "depositing",
      settledAt: null,
      oneClickStatus: "SUCCESS",
      nearTxHashes: [refund.txHash],
      destinationChainTxHashes: ["0xabc"],
      refundedAmount: 50_539n,
    });
  });

  it("treats a sweep arriving as internal, by the hash its quote lists", async () => {
    // #given
    const sweep = arrived(NEAR_INTENTS_ACCOUNT_ID, 4_995_535n);
    await saveQuote(runtime, db, funded, "sweep", {
      row: {
        status: "succeeded",
        settledAt: new Date(Date.now() - 60 * 60_000),
        destinationChainTxHashes: [sweep.txHash],
      },
    });

    // #when
    const run = await watch();

    // #then
    expect({ internal: run.internal, ledger: await ledger() }).toEqual({
      internal: 1,
      ledger: [],
    });
  });

  it("matches a quote's NEAR hash exactly: the same hash in another case explains nothing", async () => {
    // #given
    const deposit = arrived(randomNearAccount(), 2_000_000n);
    await saveQuote(runtime, db, funded, "sweep", {
      row: {
        status: "succeeded",
        settledAt: new Date(Date.now() - 60 * 60_000),
        nearTxHashes: [deposit.txHash.toLowerCase()],
      },
    });

    // #when
    await watch();

    // #then
    expect((await ledger()).map((row) => row.txHash)).toEqual([deposit.txHash]);
  });

  it("credits a stranger's withdrawal from NEAR Intents when the company has no quotes", async () => {
    // #given
    const withdrawal = arrived(NEAR_INTENTS_ACCOUNT_ID, 12_000_000n);

    // #when
    await watch();

    // #then
    expect(
      (await ledger()).map((row) => ({
        type: row.type,
        usdcAmount: row.usdcAmount,
        txHash: row.txHash,
        counterpartyAddress: row.counterpartyAddress,
      })),
    ).toEqual([
      {
        type: "deposit",
        usdcAmount: 12_000_000n,
        txHash: withdrawal.txHash,
        counterpartyAddress: NEAR_INTENTS_ACCOUNT_ID,
      },
    ]);
  });

  it("credits a withdrawal from NEAR Intents once every quote of the company has settled without listing it", async () => {
    // #given
    await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "succeeded", settledAt: new Date() },
    });
    arrived(NEAR_INTENTS_ACCOUNT_ID, 12_000_000n);

    // #when
    await watch();

    // #then
    expect((await ledger()).map((row) => row.usdcAmount)).toEqual([
      12_000_000n,
    ]);
  });

  it("credits a fund-in once when it arrives, and settles it", async () => {
    // #given
    const fundIn = await runtime.runPromise(
      createFundIn({
        organizationId: funded.company.organizationId,
        actor: { type: "user", id: funded.company.admin.id },
        chain: "base",
        amount: 25_000_000n,
        refundAddress: randomAddress(),
      }),
    );
    const delivery = arrived(NEAR_INTENTS_ACCOUNT_ID, fundIn.amountOut);
    oneClick.state.setStatus(fundIn.depositAddress, {
      status: "SUCCESS",
      destinationChainTxHashes: [delivery.txHash],
    });
    await watch();
    await forgetPosition();

    // #when
    await watch();

    // #then
    expect({
      ledger: (await ledger()).map((row) => ({
        type: row.type,
        usdcAmount: row.usdcAmount,
        txHash: row.txHash,
      })),
      status: (await readQuote(db, funded, fundIn.id)).status,
    }).toEqual({
      ledger: [
        {
          type: "deposit",
          usdcAmount: fundIn.amountOut,
          txHash: delivery.txHash,
        },
      ],
      status: "succeeded",
    });
  });

  it("doesn't credit a fund-in from 1Click's word alone", async () => {
    // #given
    const fundIn = await runtime.runPromise(
      createFundIn({
        organizationId: funded.company.organizationId,
        actor: { type: "user", id: funded.company.admin.id },
        chain: "solana",
        amount: 25_000_000n,
        refundAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }),
    );
    oneClick.state.setStatus(fundIn.depositAddress, {
      status: "SUCCESS",
      destinationChainTxHashes: [randomNearTxHash()],
    });

    // #when
    await watch();

    // #then
    expect(await ledger()).toEqual([]);
  });

  it("keeps reading other wallets when one wallet's indexer request fails", async () => {
    // #given
    arrived(randomNearAccount(), 4_000_000n);
    fastNear.state.failNext();

    // #when
    const first = await watch();
    await watch();

    // #then
    expect({
      failed: first.failed,
      ledger: (await ledger()).map((row) => row.usdcAmount),
    }).toEqual({ failed: 1, ledger: [4_000_000n] });
  });
});

describe("watchNearDeposits, for a wallet held at a transfer", () => {
  it("doesn't alert while the wallet has waited less than 15 minutes", async () => {
    // #given
    const pending = notYetFinal(7_000_000n);
    chainPast(pending, DEPOSITS_HELD_ALERT_BLOCKS - 100n);

    // #when
    const runs = [await watch(), await watch()];

    // #then
    expect({
      held: runs.every((run) => run.held >= 1),
      alerts: await heldAlerts(),
    }).toEqual({ held: true, alerts: [] });
  });

  it("raises one alert for the company wallet however many runs find it still waiting", async () => {
    // #given
    const pending = notYetFinal(7_000_000n);
    chainPast(pending, LONG_ENOUGH);

    // #when
    await watch();
    await watch();
    await watch();

    // #then
    const alerts = await heldAlerts();
    expect(
      alerts.map((alert) => ({
        subjectKey: alert.subjectKey,
        title: alert.title,
        open: alert.open,
        occurrences: alert.occurrences,
        wallet: detail(alert, "Company wallet"),
        transaction: detail(alert, "Held at NEAR transaction"),
      })),
    ).toEqual([
      {
        subjectKey: funded.walletId,
        title: `Deposits held at ${funded.company.name}`,
        open: true,
        occurrences: 1,
        wallet: funded.accountId,
        transaction: pending.txHash,
      },
    ]);
  });

  it("says the RPC doesn't know the transaction, and never shows the amount", async () => {
    // #given
    const pending = notYetFinal(7_123_456n);
    chainPast(pending, LONG_ENOUGH);

    // #when
    await watch();

    // #then
    const [alert] = await heldAlerts();
    expect({
      why: detail(alert, "Why it's held"),
      amountShown: JSON.stringify(alert?.details).includes("7123456"),
    }).toEqual({
      why: "The NEAR RPC doesn't return this transaction as final, so the transfer can't be checked against the chain. Look it up on a NEAR explorer: if it is final there, the RPC node no longer keeps transactions that old and NEAR_RPC_URL needs an archival node.",
      amountShown: false,
    });
  });

  it("names the unsettled quote a transfer from NEAR Intents waits on, and that one in needs_review waits for a person", async () => {
    // #given
    const hop = await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "needs_review" },
    });
    const transfer = arrived(NEAR_INTENTS_ACCOUNT_ID, 50_539n);
    chainPast(transfer, LONG_ENOUGH);

    // #when
    await watch();

    // #then
    const [alert] = await heldAlerts();
    expect(detail(alert, "Why it's held")).toEqual(
      `It came from NEAR Intents while the company's Base hop quote ${hop.id} is needs_review, so it may be that quote's own refund or delivery. It waits until 1Click lists it or the quote settles. A quote in needs_review settles only once someone has checked it.`,
    );
  });

  it("resolves the alert once the wallet gets past the transfer", async () => {
    // #given
    const pending = notYetFinal(7_000_000n);
    chainPast(pending, LONG_ENOUGH);
    await watch();
    const whileHeld = (await heldAlerts()).map((alert) => alert.open);

    // #when
    rpc.state.outcomes.set(pending.txHash, pending);
    await watch();

    // #then
    expect({
      whileHeld,
      after: (await heldAlerts()).map((alert) => alert.open),
      ledger: (await ledger()).map((row) => row.usdcAmount),
    }).toEqual({ whileHeld: [true], after: [false], ledger: [7_000_000n] });
  });

  it("gives another company's held wallet its own alert, resolved on its own", async () => {
    // #given
    const other = await createFundedCompany(db);
    const ours = notYetFinal(1_000_000n);
    notYetFinal(2_000_000n, other);
    chainPast(ours, LONG_ENOUGH);
    await watch();
    const whileBothHeld = {
      ours: (await heldAlerts()).map((alert) => alert.subjectKey),
      theirs: (await heldAlerts(other)).map((alert) => alert.subjectKey),
    };

    // #when
    rpc.state.outcomes.set(ours.txHash, ours);
    await watch();

    // #then
    expect({
      whileBothHeld,
      oursOpen: (await heldAlerts()).map((alert) => alert.open),
      theirsOpen: (await heldAlerts(other)).map((alert) => alert.open),
    }).toEqual({
      whileBothHeld: { ours: [funded.walletId], theirs: [other.walletId] },
      oursOpen: [false],
      theirsOpen: [true],
    });
  });

  it("isn't resolved by the other alert checks", async () => {
    // #given
    chainPast(notYetFinal(7_000_000n), LONG_ENOUGH);
    await watch();

    // #when
    await runtime.runPromise(runAlerts());

    // #then
    expect((await heldAlerts()).map((alert) => alert.open)).toEqual([true]);
  });

  it("leaves the alert open while the wallet can't be read", async () => {
    // #given
    chainPast(notYetFinal(7_000_000n), LONG_ENOUGH);
    await watch();

    // #when
    fastNear.state.failNext(Number.MAX_SAFE_INTEGER);
    const run = await watch();
    fastNear.state.failNext(0);

    // #then
    expect({
      failed: run.failed >= 1,
      open: (await heldAlerts()).map((alert) => alert.open),
    }).toEqual({ failed: true, open: [true] });
  });

  it("leaves the alert open while the chain's height can't be read", async () => {
    // #given
    chainPast(notYetFinal(7_000_000n), LONG_ENOUGH);
    await watch();

    // #when
    rpc.state.failNext("finalBlock");
    await watch();

    // #then
    expect((await heldAlerts()).map((alert) => alert.open)).toEqual([true]);
  });
});
