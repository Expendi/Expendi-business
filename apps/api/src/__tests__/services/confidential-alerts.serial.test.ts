import { eq } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote, NewIntentQuote } from "../../db/schema/index.js";
import type { WalletBalanceHome } from "../../db/schema/wallets.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { DatabaseService } from "../../db/client.js";
import { intentQuotes, wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { confidentialBalanceCheck } from "../../services/alerts/confidential-alert-checks.js";
import { applyCheck } from "../../services/alerts/ops-alerts.js";
import { runAlerts } from "../../services/alerts/run-alerts.js";
import { MOVE_IN_MIN_USDC } from "../../services/intents/confidential-account.js";
import { OneClick, OneClickRefused } from "../../services/intents/one-click.js";
import { reconcileBalances } from "../../services/wallet/reconcile.js";
import { randomTxHash } from "../helpers/chain.js";
import { createActiveNearWallet, createCompany } from "../helpers/db.js";
import { addLedgerRow, saveQuote } from "../helpers/money-in.js";
import { makeNearPayoutWorld } from "../helpers/near-payouts.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { USDC } from "../helpers/payouts.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The confidential balance alert looks across every company that keeps its
 * USDC in a confidential account, so it runs here, one file at a time.
 * Assertions are about the companies this file made.
 */

const fakeOneClick = makeFakeOneClick();
const accountOfSession = new Map<string, string>();
const unreadable = new Set<string>();
let duringConfidentialRead: (() => Promise<void>) | undefined;

const oneClickLayer = Layer.succeed(OneClick, {
  ...fakeOneClick.service,
  authenticate: (signed) =>
    fakeOneClick.service.authenticate(signed).pipe(
      Effect.tap(({ session }) =>
        Effect.sync(() => {
          const { signer_id: signerId } = JSON.parse(
            signed.payload.message,
          ) as { signer_id: string };
          accountOfSession.set(Redacted.value(session), signerId);
        }),
      ),
    ),
  balances: (session) =>
    Effect.promise(async () => duringConfidentialRead?.()).pipe(
      Effect.flatMap(() =>
        unreadable.has(accountOfSession.get(Redacted.value(session)) ?? "")
          ? Effect.fail(
              new OneClickRefused({
                message: "1Click refused balances: unavailable",
                httpStatus: 503,
              }),
            )
          : fakeOneClick.service.balances(session),
      ),
    ),
});

const world = makeNearPayoutWorld({ oneClick: oneClickLayer });
const { runtime, near, base, privy } = world;
let db: Database;
let owner: pg.Pool;
const made: Made[] = [];

interface Made extends FundedCompany {
  readonly privyWalletId: string;
}

const RESOLVE_OPEN_ALERTS =
  "UPDATE ops_alerts SET resolved_at = now() WHERE kind = 'confidential_balance_mismatch' AND resolved_at IS NULL";

const AGE_RESOLVED_ALERTS =
  "UPDATE ops_alerts SET resolved_at = now() - interval '30 days' WHERE kind = 'confidential_balance_mismatch' AND resolved_at IS NOT NULL";

const AGED = new Date(Date.now() - 60 * 60_000);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  await owner.query(RESOLVE_OPEN_ALERTS);
});

afterEach(async () => {
  near.state.failNext("usdcBalance", 0);
  base.state.failNextCalls(0);
  unreadable.clear();
  duringConfidentialRead = undefined;
  for (const company of made.splice(0)) {
    await runInScope(
      db,
      { organizationId: company.company.organizationId },
      (tx) =>
        tx
          .update(wallets)
          .set({ balanceHome: "company_wallet" })
          .where(eq(wallets.id, company.walletId)),
    );
  }
});

afterAll(async () => {
  await owner.query(RESOLVE_OPEN_ALERTS);
  // Staff's alerts list shows at most 200 from the last 7 days, and other
  // files' tests look for their own alerts in it. The ones made here would
  // crowd them out, so they are dated outside that window.
  await owner.query(AGE_RESOLVED_ALERTS);
  await Promise.all([runtime.dispose(), owner.end()]);
});

