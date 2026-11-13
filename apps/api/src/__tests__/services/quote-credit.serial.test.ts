import { eq } from "drizzle-orm";
import { Effect } from "effect";
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
import type { IntentQuote } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { NearTransactionOutcome } from "../../services/chain/near.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { DatabaseService } from "../../db/client.js";
import {
  intentQuotes,
  invoicePayments,
  treasuryMoves,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { nairobiToday } from "../../services/expenses/rules.js";
import { sessionForQuote } from "../../services/intents/company-session.js";
import {
  createFundIn,
  refreshOpenFundIns,
} from "../../services/intents/fund-in.js";
import {
  creditSettledQuote,
  creditSettledQuotes,
} from "../../services/intents/quote-credit.js";
import { settleFromOneClick } from "../../services/intents/quote-settle.js";
import {
  getPayQuote,
  quoteForPayment,
} from "../../services/invoices/pay-link.js";
import {
  NEAR_INTENTS_ACCOUNT_ID,
  watchNearDeposits,
} from "../../services/wallet/near-deposits.js";
import { fundInsJob } from "../../station/fund-ins.js";
import {
  createDeliveryCompany,
  settleOpenQuotes,
  switchBalanceHome,
} from "../helpers/confidential-delivery.js";
import { makeFakeEmailSender, makeFakePrivyWallets } from "../helpers/fakes.js";
import { makeFakeFastNear } from "../helpers/fast-near.js";
import {
  asAdmin,
  createCustomerAndInvoice,
  readInvoice,
} from "../helpers/invoices.js";
import {
  ledgerOf,
  readQuote,
  saveQuote,
  saveTreasuryMove,
} from "../helpers/money-in.js";
import {
  ftTransferLog,
  makeFakeNearRpc,
  nearOutcome,
  randomNearTxHash,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

// Serial: the credit job and the deposit watcher walk every company in the database.

const DASHBOARD_ORIGIN = "https://business.expendi.test";
const privy = makeFakePrivyWallets();
const rpc = makeFakeNearRpc();
const fastNear = makeFakeFastNear();
const oneClick = makeFakeOneClick();
const email = makeFakeEmailSender();
let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let funded: FundedCompany;

beforeAll(async () => {
  runtime = makeTestRuntime(
    {
      privyWallets: privy.layer,
      nearRpc: rpc.layer,
      fastNear: fastNear.layer,
      oneClick: oneClick.layer,
      emailSender: email.layer,
    },
    { DASHBOARD_ORIGINS: DASHBOARD_ORIGIN },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

beforeEach(async () => {
  funded = await createDeliveryCompany(db, privy);
  email.state.reset();
});

afterEach(async () => {
  await settleOpenQuotes(db, funded);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const organizationId = () => funded.company.organizationId;

const refresh = () => runtime.runPromise(refreshOpenFundIns());
const creditAll = () => runtime.runPromise(creditSettledQuotes());
const creditOne = (quote: Pick<IntentQuote, "id">) =>
  runtime.runPromise(
    creditSettledQuote({ quoteId: quote.id, organizationId: organizationId() }),
  );

async function openFundIn(amount = 40_000_000n): Promise<IntentQuote> {
  const view = await runtime.runPromise(
    createFundIn({
      organizationId: organizationId(),
      actor: { type: "user", id: funded.company.admin.id },
      chain: "arbitrum",
      amount,
    }),
  );
  return readQuote(db, funded, view.id);
}

const quoteNow = (quote: Pick<IntentQuote, "id">) =>
  readQuote(db, funded, quote.id);

interface AuditRow {
  readonly action: string;
  readonly actorType: string;
  readonly after: Record<string, unknown> | null;
}

async function auditFor(entityId: string): Promise<AuditRow[]> {
  const { rows } = await owner.query<AuditRow>(
    `SELECT action, actor_type AS "actorType", after
       FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at, id`,
    [entityId],
  );
  return rows;
}

const paymentsOf = (invoiceId: string) =>
  runInScope(db, asAdmin(funded.company), (tx) =>
    tx
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, invoiceId)),
  );

describe("creditSettledQuotes, for a fund-in into a confidential account", () => {
  it("credits the ledger with what 1Click reports delivered, without a chain transaction", async () => {
    // #given
    const fundIn = await openFundIn();
    oneClick.state.deliverConfidential(fundIn.depositAddress, 39_900_000n);
    await refresh();

    // #when
    const summary = await creditAll();

    // #then
    const saved = await quoteNow(fundIn);
    const entry = (await auditFor(await creditId(fundIn))).find(
      (row) => row.action === "wallet.deposit_received",
    );
    expect(summary.credited).toBeGreaterThanOrEqual(1);
    expect({
      ledger: await ledgerOf(db, funded),
      status: saved.status,
      credited: saved.ledgerCreditedAt !== null,
      audit: {
        actorType: entry?.actorType,
        intentQuoteId: entry?.after?.intentQuoteId,
        fundInId: entry?.after?.fundInId,
        usdcAmount: entry?.after?.usdcAmount,
        source: entry?.after?.source,
      },
    }).toEqual({
      ledger: [
        {
          type: "deposit",
          chain: "near",
          usdcAmount: 39_900_000n,
          txHash: null,
          receiptId: null,
          logIndex: null,
          transferIndex: null,
          blockNumber: null,
          counterpartyAddress: null,
          payoutId: null,
          intentQuoteId: fundIn.id,
        },
      ],
      status: "succeeded",
      credited: true,
      audit: {
        actorType: "system",
        intentQuoteId: fundIn.id,
        fundInId: fundIn.id,
        usdcAmount: "39900000",
        source: "one_click_success",
      },
    });
  });

  it("is credited by the fund-ins job in the run that settles it", async () => {
    // #given
    const fundIn = await openFundIn();
    oneClick.state.deliverConfidential(fundIn.depositAddress, 39_900_000n);

    // #when
    await runtime.runPromise(fundInsJob.run);

    // #then
    expect((await ledgerOf(db, funded)).map((row) => row.usdcAmount)).toEqual([
      39_900_000n,
    ]);
  });

  it("credits once however often it runs", async () => {
    // #given
    const fundIn = await openFundIn();
    oneClick.state.deliverConfidential(fundIn.depositAddress, 39_900_000n);
    await refresh();

    // #when
    await creditAll();
    const second = await creditOne(fundIn);
    await creditAll();
    await refresh();
    await creditAll();

    // #then
    expect({
      second,
      ledger: (await ledgerOf(db, funded)).length,
    }).toEqual({ second: "already_credited", ledger: 1 });
  });

  it("credits once when two runs credit it at the same time", async () => {
    // #given
    const fundIn = await openFundIn();
    oneClick.state.deliverConfidential(fundIn.depositAddress, 39_900_000n);
    await refresh();

    // #when
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => creditOne(fundIn)),
    );
    await Promise.all([creditAll(), creditAll()]);

    // #then
    expect({
      outcomes: outcomes.sort(),
      ledger: (await ledgerOf(db, funded)).length,
    }).toEqual({
      outcomes: [
        ...Array.from({ length: 11 }, () => "already_credited"),
        "credited",
      ],
      ledger: 1,
    });
  });

  it.each<[string, bigint | undefined, bigint | undefined]>([
    ["reports no amount delivered", undefined, undefined],
    ["reports nothing delivered", 0n, undefined],
    ["reports more delivered than it was deposited", 40_000_001n, undefined],
    ["reports more delivered than was deposited", 12_000_000n, 10_000_000n],
  ])(
    "credits nothing when 1Click %s",
    async (_, amountOut, depositedAmount) => {
      // #given
      const fundIn = await openFundIn();
      oneClick.state.setStatus(fundIn.depositAddress, {
        status: "SUCCESS",
        depositedAmount: depositedAmount ?? 40_000_000n,
        ...(amountOut !== undefined && { amountOut }),
      });
      await refresh();

      // #when
      const outcome = await creditOne(fundIn);

      // #then
      const saved = await quoteNow(fundIn);
      expect({
        outcome,
        ledger: await ledgerOf(db, funded),
        status: saved.status,
        credited: saved.ledgerCreditedAt,
      }).toEqual({
        outcome: "amount_unusable",
        ledger: [],
        status: "succeeded",
        credited: null,
      });
      await retireFromCreditQueue(fundIn);
    },
  );

  it("credits the amount 1Click reports, not the amount the quote promised", async () => {
    // #given
    const fundIn = await openFundIn();
    oneClick.state.deliverConfidential(fundIn.depositAddress, 1_000_000n);
    await refresh();

    // #when
    await creditOne(fundIn);

    // #then
    expect(fundIn.amountOut).toBeGreaterThan(1_000_000n);
    expect((await ledgerOf(db, funded)).map((row) => row.usdcAmount)).toEqual([
      1_000_000n,
    ]);
  });

  it.each([
    ["is still waiting for its deposit", "PENDING_DEPOSIT"],
    ["was refunded", "REFUNDED"],
    ["failed", "FAILED"],
  ] as const)("credits nothing for a quote that %s", async (_, reported) => {
    // #given
    const fundIn = await openFundIn();
    oneClick.state.setStatus(fundIn.depositAddress, { status: reported });
    await refresh();

    // #when
    const outcome = await creditOne(fundIn);

    // #then
    expect({ outcome, ledger: await ledgerOf(db, funded) }).toEqual({
      outcome: "not_creditable",
      ledger: [],
    });
  });

  it("credits a quote that never delivered to a confidential account in no case", async () => {
    // #given a move-in, which is not money coming in
    const moveIn = await saveQuote(runtime, db, funded, "move_in", {
      row: {
        status: "succeeded",
        oneClickStatus: "SUCCESS",
        settledAt: new Date(),
        swappedAmountOut: 5_000_000n,
      },
    });

    // #when
    const outcome = await creditOne(moveIn);

    // #then
    expect({ outcome, ledger: await ledgerOf(db, funded) }).toEqual({
      outcome: "not_creditable",
      ledger: [],
    });
  });
});

describe("creditSettledQuotes, for a quote opened before or after the switch", () => {
  it("leaves a fund-in opened before the switch to the deposit watcher", async () => {
    // #given
    const home = await createDeliveryCompany(db, privy, "company_wallet");
    funded = home;
    const fundIn = await openFundIn();
    await switchBalanceHome(db, home, "confidential_account");
    const outcome: NearTransactionOutcome = nearOutcome(
      [
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [
            ftTransferLog([
              {
                from: NEAR_INTENTS_ACCOUNT_ID,
                to: home.accountId,
                amount: fundIn.amountOut,
              },
            ]),
          ],
        },
      ],
      { signerId: NEAR_INTENTS_ACCOUNT_ID },
    );
    rpc.state.outcomes.set(outcome.txHash, outcome);
    fastNear.state.index(home.accountId, outcome);
    oneClick.state.setStatus(fundIn.depositAddress, {
      status: "SUCCESS",
      destinationChainTxHashes: [outcome.txHash],
      amountOut: fundIn.amountOut,
    });
    await refresh();

    // #when
    const outcomeAtSettlement = await creditOne(fundIn);
    const settlementLedger = await ledgerOf(db, home);
    await runtime.runPromise(watchNearDeposits());

    // #then
    const asked = oneClick.state.calls.filter(
      (call) =>
        call.call === "status" && call.depositAddress === fundIn.depositAddress,
    );
    expect({
      recipientType: fundIn.recipientType,
      askedWithoutSession: asked.every((call) => call.session === undefined),
      outcomeAtSettlement,
      settlementLedger,
      ledger: (await ledgerOf(db, home)).map((row) => ({
        usdcAmount: row.usdcAmount,
        txHash: row.txHash,
        intentQuoteId: row.intentQuoteId,
      })),
    }).toEqual({
      recipientType: "DESTINATION_CHAIN",
      askedWithoutSession: true,
      outcomeAtSettlement: "not_creditable",
      settlementLedger: [],
      ledger: [
        {
          usdcAmount: fundIn.amountOut,
          txHash: outcome.txHash,
          intentQuoteId: null,
        },
      ],
    });
  });

  it("still credits a fund-in opened for a confidential account after the company was switched back", async () => {
    // #given
    const fundIn = await openFundIn();
    await switchBalanceHome(db, funded, "company_wallet");
    oneClick.state.deliverConfidential(fundIn.depositAddress, 39_900_000n);

    // #when
    await refresh();
    await creditAll();

    // #then
    const asked = oneClick.state.calls.filter(
      (call) =>
        call.call === "status" && call.depositAddress === fundIn.depositAddress,
    );
    expect({
      askedWithSession: asked.every((call) => call.session !== undefined),
      ledger: (await ledgerOf(db, funded)).map((row) => row.usdcAmount),
    }).toEqual({ askedWithSession: true, ledger: [39_900_000n] });
  });
});

describe("creditSettledQuotes, for a fund-in return", () => {
  it("credits a return that reached succeeded through settleFromOneClick alone", async () => {
    // #given
    const back = await saveQuote(runtime, db, funded, "fund_in_return", {
      confidential: true,
      row: { status: "depositing", depositStartedAt: new Date() },
    });
    oneClick.state.deliverConfidential(back.depositAddress, back.amountOut);

    // #when
    const settled = await runtime.runPromise(
      Effect.gen(function* () {
        const session = yield* sessionForQuote(back);
        return yield* settleFromOneClick(back, session);
      }),
    );
    const beforeJob = await ledgerOf(db, funded);
    await creditAll();

    // #then
    const [credit] = await ledgerOf(db, funded);
    expect({
      status: settled.status,
      beforeJob,
      credit: {
        type: credit?.type,
        usdcAmount: credit?.usdcAmount,
        intentQuoteId: credit?.intentQuoteId,
        txHash: credit?.txHash,
      },
    }).toEqual({
      status: "succeeded",
      beforeJob: [],
      credit: {
        type: "deposit",
        usdcAmount: back.amountOut,
        intentQuoteId: back.id,
        txHash: null,
      },
    });
  });
});

describe("creditSettledQuotes, for an invoice payment", () => {
  it("marks the invoice paid with the credit and emails a receipt with no transaction line", async () => {
    // #given
    const invoice = await createCustomerAndInvoice(db, funded.company, {
      status: "open",
    });
    const shown = await runtime.runPromise(
      quoteForPayment(invoice.publicId ?? "", "arbitrum"),
    );
    const quote = await quoteNow(shown);
    oneClick.state.deliverConfidential(quote.depositAddress, quote.amountOut);
    await refresh();

    // #when
    await Promise.all([creditOne(quote), creditOne(quote), creditAll()]);

    // #then
    const [credit] = await ledgerOf(db, funded);
    const [payment] = await paymentsOf(invoice.invoiceId);
    const [receipt] = email.state.sent;
    const afterwards = await runtime.runPromise(
      getPayQuote(invoice.publicId ?? "", quote.id),
    );
    const entry = (await auditFor(await creditId(quote))).find(
      (row) => row.action === "wallet.deposit_received",
    );
    expect({
      request: oneClick.state.quotes.get(quote.depositAddress)?.request
        .recipientType,
      saved: quote.recipientType,
      ledger: ledgerSummary(credit),
      invoice: (await readInvoice(db, funded.company, invoice.invoiceId))
        .status,
      payment: {
        count: (await paymentsOf(invoice.invoiceId)).length,
        kind: payment?.kind,
        intentQuoteId: payment?.intentQuoteId,
        amountUsdc: payment?.amountUsdc,
      },
      shown: afterwards.status,
      audit: {
        invoiceId: entry?.after?.invoiceId,
        invoicePaymentId: entry?.after?.invoicePaymentId,
      },
      receipts: email.state.sent.length,
      receiptHasTransactionLine:
        receipt?.text.includes("Transaction") === true ||
        receipt?.html.includes("View the transaction") === true,
      receiptKeepsTheRest: [
        invoice.number,
        "Arbitrum",
        "Keep this email as your receipt.",
        `Download receipt (PDF): ${DASHBOARD_ORIGIN}/pay/${invoice.publicId}/pdf`,
      ].every((part) => receipt?.text.includes(part)),
    }).toEqual({
      request: "CONFIDENTIAL_INTENTS",
      saved: "CONFIDENTIAL_INTENTS",
      ledger: { usdcAmount: quote.amountOut, txHash: null },
      invoice: "paid",
      payment: {
        count: 1,
        kind: "link",
        intentQuoteId: quote.id,
        amountUsdc: quote.amountOut,
      },
      shown: "paid",
      audit: {
        invoiceId: invoice.invoiceId,
        invoicePaymentId: payment?.id,
      },
      receipts: 1,
      receiptHasTransactionLine: false,
      receiptKeepsTheRest: true,
    });
  });

  it("credits the ledger and pays the invoice together or not at all", async () => {
    // #given an invoice whose payment can't be recorded
    const invoice = await createCustomerAndInvoice(db, funded.company, {
      status: "open",
    });
    const shown = await runtime.runPromise(
      quoteForPayment(invoice.publicId ?? "", "arbitrum"),
    );
    const quote = await quoteNow(shown);
    oneClick.state.deliverConfidential(quote.depositAddress, quote.amountOut);
    await refresh();
    await runInScope(db, asAdmin(funded.company), async (tx) => {
      const [earlier] = await tx
        .insert(walletTransactions)
        .values({
          organizationId: organizationId(),
          walletId: funded.walletId,
          type: "deposit",
          chain: "near",
          usdcAmount: 1n,
          txHash: randomNearTxHash(),
          receiptId: randomNearTxHash(),
          logIndex: 0,
          transferIndex: 0,
          blockNumber: 1n,
        })
        .returning({ id: walletTransactions.id });
      await tx.insert(invoicePayments).values({
        organizationId: organizationId(),
        invoiceId: invoice.invoiceId,
        kind: "link",
        intentQuoteId: quote.id,
        walletTransactionId: earlier?.id ?? "",
        amountUsdc: 1n,
        paidOn: nairobiToday(),
      });
    });

    // #when
    const exit = await runtime.runPromiseExit(
      creditSettledQuote({
        quoteId: quote.id,
        organizationId: organizationId(),
      }),
    );

    // #then
    expect({
      failed: exit._tag,
      ledgerAmounts: (await ledgerOf(db, funded)).map((row) => row.usdcAmount),
      credited: (await quoteNow(quote)).ledgerCreditedAt,
    }).toEqual({ failed: "Failure", ledgerAmounts: [1n], credited: null });
  });
});

/** An unusable quote stays due for ever; later runs of other tests shouldn't see it. */
const retireFromCreditQueue = (quote: Pick<IntentQuote, "id">) =>
  runInScope(db, { organizationId: organizationId() }, (tx) =>
    tx
      .update(intentQuotes)
      .set({ status: "refunded" })
      .where(eq(intentQuotes.id, quote.id)),
  );

function ledgerSummary(
  row: { usdcAmount: bigint; txHash: string | null } | undefined,
) {
  return { usdcAmount: row?.usdcAmount, txHash: row?.txHash };
}

async function creditId(quote: Pick<IntentQuote, "id">): Promise<string> {
  const [row] = await runInScope(
    db,
    { organizationId: organizationId() },
    (tx) =>
      tx
        .select({ id: walletTransactions.id })
        .from(walletTransactions)
        .where(eq(walletTransactions.intentQuoteId, quote.id)),
  );
  return row?.id ?? "";
}

const settledReturn = {
  status: "succeeded",
  oneClickStatus: "SUCCESS",
  settledAt: new Date(),
  depositedAmount: 5_000_000n,
} as const;

async function openReturn(
  options: {
    readonly confidential?: boolean;
    readonly delivered?: bigint;
  } = {},
) {
  const move = await saveTreasuryMove(db, funded, { direction: "to_wallet" });
  const quote = await saveQuote(runtime, db, funded, "from_treasury", {
    confidential: options.confidential ?? true,
    row: {
      ...settledReturn,
      treasuryMoveId: move.id,
      swappedAmountOut: options.delivered ?? 4_990_000n,
    },
  });
  return { move, quote };
}

afterEach(async () => {
  await runInScope(db, { organizationId: organizationId() }, (tx) =>
    tx
      .update(treasuryMoves)
      .set({ status: "failed", settledAt: new Date() })
      .where(eq(treasuryMoves.status, "open")),
  );
});

describe("creditSettledQuotes, for a return from Treasury into the account", () => {
  it("credits a from_treasury row linked to its move and quote, for what 1Click reports delivered, with no chain transaction", async () => {
    // #given a Move to wallet part 1Click delivered into the confidential account
    const { move, quote } = await openReturn({ delivered: 4_990_000n });

    // #when
    const outcome = await creditOne(quote);

    // #then
    const rows = await runInScope(
      db,
      { organizationId: organizationId() },
      (tx) =>
        tx
          .select({
            type: walletTransactions.type,
            amount: walletTransactions.usdcAmount,
            moveId: walletTransactions.treasuryMoveId,
            quoteId: walletTransactions.intentQuoteId,
            txHash: walletTransactions.txHash,
            chain: walletTransactions.chain,
            id: walletTransactions.id,
          })
          .from(walletTransactions),
    );
    const entry = (await auditFor(rows[0]?.id ?? "")).map((row) => ({
      action: row.action,
      treasuryMoveId: row.after?.treasuryMoveId,
      treasuryQuoteId: row.after?.treasuryQuoteId,
      source: row.after?.source,
    }));
    expect({
      outcome,
      rows: rows.map(({ id: _id, ...row }) => row),
      credited: (await quoteNow(quote)).ledgerCreditedAt !== null,
      entry,
    }).toEqual({
      outcome: "credited",
      rows: [
        {
          type: "from_treasury",
          amount: 4_990_000n,
          moveId: move.id,
          quoteId: quote.id,
          txHash: null,
          chain: "near",
        },
      ],
      credited: true,
      entry: [
        {
          action: "wallet.treasury_returned",
          treasuryMoveId: move.id,
          treasuryQuoteId: quote.id,
          source: "one_click_success",
        },
      ],
    });
  });

  it("credits once however often it runs, and once when two runs credit it together", async () => {
    // #given
    const { quote } = await openReturn();

    // #when
    const outcomes = await Promise.all([creditOne(quote), creditOne(quote)]);
    const later = await creditOne(quote);
    await creditAll();

    // #then
    expect(outcomes.filter((outcome) => outcome === "credited")).toHaveLength(
      1,
    );
    expect(later).toBe("already_credited");
    expect(await ledgerOf(db, funded)).toHaveLength(1);
  });

  it("credits what 1Click reports, never more than was deposited", async () => {
    // #given a return 1Click reports as delivering more than was deposited
    const { quote } = await openReturn({ delivered: 5_000_001n });

    // #when
    const outcome = await creditOne(quote);

    // #then nothing is credited and it stays due
    expect({ outcome, ledger: await ledgerOf(db, funded) }).toEqual({
      outcome: "amount_unusable",
      ledger: [],
    });
    await settleOpenQuotes(db, funded);
  });

  it("leaves a return that delivered to the company wallet to the deposit watcher", async () => {
    // #given a return opened before the company was switched
    const { quote } = await openReturn({ confidential: false });

    // #when
    const outcome = await creditOne(quote);
    await creditAll();

    // #then
    expect({ outcome, ledger: await ledgerOf(db, funded) }).toEqual({
      outcome: "not_creditable",
      ledger: [],
    });
  });
});

describe("creditSettledQuotes, for a quote that is not a delivery into the account", () => {
  const settled = {
    status: "succeeded",
    oneClickStatus: "SUCCESS",
    settledAt: new Date(),
    depositedAmount: 5_000_000n,
    swappedAmountOut: 4_990_000n,
  } as const;

  it("never credits a sweep, even one delivering into the account", async () => {
    // #given a settled sweep into the confidential account
    const sweep = await saveQuote(runtime, db, funded, "sweep", {
      row: { ...settled, recipientType: "CONFIDENTIAL_INTENTS" },
    });

    // #when
    const outcome = await creditOne(sweep);
    await creditAll();

    // #then
    expect({
      outcome,
      credited: (await quoteNow(sweep)).ledgerCreditedAt,
      ledger: await ledgerOf(db, funded),
    }).toEqual({ outcome: "not_creditable", credited: null, ledger: [] });
  });

  it.each([
    ["succeeded", settled],
    [
      "refunded",
      {
        status: "refunded",
        oneClickStatus: "REFUNDED",
        settledAt: new Date(),
        refundedAmount: 5_000_000n,
      },
    ],
  ] as const)(
    "never credits a Treasury part paid from the account that %s: its own debit and refund are written by the move",
    async (_outcome, row) => {
      // #given
      const move = await saveTreasuryMove(db, funded);
      const part = await saveQuote(runtime, db, funded, "to_treasury", {
        intentPaid: true,
        row: { ...row, treasuryMoveId: move.id },
      });

      // #when
      const outcome = await creditOne(part);
      await creditAll();

      // #then
      expect({ outcome, ledger: await ledgerOf(db, funded) }).toEqual({
        outcome: "not_creditable",
        ledger: [],
      });
    },
  );
});
