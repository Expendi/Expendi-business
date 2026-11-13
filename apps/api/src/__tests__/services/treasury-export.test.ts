import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { strFromU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import {
  intentQuotes,
  treasuryEarnActions,
  treasuryMoves,
  treasurySnapshots,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { renderExport } from "../../services/export/render.js";
import { ONE_CLICK_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import { createActiveNearWallet, createCompany } from "../helpers/db.js";
import { asAdmin, parseCsv, unzip } from "../helpers/exports.js";
import { randomNearAccount, randomNearTxHash } from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

const USDC = 1_000_000n;
const baseAddress = () => `0x${randomBytes(20).toString("hex")}`;
const baseTxHash = () => `0x${randomBytes(32).toString("hex")}`;

interface Fixture {
  readonly company: TestCompany;
  readonly wallet: TestWallet;
}

/** A company whose wallet turned Treasury on at `turnedOnAt`, or never. */
async function company(turnedOnAt: Date | null): Promise<Fixture> {
  const created = await createCompany(db);
  const wallet = await createActiveNearWallet(db, created, {
    privyWalletId: `near-wallet-${randomUUID()}`,
    accountId: randomNearAccount(),
  });
  if (turnedOnAt) {
    await runInScope(db, asAdmin(created), (tx) =>
      tx
        .update(wallets)
        .set({
          treasuryPrivyWalletId: `treasury-${randomUUID()}`,
          treasuryAddress: baseAddress(),
          treasuryPrivyPolicyId: `policy-${randomUUID()}`,
          treasuryTurnedOnAt: turnedOnAt,
          treasuryTurnedOnBy: created.admin.id,
        })
        .where(eq(wallets.id, wallet.id)),
    );
  }
  return { company: created, wallet };
}

const scopeOf = (fixture: Fixture) => asAdmin(fixture.company);

const snapshot = (fixture: Fixture, day: string, assets: bigint) =>
  runInScope(db, scopeOf(fixture), (tx) =>
    tx.insert(treasurySnapshots).values({
      organizationId: fixture.company.organizationId,
      snapshotDate: day,
      assetsInVault: assets,
      sharesInVault: assets,
      readAt: new Date(`${day}T00:05:00+03:00`),
    }),
  );

interface MoveOptions {
  readonly direction: "to_treasury" | "to_wallet";
  readonly settledAt: string;
  readonly status?: "completed" | "returned" | "failed";
  /** to_treasury: what the company wallet sent. to_wallet: what the vault gave up. */
  readonly left: bigint;
  readonly arrived: bigint;
}

/** One settled move with the rows its two directions leave: quotes, ledger and Earn calls. */
async function settledMove(fixture: Fixture, options: MoveOptions) {
  const { organizationId } = fixture.company;
  const toTreasury = options.direction === "to_treasury";
  return runInScope(db, scopeOf(fixture), async (tx) => {
    const [move] = await tx
      .insert(treasuryMoves)
      .values({
        organizationId,
        walletId: fixture.wallet.id,
        direction: options.direction,
        requestedUsdc: options.left,
        status: options.status ?? "completed",
        movedUsdc: options.arrived,
        costUsdc: options.left - options.arrived,
        confirmedBy: fixture.company.admin.id,
        approvalId: randomUUID(),
        settledAt: new Date(options.settledAt),
      })
      .returning();
    if (!move) throw new Error("move insert returned no row");
    const [quote] = await tx
      .insert(intentQuotes)
      .values({
        organizationId,
        walletId: fixture.wallet.id,
        quoteKey: `${options.direction}:${randomUUID()}`,
        purpose: toTreasury ? "to_treasury" : "from_treasury",
        status: "succeeded",
        swapType: "EXACT_INPUT",
        originAsset: toTreasury
          ? ONE_CLICK_USDC_ASSET_IDS.near
          : ONE_CLICK_USDC_ASSET_IDS.base,
        destinationAsset: toTreasury
          ? ONE_CLICK_USDC_ASSET_IDS.base
          : ONE_CLICK_USDC_ASSET_IDS.near,
        amountIn: options.left,
        amountOut: options.arrived,
        depositAddress: toTreasury ? baseAddress() : randomNearAccount(),
        recipient: baseAddress(),
        refundTo: baseAddress(),
        deadline: new Date(options.settledAt),
        quoteResponse: {},
        treasuryMoveId: move.id,
        depositTxHash: toTreasury ? randomNearTxHash() : baseTxHash(),
        settledAt: new Date(options.settledAt),
      })
      .returning();
    if (!quote) throw new Error("quote insert returned no row");
    const nearTx = randomNearTxHash();
    const earnTx = baseTxHash();
    await tx.insert(walletTransactions).values(
      toTreasury
        ? {
            organizationId,
            walletId: fixture.wallet.id,
            type: "to_treasury",
            chain: "near",
            usdcAmount: -options.left,
            txHash: nearTx,
            treasuryMoveId: move.id,
            intentQuoteId: quote.id,
          }
        : {
            organizationId,
            walletId: fixture.wallet.id,
            type: "from_treasury",
            chain: "near",
            usdcAmount: options.arrived,
            txHash: nearTx,
            treasuryMoveId: move.id,
            intentQuoteId: quote.id,
          },
    );
    await tx.insert(treasuryEarnActions).values({
      organizationId,
      treasuryMoveId: move.id,
      intentQuoteId: toTreasury ? quote.id : null,
      kind: toTreasury ? "deposit" : "withdraw",
      referenceId: `tr-${randomUUID()}`.slice(0, 40),
      rawAmount: toTreasury ? options.arrived : options.left,
      deliveredUsdc: toTreasury ? null : options.left,
      privyActionId: `action-${randomUUID()}`,
      status: "succeeded",
      txHash: earnTx,
      settledAt: new Date(options.settledAt),
    });
    return {
      move,
      references: [nearTx, earnTx, quote.depositTxHash ?? ""],
    };
  });
}

const OCTOBER = "2026-10";

async function october(fixture: Fixture) {
  const rendered = await runtime.runPromise(
    renderExport(scopeOf(fixture), OCTOBER),
  );
  const csvs = unzip(rendered.csv);
  const read = (name: string) => {
    const bytes = csvs[name];
    return bytes ? parseCsv(bytes) : undefined;
  };
  return {
    rendered,
    files: Object.keys(csvs).sort(),
    summary: read("treasury.csv"),
    moves: read("treasury-moves.csv"),
  };
}

/** A company with Treasury on since September and a month of figures. */
async function treasuryOctober() {
  const fixture = await company(new Date("2026-09-01T09:00:00Z"));
  await snapshot(fixture, "2026-09-30", 90n * USDC);
  await snapshot(fixture, "2026-10-01", 100n * USDC);
  await snapshot(fixture, "2026-10-15", 130n * USDC);
  await snapshot(fixture, "2026-10-31", 160n * USDC);
  await snapshot(fixture, "2026-11-01", 999n * USDC);
  const toTreasury = await settledMove(fixture, {
    direction: "to_treasury",
    settledAt: "2026-10-10T09:00:00Z",
    left: 50n * USDC,
    arrived: 49_995_000n,
  });
  const toWallet = await settledMove(fixture, {
    direction: "to_wallet",
    settledAt: "2026-10-20T09:00:00Z",
    left: 20n * USDC,
    arrived: 19_996_000n,
  });
  return { fixture, toTreasury, toWallet };
}

describe("the export's Treasury section", () => {
  it("shows the month's value from the snapshots on or before its first and last day, with the yield and cost", async () => {
    // #given
    const { fixture } = await treasuryOctober();

    // #when
    const { summary } = await october(fixture);

    // #then closing 160, opening 100, in 49.995, out 20: yield 160 - 100 - 29.995
    expect(summary).toEqual([
      [
        "Value at the start (USD)",
        "Start value read on",
        "Value at the end (USD)",
        "End value read on",
        "Moved to Treasury (USD)",
        "Moved to wallet (USD)",
        "Yield for the month (USD)",
        "Cost of moves (USD)",
      ],
      [
        "100.00",
        "2026-10-01",
        "160.00",
        "2026-10-31",
        "49.995",
        "20.00",
        "30.005",
        "0.009",
      ],
    ]);
  });

  it("lists each move that ended in the month with what left, what arrived, its cost and its transactions", async () => {
    // #given
    const { fixture, toTreasury, toWallet } = await treasuryOctober();
    await settledMove(fixture, {
      direction: "to_treasury",
      settledAt: "2026-11-02T09:00:00Z",
      left: 5n * USDC,
      arrived: 5n * USDC,
    });
    await settledMove(fixture, {
      direction: "to_treasury",
      status: "failed",
      settledAt: "2026-10-12T09:00:00Z",
      left: USDC,
      arrived: USDC,
    });

    // #when
    const { moves } = await october(fixture);

    // #then
    expect(moves?.slice(1)).toEqual([
      [
        "2026-10-10",
        "To Treasury",
        "50.00",
        "49.995",
        "0.005",
        [...toTreasury.references].filter(Boolean).join("; "),
      ],
      [
        "2026-10-20",
        "To wallet",
        "20.00",
        "19.996",
        "0.004",
        [...toWallet.references].filter(Boolean).join("; "),
      ],
    ]);
  });

  it("puts the same figures in the workbook as two more sheets", async () => {
    // #given
    const { fixture } = await treasuryOctober();

    // #when
    const { rendered } = await october(fixture);

    // #then
    const workbook = strFromU8(
      unzip(rendered.workbook)["xl/workbook.xml"] ?? new Uint8Array(),
    );
    expect(
      [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]),
    ).toEqual([
      "Money out",
      "Outstanding bills",
      "Float transfers",
      "Treasury",
      "Treasury moves",
    ]);
  });

  it("says there is no snapshot, rather than guessing, when the month's start or end has none", async () => {
    // #given Treasury on since September, snapshots only from mid-October
    const fixture = await company(new Date("2026-09-01T09:00:00Z"));
    await snapshot(fixture, "2026-10-15", 130n * USDC);

    // #when
    const { summary } = await october(fixture);

    // #then the end is the 15th's, the start and so the yield are missing
    expect(summary?.[1]).toEqual([
      "No snapshot",
      "",
      "130.00",
      "2026-10-15",
      "0.00",
      "0.00",
      "No snapshot",
      "0.00",
    ]);
  });

  it("has no yield when the end of the month has no snapshot", async () => {
    // #given
    const fixture = await company(new Date("2026-09-01T09:00:00Z"));
    await snapshot(fixture, "2026-10-01", 100n * USDC);
    await snapshot(fixture, "2026-11-01", 120n * USDC);

    // #when
    const { summary } = await october(fixture);

    // #then the later snapshot is not the end of October
    expect(summary?.[1]).toEqual([
      "100.00",
      "2026-10-01",
      "100.00",
      "2026-10-01",
      "0.00",
      "0.00",
      "0.00",
      "0.00",
    ]);
  });

  it("starts at nothing when Treasury was turned on after the month began", async () => {
    // #given
    const fixture = await company(new Date("2026-10-12T09:00:00Z"));
    await snapshot(fixture, "2026-10-31", 50n * USDC);
    await settledMove(fixture, {
      direction: "to_treasury",
      settledAt: "2026-10-12T10:00:00Z",
      left: 50n * USDC,
      arrived: 50n * USDC,
    });

    // #when
    const { summary } = await october(fixture);

    // #then
    expect(summary?.[1]).toEqual([
      "0.00",
      "Treasury was turned on after this date",
      "50.00",
      "2026-10-31",
      "50.00",
      "0.00",
      "0.00",
      "0.00",
    ]);
  });

  it("adds no section for a company without Treasury, or one that turns it on later", async () => {
    // #given
    const without = await company(null);
    const later = await company(new Date("2026-11-03T09:00:00Z"));

    // #when
    const exports = await Promise.all([october(without), october(later)]);

    // #then
    expect(
      exports.map(({ files, summary, moves }) => ({ files, summary, moves })),
    ).toEqual(
      [0, 1].map(() => ({
        files: [
          "float-transfers.csv",
          "money-out.csv",
          "outstanding-bills.csv",
        ],
        summary: undefined,
        moves: undefined,
      })),
    );
  });
});
