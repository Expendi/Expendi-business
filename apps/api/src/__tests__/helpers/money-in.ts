import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { Database } from "../../db/client.js";
import type {
  IntentQuote,
  IntentQuotePurpose,
  NewIntentQuote,
} from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "./db.js";
import {
  intentQuotes,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  ONE_CLICK_FUND_IN_USDC_ASSET_IDS,
  ONE_CLICK_USDC_ASSET_IDS,
  OneClick,
} from "../../services/intents/one-click.js";
import { createActiveNearWallet, createCompany } from "./db.js";
import { randomNearAccount } from "./near.js";

export interface FundedCompany {
  readonly company: TestCompany;
  readonly walletId: string;
  /** The company wallet's NEAR account. */
  readonly accountId: string;
  /** The transit wallet on Base. */
  readonly transitAddress: string;
}

/** A company with an active company wallet on NEAR and its transit wallet. */
export async function createFundedCompany(
  db: Database,
): Promise<FundedCompany> {
  const company = await createCompany(db);
  const wallet = await createActiveNearWallet(db, company, {
    privyWalletId: `near-wallet-${randomUUID()}`,
    accountId: randomNearAccount(),
  });
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .select({ transitAddress: wallets.transitAddress })
        .from(wallets)
        .where(eq(wallets.id, wallet.id)),
  );
  if (!row?.transitAddress) throw new Error("wallet has no transit address");
  return {
    company,
    walletId: wallet.id,
    accountId: wallet.address,
    transitAddress: row.transitAddress,
  };
}

const QUOTE_ROUTES: Readonly<
  Record<
    Exclude<IntentQuotePurpose, "fund_in" | "invoice_payment">,
    {
      readonly swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
      readonly originAsset: string;
      readonly destinationAsset: string;
    }
  >
> = {
  base_hop: {
    swapType: "EXACT_OUTPUT",
    originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
  },
  sweep: {
    swapType: "EXACT_INPUT",
    originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
  },
  usdc_payout: {
    swapType: "EXACT_OUTPUT",
    originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
  },
  fund_in_return: {
    swapType: "EXACT_INPUT",
    originAsset: ONE_CLICK_FUND_IN_USDC_ASSET_IDS.arbitrum,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
  },
};

/**
 * A quote taken from the (fake) 1Click and saved for the company, as the
 * code that runs hops, sweeps and USDC payouts saves one.
 */
export async function saveQuote(
  runtime: AppRuntime,
  db: Database,
  funded: FundedCompany,
  purpose: Exclude<IntentQuotePurpose, "fund_in" | "invoice_payment">,
  options: {
    readonly amount?: bigint;
    readonly row?: Partial<NewIntentQuote>;
  } = {},
): Promise<IntentQuote> {
  const route = QUOTE_ROUTES[purpose];
  const intents = purpose === "fund_in_return";
  const fromCompanyWallet = purpose !== "sweep";
  const recipient =
    fromCompanyWallet && !intents ? funded.transitAddress : funded.accountId;
  const refundTo = fromCompanyWallet ? funded.accountId : funded.transitAddress;
  const sides = intents
    ? ({ depositType: "INTENTS", refundType: "INTENTS" } as const)
    : ({ depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN" } as const);
  const quote = await runtime.runPromise(
    Effect.flatMap(OneClick, (oneClick) =>
      oneClick.quote({
        dry: false,
        ...route,
        amount: options.amount ?? 5_000_000n,
        recipient,
        refundTo,
        ...sides,
        deadline: new Date(Date.now() + 10 * 60_000),
        slippageBps: 100,
      }),
    ),
  );
  if (quote.dry) throw new Error("the fake 1Click gave a dry quote");
  const [row] = await runInScope(
    db,
    { organizationId: funded.company.organizationId },
    (tx) =>
      tx
        .insert(intentQuotes)
        .values({
          organizationId: funded.company.organizationId,
          walletId: funded.walletId,
          quoteKey: `${purpose}:${randomUUID()}`,
          purpose,
          ...route,
          amountIn: quote.amountIn,
          minAmountIn: quote.minAmountIn,
          amountOut: quote.amountOut,
          minAmountOut: quote.minAmountOut,
          depositAddress: quote.depositAddress,
          recipient,
          refundTo,
          ...sides,
          deadline: quote.deadline,
          quoteResponse: quote.signedResponse,
          ...options.row,
        })
        .returning(),
  );
  if (!row) throw new Error("quote insert returned no row");
  return row;
}

export async function readQuote(
  db: Database,
  funded: FundedCompany,
  quoteId: string,
): Promise<IntentQuote> {
  const [row] = await runInScope(
    db,
    { organizationId: funded.company.organizationId },
    (tx) => tx.select().from(intentQuotes).where(eq(intentQuotes.id, quoteId)),
  );
  if (!row) throw new Error("no such quote");
  return row;
}

/** The company's whole ledger, oldest first. */
export function ledgerOf(db: Database, funded: FundedCompany) {
  return runInScope(
    db,
    { organizationId: funded.company.organizationId },
    (tx) =>
      tx
        .select({
          type: walletTransactions.type,
          chain: walletTransactions.chain,
          usdcAmount: walletTransactions.usdcAmount,
          txHash: walletTransactions.txHash,
          receiptId: walletTransactions.receiptId,
          logIndex: walletTransactions.logIndex,
          transferIndex: walletTransactions.transferIndex,
          blockNumber: walletTransactions.blockNumber,
          counterpartyAddress: walletTransactions.counterpartyAddress,
          payoutId: walletTransactions.payoutId,
        })
        .from(walletTransactions)
        .where(eq(walletTransactions.walletId, funded.walletId))
        .orderBy(walletTransactions.createdAt, walletTransactions.id),
  );
}