/**
 * A company whose ledger holds `ledger`, written an hour ago. `confidential`
 * and `wallet` are what the confidential account and the company wallet
 * actually hold; the transit wallet holds nothing.
 */
async function company(
  options: {
    readonly ledger?: bigint;
    readonly confidential?: bigint;
    readonly wallet?: bigint;
    readonly home?: WalletBalanceHome;
  } = {},
): Promise<Made> {
  const { ledger = 100n * USDC, confidential = ledger, wallet = 0n } = options;
  const created = await createCompany(db);
  const nearWallet = privy.state.addNearWallet();
  const row = await createActiveNearWallet(
    db,
    created,
    nearWallet,
    undefined,
    options.home ?? "confidential_account",
  );
  const [saved] = await runInScope(
    db,
    { organizationId: created.organizationId },
    (tx) => tx.select().from(wallets).where(eq(wallets.id, row.id)),
  );
  if (!saved?.transitAddress) throw new Error("wallet has no transit address");
  world.setBaseUsdc(saved.transitAddress, 0n);
  near.state.fundWithUsdc(nearWallet.accountId, wallet);
  fakeOneClick.state.confidentialBalances.set(
    nearWallet.accountId,
    confidential,
  );
  const funded = {
    company: created,
    walletId: row.id,
    accountId: nearWallet.accountId,
    transitAddress: saved.transitAddress,
    privyWalletId: nearWallet.privyWalletId,
  };
  await addLedgerRow(db, funded, {
    type: "deposit",
    usdcAmount: ledger,
    txHash: randomTxHash(),
    logIndex: 0,
    blockNumber: 1n,
    createdAt: AGED,
  });
  made.push(funded);
  return funded;
}

const heldInConfidential = (paying: Made, amount: bigint) =>
  fakeOneClick.state.confidentialBalances.set(paying.accountId, amount);
const heldInWallet = (paying: Made, amount: bigint) =>
  near.state.balances.set(paying.accountId, amount);

const check = (now?: Date) =>
  runtime.runPromise(
    confidentialBalanceCheck(now).pipe(Effect.flatMap(applyCheck)),
  );
const later = () => new Date(Date.now() + 10 * 60_000);

interface Incident {
  readonly title: string;
  readonly details: readonly { label: string; value: string }[];
  readonly resolved: boolean;
}

async function incidents(paying: Made): Promise<Incident[]> {
  const { rows } = await owner.query<{
    title: string;
    details: Incident["details"];
    resolved_at: Date | null;
  }>(
    "SELECT title, details, resolved_at FROM ops_alerts WHERE kind = 'confidential_balance_mismatch' AND subject_key = $1 ORDER BY opened_at, id",
    [paying.company.organizationId],
  );
  return rows.map((row) => ({
    title: row.title,
    details: row.details,
    resolved: row.resolved_at !== null,
  }));
}

/** [open, resolved] incident counts, so "opened once" and "resolved" read the same way. */
async function tally(paying: Made) {
  const all = await incidents(paying);
  return [
    all.filter((incident) => !incident.resolved).length,
    all.filter((incident) => incident.resolved).length,
  ];
}

const detail = (incident: Incident | undefined, label: string) =>
  incident?.details.find((line) => line.label === label)?.value;

const savedReading = async (paying: Made) => {
  const [row] = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select({
          usdc: wallets.confidentialUsdc,
          readAt: wallets.confidentialUsdcReadAt,
        })
        .from(wallets)
        .where(eq(wallets.id, paying.walletId)),
  );
  return row;
};

function quote(
  paying: Made,
  purpose: Parameters<typeof saveQuote>[3],
  options: { confidential?: boolean; row?: Partial<NewIntentQuote> } = {},
): Promise<IntentQuote> {
  return saveQuote(runtime, db, paying, purpose, options);
}

