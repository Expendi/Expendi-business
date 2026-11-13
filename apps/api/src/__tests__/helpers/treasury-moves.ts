import { eq } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import type {
  IntentQuote,
  TreasuryEarnAction,
  TreasuryMove,
} from "../../db/schema/index.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { TransferLogInput } from "./chain.js";
import type { NearPayingCompany, NearPayoutWorld } from "./near-payouts.js";
import {
  treasuryEarnActions,
  treasuryMoves,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { advanceTreasuryMove } from "../../services/treasury/advance.js";
import {
  startMoveConfirmation,
  startTreasuryMove,
} from "../../services/treasury/moves.js";
import { turnOnTreasury } from "../../services/treasury/turn-on.js";
import { randomTxHash, transferReceipt } from "./chain.js";
import { TEST_ORIGIN } from "./fakes.js";
import { createNearPayingCompany, readQuotes } from "./near-payouts.js";
import { randomNearTxHash } from "./near.js";

export const VAULT_ID = "ry2qt6co7rkpwkr5mqudloo4";
export const USDC = 1_000_000n;

export interface TreasuryCompany extends NearPayingCompany {
  readonly tenant: Tenant;
  readonly treasuryAddress: string;
  readonly treasuryPrivyWalletId: string;
}

/**
 * A company on NEAR with Treasury turned on, and the fake Privy wired to
 * the fake Base chain: a vault deposit takes its USDC out of the Treasury
 * wallet's balance, as the real one does.
 */
export async function createTreasuryCompany(
  world: NearPayoutWorld,
  db: Database,
  options: {
    readonly balance?: bigint;
    readonly perTransactionMaxUsdc?: bigint;
  } = {},
): Promise<TreasuryCompany> {
  const paying = await createNearPayingCompany(world, db, options);
  const { organizationId } = paying.company;
  await world.runtime.runPromise(
    turnOnTreasury({
      organizationId,
      actor: { type: "user", id: paying.company.admin.id },
    }),
  );
  const [row] = await runInScope(db, { organizationId }, (tx) =>
    tx.select().from(wallets).where(eq(wallets.id, paying.wallet.id)),
  );
  if (!row?.treasuryAddress || !row.treasuryPrivyWalletId) {
    throw new Error("Treasury wasn't turned on");
  }
  const treasuryAddress = row.treasuryAddress;
  setBaseBalance(world, treasuryAddress, 0n);
  treasuries.set(row.treasuryPrivyWalletId, {
    address: treasuryAddress,
    world,
  });
  world.privy.state.onEarnDeposit((input) => {
    const treasury = treasuries.get(input.privyWalletId);
    if (!treasury) return;
    setBaseBalance(
      treasury.world,
      treasury.address,
      (baseBalances.get(treasury.address) ?? 0n) - input.rawAmount,
    );
  });
  world.privy.state.onWithdrawn((withdrawal) => {
    const treasury = treasuries.get(withdrawal.privyWalletId);
    if (!treasury) return;
    setBaseBalance(
      treasury.world,
      treasury.address,
      (baseBalances.get(treasury.address) ?? 0n) + withdrawal.delivered,
    );
    treasury.world.base.state.receipts.set(
      withdrawal.txHash,
      transferReceipt(
        [
          {
            from: VAULT_ADDRESS,
            to: treasury.address,
            amount: withdrawal.delivered,
          },
          ...alsoInWithdrawals.splice(0),
        ],
        { txHash: withdrawal.txHash },
      ),
    );
  });
  return {
    ...paying,
    tenant: {
      organizationId,
      userId: paying.company.admin.id,
      membershipId: paying.company.adminMembershipId,
      role: "admin",
    },
    treasuryAddress,
    treasuryPrivyWalletId: row.treasuryPrivyWalletId,
  };
}

const VAULT_ADDRESS = `0x${"7a".repeat(20)}`;

/** Transfers that appear in the next withdrawal's transaction besides the vault's payout. */
const alsoInWithdrawals: TransferLogInput[] = [];

/** USDC another party sends the Treasury wallet in the same transaction as the next withdrawal. */
export function alsoInNextWithdrawal(
  ...transfers: readonly TransferLogInput[]
): void {
  alsoInWithdrawals.push(...transfers);
}

const treasuries = new Map<
  string,
  { readonly address: string; readonly world: NearPayoutWorld }
>();
/** What the fake Base chain holds at each address, mirrored so a deposit can subtract. */
const baseBalances = new Map<string, bigint>();

export function setBaseBalance(
  world: NearPayoutWorld,
  address: string,
  amount: bigint,
): void {
  baseBalances.set(address, amount);
  world.setBaseUsdc(address, amount);
}

/** What the fake Base chain says the company's Treasury wallet holds in USDC. */
export const treasuryWalletUsdc = (company: TreasuryCompany): bigint =>
  baseBalances.get(company.treasuryAddress) ?? 0n;

export const startMove = async (
  world: NearPayoutWorld,
  company: TreasuryCompany,
  amountUsdc: bigint,
): Promise<TreasuryMove> => {
  const request = { direction: "to_treasury", amountUsdc } as const;
  const challenge = await world.runtime.runPromise(
    startMoveConfirmation(company.tenant, request),
  );
  return world.runtime.runPromise(
    startTreasuryMove(company.tenant, {
      ...request,
      challengeId: challenge.challengeId,
      response: company.passkey.sign(challenge.options, TEST_ORIGIN),
    }),
  );
};

export const startMoveToWallet = async (
  world: NearPayoutWorld,
  company: TreasuryCompany,
  amountUsdc: bigint | "all",
): Promise<TreasuryMove> => {
  const request = { direction: "to_wallet", amountUsdc } as const;
  const challenge = await world.runtime.runPromise(
    startMoveConfirmation(company.tenant, request),
  );
  return world.runtime.runPromise(
    startTreasuryMove(company.tenant, {
      ...request,
      challengeId: challenge.challengeId,
      response: company.passkey.sign(challenge.options, TEST_ORIGIN),
    }),
  );
};

/** Puts USDC in the company's vault position and the Treasury wallet's records, as a finished move to Treasury leaves it. */
export function fundVault(
  world: NearPayoutWorld,
  company: TreasuryCompany,
  amount: bigint,
): void {
  world.privy.state.setVaultAssets(company.treasuryPrivyWalletId, amount);
}

export const readMove = async (
  db: Database,
  company: TreasuryCompany,
  moveId: string,
): Promise<TreasuryMove> => {
  const [move] = await runInScope(
    db,
    { organizationId: company.tenant.organizationId },
    (tx) => tx.select().from(treasuryMoves).where(eq(treasuryMoves.id, moveId)),
  );
  if (!move) throw new Error("move vanished");
  return move;
};

export const readActions = (
  db: Database,
  company: TreasuryCompany,
): Promise<TreasuryEarnAction[]> =>
  runInScope(db, { organizationId: company.tenant.organizationId }, (tx) =>
    tx
      .select()
      .from(treasuryEarnActions)
      .orderBy(treasuryEarnActions.createdAt),
  );

export const readLedger = (db: Database, company: TreasuryCompany) =>
  runInScope(db, { organizationId: company.tenant.organizationId }, (tx) =>
    tx
      .select({
        type: walletTransactions.type,
        usdcAmount: walletTransactions.usdcAmount,
        treasuryMoveId: walletTransactions.treasuryMoveId,
        intentQuoteId: walletTransactions.intentQuoteId,
      })
      .from(walletTransactions)
      .orderBy(walletTransactions.createdAt),
  );

export const treasuryQuotes = async (
  db: Database,
  company: TreasuryCompany,
): Promise<IntentQuote[]> =>
  (await readQuotes(db, company.company)).filter(
    (quote) => quote.purpose === "to_treasury",
  );

/**
 * What 1Click does once a part's deposit has arrived: reports the delivery
 * and the Treasury wallet's USDC rises by what it delivered. Each quote is
 * delivered once.
 */
export async function deliverSentParts(
  world: NearPayoutWorld,
  db: Database,
  company: TreasuryCompany,
  delivered: Set<string>,
): Promise<void> {
  for (const quote of await treasuryQuotes(db, company)) {
    if (
      quote.status !== "depositing" ||
      quote.companyWalletSendId === null ||
      delivered.has(quote.id)
    ) {
      continue;
    }
    delivered.add(quote.id);
    const holds = baseBalances.get(company.treasuryAddress) ?? 0n;
    setBaseBalance(world, company.treasuryAddress, holds + quote.amountOut);
    world.oneClick.state.setStatus(quote.depositAddress, {
      status: "SUCCESS",
      depositedAmount: quote.amountIn,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      destinationChainTxHashes: [randomTxHash()],
    });
  }
}

export const returnQuotes = async (
  db: Database,
  company: TreasuryCompany,
): Promise<IntentQuote[]> =>
  (await readQuotes(db, company.company)).filter(
    (quote) => quote.purpose === "from_treasury",
  );

/**
 * What 1Click does once a return part has been sent from the Treasury
 * wallet: the wallet's USDC falls by the part and 1Click reports the
 * delivery. Each quote is settled once. `refund` returns the part to the
 * Treasury wallet instead.
 */
export async function settleSentReturns(
  world: NearPayoutWorld,
  db: Database,
  company: TreasuryCompany,
  settled: Set<string>,
  outcome: "deliver" | "refund" = "deliver",
): Promise<void> {
  for (const quote of await returnQuotes(db, company)) {
    if (
      quote.status !== "depositing" ||
      quote.depositTxHash === null ||
      settled.has(quote.id)
    ) {
      continue;
    }
    settled.add(quote.id);
    if (outcome === "refund") {
      world.oneClick.state.setStatus(quote.depositAddress, {
        status: "REFUNDED",
        depositedAmount: quote.amountIn,
        refundedAmount: quote.amountIn,
        refundReason: "deadline",
      });
      continue;
    }
    const holds = baseBalances.get(company.treasuryAddress) ?? 0n;
    setBaseBalance(world, company.treasuryAddress, holds - quote.amountIn);
    world.oneClick.state.setStatus(quote.depositAddress, {
      status: "SUCCESS",
      depositedAmount: quote.amountIn,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      destinationChainTxHashes: [randomNearTxHash()],
    });
  }
}

/**
 * What the deposit watcher does for a delivered part, without the watcher:
 * the company wallet's NEAR USDC rises and a `from_treasury` credit linked to
 * the move and the quote is written once.
 */
export async function creditDeliveries(
  world: NearPayoutWorld,
  db: Database,
  company: TreasuryCompany,
  credited: Set<string>,
): Promise<void> {
  for (const quote of await returnQuotes(db, company)) {
    if (quote.status !== "succeeded" || credited.has(quote.id)) continue;
    if (quote.treasuryMoveId === null) continue;
    credited.add(quote.id);
    const amount = quote.swappedAmountOut ?? quote.amountOut;
    world.near.state.fundWithUsdc(company.accountId, amount);
    await runInScope(
      db,
      { organizationId: company.tenant.organizationId },
      (tx) =>
        tx.insert(walletTransactions).values({
          organizationId: company.tenant.organizationId,
          walletId: company.wallet.id,
          type: "from_treasury",
          chain: "near",
          usdcAmount: amount,
          treasuryMoveId: quote.treasuryMoveId,
          intentQuoteId: quote.id,
          txHash: randomNearTxHash(),
          receiptId: randomNearTxHash(),
          logIndex: 0,
          transferIndex: 0,
        }),
    );
  }
}

/**
 * Runs the `treasury-moves` job over one move until it leaves `open`, with
 * 1Click delivering what the company wallet and the Treasury wallet send and
 * the deposit watcher crediting what reaches the company wallet in between.
 */
export async function runMoveToEnd(
  world: NearPayoutWorld,
  db: Database,
  company: TreasuryCompany,
  moveId: string,
): Promise<TreasuryMove> {
  const delivered = new Set<string>();
  const settled = new Set<string>();
  const credited = new Set<string>();
  const ref = { organizationId: company.tenant.organizationId, moveId };
  for (let round = 0; round < 80; round += 1) {
    await deliverSentParts(world, db, company, delivered);
    await settleSentReturns(world, db, company, settled);
    await creditDeliveries(world, db, company, credited);
    await world.runtime.runPromise(
      advanceTreasuryMove(ref, { retryDelayMs: 0 }),
    );
    const move = await readMove(db, company, moveId);
    if (move.status !== "open") return move;
  }
  throw new Error(`move ${moveId} still open`);
}
