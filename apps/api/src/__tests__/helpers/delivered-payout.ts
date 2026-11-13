import { randomUUID } from "node:crypto";

import type { Database } from "../../db/client.js";
import type { NewPayout } from "../../db/schema/index.js";
import type { TestCompany, TestWallet } from "./db.js";
import { intentQuotes, walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { ONE_CLICK_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import { insertBillPayment } from "./bills.js";
import { randomNearAccount, randomNearTxHash } from "./near.js";

/**
 * A USDC payout to a payee on `chain`, delivered by a succeeded quote that
 * reported `deliveryTxHash` as the payee chain's transaction. Paid out of a
 * confidential account (no transaction of the company's own: the ledger
 * debit has no hash and the payout has none) unless `companySend` gives the
 * NEAR deposit hash a company wallet would have sent.
 */
export async function insertDeliveredBillPayment(
  db: Database,
  company: TestCompany,
  wallet: TestWallet,
  billId: string,
  delivery: {
    readonly chain: "near" | "base" | "solana";
    readonly address: string;
    readonly deliveryTxHash: string;
    readonly companySend?: string;
  },
  values: Partial<NewPayout> = {},
): Promise<string> {
  const confidential = delivery.companySend === undefined;
  const deadline = new Date("2026-11-13T04:00:00Z");
  const [quote] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .insert(intentQuotes)
        .values({
          organizationId: company.organizationId,
          walletId: wallet.id,
          quoteKey: `quote:${randomUUID()}`,
          purpose: "usdc_payout",
          swapType: "EXACT_OUTPUT",
          originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
          destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
          amountIn: 5_053_815n,
          minAmountIn: 5_003_276n,
          amountOut: 5_000_000n,
          depositAddress: randomNearAccount(),
          recipient: delivery.address,
          refundTo: wallet.address,
          deadline,
          quoteResponse: { signature: "ed25519:test" },
          status: "succeeded",
          settledAt: deadline,
          depositStartedAt: deadline,
          destinationChainTxHashes: [delivery.deliveryTxHash],
          ...(confidential && {
            depositType: "CONFIDENTIAL_INTENTS" as const,
            refundType: "CONFIDENTIAL_INTENTS" as const,
            signedIntent: { standard: "nep413", payload: { message: "{}" } },
            intentDeadline: deadline,
          }),
        })
        .returning({ id: intentQuotes.id }),
  );
  if (!quote) throw new Error("quote insert returned no row");

  const payoutId = await insertBillPayment(
    db,
    company,
    wallet.id,
    billId,
    {
      provider: "onchain",
      method: "usdc",
      recipient: {
        method: "usdc",
        chain: delivery.chain,
        address: delivery.address,
        accountName: "Kenya Power",
      },
      providerReference: delivery.deliveryTxHash,
      txHash: delivery.companySend ?? null,
      deliveryQuoteId: quote.id,
      ...values,
    },
    { recordDebit: false },
  );
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(walletTransactions).values({
      organizationId: company.organizationId,
      walletId: wallet.id,
      type: "payout",
      chain: "near",
      usdcAmount: -5_053_815n,
      txHash: delivery.companySend ?? null,
      ...(delivery.companySend !== undefined && {
        receiptId: randomNearTxHash(),
        logIndex: 0,
        transferIndex: 0,
        blockNumber: 150_000_000n,
      }),
      payoutId,
    }),
  );
  return payoutId;
}