/** Ends a quote the way 1Click does when nothing is left to move. */
const settle = (paying: Made, saved: IntentQuote) =>
  runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
    tx
      .update(intentQuotes)
      .set({ status: "failed", settledAt: AGED })
      .where(eq(intentQuotes.id, saved.id)),
  );

describe("the ledger against what the company holds", () => {
  it("opens nothing when they agree", async () => {
    // #given
    const paying = await company();

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);
  });

  it("opens once when the company holds less than the ledger, listing the four figures", async () => {
    // #given
    const paying = await company({ wallet: 5n * USDC });
    heldInConfidential(paying, 90n * USDC);

    // #when
    await check();
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
    const [incident] = await incidents(paying);
    expect(incident?.title).toContain(paying.company.name);
    expect({
      ledger: detail(incident, "Ledger"),
      wallet: detail(incident, "Company wallet"),
      transit: detail(incident, "Transit wallet"),
      confidential: detail(incident, "Confidential account"),
    }).toEqual({
      ledger: "100 USDC",
      wallet: "5 USDC",
      transit: "0 USDC",
      confidential: "90 USDC",
    });
  });

  it("resolves once the figures agree again", async () => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);
    await check();

    // #when
    heldInConfidential(paying, 100n * USDC);
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 1]);
  });

  it("opens when USDC sits in the confidential account that no quote credited", async () => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 107n * USDC);

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
  });

  it("counts Expendi's recorded surplus as explained, and only up to the surplus", async () => {
    // #given
    const paying = await company();
    await quote(paying, "base_hop", {
      row: {
        status: "succeeded",
        settledAt: AGED,
        depositStartedAt: AGED,
        feeCoverUsdc: 300_000n,
        swappedAmountIn: 5_000_000n,
        amountIn: 5_000_000n,
        minAmountIn: 5_000_000n,
        amountOut: 5_000_000n,
      },
    });
    heldInConfidential(paying, 100n * USDC + 300_000n);

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);

    // #when
    heldInConfidential(paying, 100n * USDC + 300_001n);
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
  });

  it("stays quiet about an excess in the company wallet that is waiting to be moved in", async () => {
    // #given
    const paying = await company({ wallet: MOVE_IN_MIN_USDC + 1n });

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);
  });

  it("opens for an excess in the company wallet too small to be moved in", async () => {
    // #given
    const paying = await company({ wallet: MOVE_IN_MIN_USDC });

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
  });

  it("resolves when the excess in the company wallet is moved in and credited", async () => {
    // #given
    const paying = await company({ wallet: MOVE_IN_MIN_USDC });
    await check();

    // #when
    heldInWallet(paying, 0n);
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 1]);
  });
});

