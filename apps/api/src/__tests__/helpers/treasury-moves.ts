import { eq } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import type {
  IntentQuote,
  TreasuryEarnAction,
  TreasuryMove,
} from "../../db/schema/index.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { NearPayingCompany, NearPayoutWorld } from "./near-payouts.js";
import {
  treasuryEarnActions,
  treasuryMoves,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  startMoveConfirmation,
  startTreasuryMove,
} from "../../services/treasury/moves.js";
import { turnOnTreasury } from "../../services/treasury/turn-on.js";
import { randomTxHash } from "./chain.js";
import { TEST_ORIGIN } from "./fakes.js";
import { createNearPayingCompany, readQuotes } from "./near-payouts.js";

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