describe("what keeps the alert as it is", () => {
  const BLOCKERS: readonly {
    readonly name: string;
    readonly block: (paying: Made) => Promise<IntentQuote>;
  }[] = [
    {
      name: "a move-in that is depositing",
      block: (paying) =>
        quote(paying, "move_in", { row: { status: "depositing" } }),
    },
    {
      name: "a move-in that needs review",
      block: (paying) =>
        quote(paying, "move_in", { row: { status: "needs_review" } }),
    },
    {
      name: "a delivery to the confidential account that is depositing",
      block: (paying) =>
        quote(paying, "fund_in_return", {
          confidential: true,
          row: { status: "depositing" },
        }),
    },
    {
      name: "a delivery to the confidential account that needs review",
      block: (paying) =>
        quote(paying, "fund_in_return", {
          confidential: true,
          row: { status: "needs_review" },
        }),
    },
    {
      name: "a delivery that succeeded and isn't credited yet",
      block: (paying) =>
        quote(paying, "fund_in_return", {
          confidential: true,
          row: { status: "succeeded", settledAt: minutesAgo(7) },
        }),
    },
    {
      name: "a quoted delivery 1Click was never asked about",
      block: (paying) =>
        quote(paying, "fund_in_return", { confidential: true }),
    },
    {
      name: "a quoted delivery last checked 3 minutes ago",
      block: (paying) =>
        quote(paying, "fund_in_return", {
          confidential: true,
          row: {
            oneClickStatus: "PENDING_DEPOSIT",
            oneClickCheckedAt: minutesAgo(3),
          },
        }),
    },
    {
      name: "a quoted delivery 1Click has seen a deposit for",
      block: (paying) =>
        quote(paying, "fund_in_return", {
          confidential: true,
          row: {
            oneClickStatus: "KNOWN_DEPOSIT_TX",
            oneClickCheckedAt: new Date(),
          },
        }),
    },
    {
      name: "a Base hop that is depositing",
      block: (paying) =>
        quote(paying, "base_hop", { row: { status: "depositing" } }),
    },
    {
      name: "a fee cover that is depositing",
      block: (paying) =>
        quote(paying, "fee_cover", { row: { status: "depositing" } }),
    },
    {
      name: "a fee cover that needs review",
      block: (paying) =>
        quote(paying, "fee_cover", { row: { status: "needs_review" } }),
    },
    ...(["depositing", "needs_review"] as const).flatMap((status) =>
      (["base_hop", "usdc_payout"] as const).map((purpose) => ({
        name: `a ${purpose} paid out of the confidential account that is ${status}`,
        block: (paying: Made) =>
          saveQuote(runtime, db, paying, purpose, {
            intentPaid: true,
            row: { status, depositStartedAt: new Date() },
          }),
      })),
    ),
  ];

  it.each(BLOCKERS)("$name: neither raises nor clears", async ({ block }) => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);
    const first = await block(paying);

    // #when it would fire, but money is in flight
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);

    // #when the money has landed
    await settle(paying, first);
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);

    // #when the figures agree again, but money is in flight again
    heldInConfidential(paying, 100n * USDC);
    const second = await block(paying);
    await check();

    // #then the alert is not cleared
    expect(await tally(paying)).toEqual([1, 0]);

    // #when
    await settle(paying, second);
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 1]);
  });

  it("does not count a quoted delivery that 1Click said was waiting for its deposit a minute ago", async () => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);
    await quote(paying, "fund_in_return", {
      confidential: true,
      row: {
        oneClickStatus: "PENDING_DEPOSIT",
        oneClickCheckedAt: minutesAgo(1),
      },
    });

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
  });

  it("does not count a move-in that has only been quoted", async () => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);
    await quote(paying, "move_in");

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
  });

  it("waits 5 minutes after a ledger row is written", async () => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);
    await addLedgerRow(db, paying, {
      type: "deposit",
      usdcAmount: 1n,
      txHash: randomTxHash(),
      logIndex: 0,
      blockNumber: 2n,
    });

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);

    // #when
    await check(later());

    // #then
    expect(await tally(paying)).toEqual([1, 0]);

    // #when the figures agree, but a row was written moments ago
    heldInConfidential(paying, 100n * USDC + 1n);
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);

    // #when
    await check(later());

    // #then
    expect(await tally(paying)).toEqual([0, 1]);
  });

  it("waits 5 minutes after a quote settles", async () => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);
    await quote(paying, "fund_in_return", {
      confidential: true,
      row: {
        status: "succeeded",
        settledAt: new Date(),
        ledgerCreditedAt: new Date(),
      },
    });

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);

    // #when
    await check(later());

    // #then
    expect(await tally(paying)).toEqual([1, 0]);

    // #when the figures agree, but the quote settled moments ago
    heldInConfidential(paying, 100n * USDC);
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);

    // #when
    await check(later());

    // #then
    expect(await tally(paying)).toEqual([0, 1]);
  });

  it.each([
    [
      "the company wallet's NEAR balance",
      () => near.state.failNext("usdcBalance", 1_000),
    ],
    [
      "the transit wallet's Base balance",
      () => base.state.failNextCalls(1_000),
    ],
    [
      "the confidential account's balance",
      (paying: Made) => unreadable.add(paying.accountId),
    ],
  ])("cannot be read: %s", async (_name, breakIt) => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);

    // #when it would fire, but a balance can't be read
    breakIt(paying);
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);

    // #when it can be read again
    unreadable.clear();
    near.state.failNext("usdcBalance", 0);
    base.state.failNextCalls(0);
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);

    // #when the figures agree, but a balance can't be read
    heldInConfidential(paying, 100n * USDC);
    breakIt(paying);
    await check();

    // #then the alert is not cleared
    expect(await tally(paying)).toEqual([1, 0]);

    // #when
    unreadable.clear();
    near.state.failNext("usdcBalance", 0);
    base.state.failNextCalls(0);
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 1]);
  });
});

describe("the reading saved for staff", () => {
  it("is saved on the wallet row each time the account is read, whether or not it fires", async () => {
    // #given
    const paying = await company({ confidential: 42n * USDC });
    expect(await savedReading(paying)).toEqual({ usdc: null, readAt: null });

    // #when
    await check();

    // #then
    const first = await savedReading(paying);
    expect(first?.usdc).toBe(42n * USDC);
    expect(Date.now() - (first?.readAt?.getTime() ?? 0)).toBeLessThan(60_000);

    // #when
    heldInConfidential(paying, 43n * USDC);
    await check();

    // #then
    const second = await savedReading(paying);
    expect(second?.usdc).toBe(43n * USDC);
  });

  it("is saved while money is in flight, and kept when the account can't be read", async () => {
    // #given
    const paying = await company({ confidential: 42n * USDC });
    await quote(paying, "move_in", { row: { status: "depositing" } });

    // #when
    await check();

    // #then
    expect((await savedReading(paying))?.usdc).toBe(42n * USDC);

    // #when
    heldInConfidential(paying, 50n * USDC);
    unreadable.add(paying.accountId);
    await check();

    // #then
    expect((await savedReading(paying))?.usdc).toBe(42n * USDC);
  });

  it("is saved when the alerts job runs, which includes this check", async () => {
    // #given
    const paying = await company({ confidential: 77n * USDC });
    heldInConfidential(paying, 70n * USDC);

    // #when
    await runtime.runPromise(runAlerts());

    // #then
    expect((await savedReading(paying))?.usdc).toBe(70n * USDC);
    expect(await tally(paying)).toEqual([1, 0]);
  });
});

describe("Expendi's float in the confidential account", () => {
  /** USDC of Expendi's own delivered into the account by a settled fee cover. */
  const floatOf = (paying: Made, amount: bigint) =>
    quote(paying, "fee_cover", {
      row: {
        status: "succeeded",
        settledAt: AGED,
        depositStartedAt: AGED,
        swappedAmountOut: amount,
      },
    });

  it("explains the difference it causes, and only up to the float", async () => {
    // #given the account holds the company's 100 USDC and Expendi's 1
    const paying = await company();
    await floatOf(paying, 1n * USDC);
    heldInConfidential(paying, 101n * USDC);

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);
    const reading = await runtime.runPromise(
      reconcileBalances(paying.company.organizationId),
    );
    expect(reading).toMatchObject({
      differenceUsdc: 1n * USDC,
      expendiSurplusUsdc: 1n * USDC,
      companyWalletSurplusUsdc: 0n,
    });

    // #when one unit more than the float explains
    heldInConfidential(paying, 101n * USDC + 1n);
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
  });

  it("reports both pools in the reconcile, the public one apart", async () => {
    // #given a float, and what a hop left in the company wallet
    const paying = await company();
    await floatOf(paying, 1n * USDC);
    await quote(paying, "base_hop", {
      row: {
        status: "succeeded",
        settledAt: AGED,
        depositStartedAt: AGED,
        feeCoverUsdc: 300_000n,
        swappedAmountIn: 5_000_000n,
        amountIn: 5_000_000n,
        minAmountIn: 5_000_000n,
        amountOut: 5_000_000n,
      },
    });

    // #when
    const reading = await runtime.runPromise(
      reconcileBalances(paying.company.organizationId),
    );

    // #then
    expect(reading).toMatchObject({
      expendiSurplusUsdc: 1n * USDC + 300_000n,
      companyWalletSurplusUsdc: 300_000n,
    });
  });

  it("is spent by a sweep's cost without the alert firing", async () => {
    // #given a sweep delivered 5 USDC less 0.001 into the account
    const paying = await company();
    await floatOf(paying, 1n * USDC);
    await quote(paying, "sweep", {
      row: {
        recipientType: "CONFIDENTIAL_INTENTS",
        status: "succeeded",
        settledAt: AGED,
        swappedAmountOut: 5n * USDC - 1_000n,
      },
    });
    heldInConfidential(paying, 101n * USDC - 1_000n);

    // #when
    await check();

    // #then the float is 0.999 and the account holds exactly that above the ledger
    expect(await tally(paying)).toEqual([0, 0]);
    expect(
      await runtime.runPromise(
        reconcileBalances(paying.company.organizationId),
      ),
    ).toMatchObject({
      differenceUsdc: 1n * USDC - 1_000n,
      expendiSurplusUsdc: 1n * USDC - 1_000n,
    });
  });

  it("still fires for a shortfall the float doesn't cover", async () => {
    // #given the account is 2 USDC short of the ledger plus the float
    const paying = await company();
    await floatOf(paying, 1n * USDC);
    heldInConfidential(paying, 99n * USDC);

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
  });

  it("shows a sweep's cost as a shortfall when there is no float to absorb it", async () => {
    // #given
    const paying = await company();
    await quote(paying, "sweep", {
      row: {
        recipientType: "CONFIDENTIAL_INTENTS",
        status: "succeeded",
        settledAt: AGED,
        swappedAmountOut: 5n * USDC - 1_000n,
      },
    });
    heldInConfidential(paying, 100n * USDC - 1_000n);

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
  });

  it("is not counted as the company wallet's own surplus when judging what waits there to be moved in", async () => {
    // #given 1 USDC of float, and a company wallet holding more than the
    // move-in minimum above it: only the company wallet's own surplus (none)
    // is set against what waits there
    const paying = await company({ wallet: 1n * USDC + MOVE_IN_MIN_USDC });
    await floatOf(paying, 1n * USDC);
    heldInConfidential(paying, 100n * USDC);

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);
  });

  it("doesn't count a hop paid out of the account that is only quoted as money in flight", async () => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);
    const hop = await saveQuote(runtime, db, paying, "base_hop", {
      intentPaid: true,
    });

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
    await settle(paying, hop);
  });
});

describe("a company that keeps its USDC in the company wallet", () => {
  it("costs no sign-in and no read of a confidential account, in the job or in a reconcile", async () => {
    // #given
    const paying = await company({
      home: "company_wallet",
      ledger: 100n * USDC,
      wallet: 90n * USDC,
    });

    // #when
    await runtime.runPromise(runAlerts());
    const reconciled = await runtime.runPromise(
      reconcileBalances(paying.company.organizationId),
    );

    // #then
    expect(fakeOneClick.state.signIns).not.toContain(paying.accountId);
    expect(privy.state.nearSigningRequestsFor(paying.privyWalletId)).toBe(0);
    expect(reconciled).toMatchObject({
      balanceHome: "company_wallet",
      confidentialUsdc: null,
      differenceUsdc: -10n * USDC,
    });
    expect(await tally(paying)).toEqual([0, 0]);
    expect(await savedReading(paying)).toEqual({ usdc: null, readAt: null });
  });

  it("reads the confidential account of one that has it, and signs in for it", async () => {
    // #given
    const paying = await company({
      confidential: 60n * USDC,
      wallet: 5n * USDC,
    });

    // #when
    const reconciled = await runtime.runPromise(
      reconcileBalances(paying.company.organizationId),
    );

    // #then
    expect(fakeOneClick.state.signIns).toContain(paying.accountId);
    expect(reconciled).toMatchObject({
      balanceHome: "confidential_account",
      nearUsdc: 5n * USDC,
      baseUsdc: 0n,
      confidentialUsdc: 60n * USDC,
      ledgerUsdc: 100n * USDC,
      differenceUsdc: -35n * USDC,
    });
  });
});

describe("a delivery that is never credited", () => {
  const delivered = (
    paying: Made,
    minutes: number,
    purpose = "fund_in_return",
  ) =>
    quote(paying, purpose as "fund_in_return", {
      confidential: true,
      row: { status: "succeeded", settledAt: minutesAgo(minutes) },
    });
  const credit = (paying: Made, saved: IntentQuote) =>
    runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
      tx
        .update(intentQuotes)
        .set({ ledgerCreditedAt: new Date() })
        .where(eq(intentQuotes.id, saved.id)),
    );

  it("is in flight for 10 minutes after it settled", async () => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);
    await delivered(paying, 7);

    // #when
    await check();
    const reading = await runtime.runPromise(
      reconcileBalances(paying.company.organizationId),
    );

    // #then
    expect(await tally(paying)).toEqual([0, 0]);
    expect(reading?.inFlight).toHaveLength(1);
    expect(reading?.overdueCredits).toEqual([]);
  });

  it("fires after 10 minutes with the quote IDs, whatever the difference", async () => {
    // #given
    const paying = await company();
    const late = await delivered(paying, 11);

    // #when
    await check();
    const reading = await runtime.runPromise(
      reconcileBalances(paying.company.organizationId),
    );

    // #then
    expect(await tally(paying)).toEqual([1, 0]);
    const [incident] = await incidents(paying);
    expect(detail(incident, "Delivered but not credited")).toContain(late.id);
    expect(reading?.inFlight).toEqual([]);
    expect(reading?.overdueCredits).toEqual([late.id]);
  });

  it("fires even when a ledger row was written in the last 5 minutes", async () => {
    // #given
    const paying = await company();
    const late = await delivered(paying, 11);
    await addLedgerRow(db, paying, {
      type: "deposit",
      usdcAmount: 1n,
      txHash: randomTxHash(),
      logIndex: 0,
      blockNumber: 2n,
    });
    heldInConfidential(paying, 100n * USDC + 1n);

    // #when
    await check();

    // #then
    const [incident] = await incidents(paying);
    expect(await tally(paying)).toEqual([1, 0]);
    expect(detail(incident, "Delivered but not credited")).toContain(late.id);
  });

  it("clears once the quote is credited", async () => {
    // #given
    const paying = await company();
    const late = await delivered(paying, 11);
    await check();

    // #when
    await credit(paying, late);
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 1]);
  });

  it("is never counted for a succeeded move-in", async () => {
    // #given
    const paying = await company();
    await quote(paying, "move_in", {
      row: { status: "succeeded", settledAt: minutesAgo(11) },
    });
    const reading = await runtime.runPromise(
      reconcileBalances(paying.company.organizationId),
    );

    // #when
    await check();

    // #then
    expect(reading?.overdueCredits).toEqual([]);
    expect(reading?.inFlight).toEqual([]);
    expect(await tally(paying)).toEqual([0, 0]);
  });
});

describe("the order of the reads", () => {
  it("keeps the alert when a move-in starts while the balances are being read", async () => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);
    duringConfidentialRead = async () => {
      duringConfidentialRead = undefined;
      await quote(paying, "move_in", { row: { status: "depositing" } });
    };

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);
  });

  it("keeps the alert when a ledger row is written while the balances are being read", async () => {
    // #given
    const paying = await company();
    heldInConfidential(paying, 90n * USDC);
    duringConfidentialRead = async () => {
      duringConfidentialRead = undefined;
      await addLedgerRow(db, paying, {
        type: "deposit",
        usdcAmount: 1n,
        txHash: randomTxHash(),
        logIndex: 0,
        blockNumber: 2n,
      });
    };

    // #when
    await check();

    // #then
    expect(await tally(paying)).toEqual([0, 0]);
  });
});
