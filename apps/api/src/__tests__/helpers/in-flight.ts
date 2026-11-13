import { randomUUID } from "node:crypto";

import type { Database } from "../../db/client.js";
import type { NewPayout, Payout } from "../../db/schema/index.js";
import type { TestCompany, TestWallet } from "./db.js";
import { companyWalletSends, payouts } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { randomTxHash } from "./chain.js";
import { randomNearAccount } from "./near.js";

interface Target {
  readonly company: TestCompany;
  readonly wallet: TestWallet;
}

/** A company wallet send that has been reserved, or signed and not yet resolved. */
export async function insertOpenSend(
  db: Database,
  target: Target,
  status: "reserved" | "signed",
): Promise<void> {
  await runInScope(
    db,
    { organizationId: target.company.organizationId },
    (tx) =>
      tx.insert(companyWalletSends).values({
        organizationId: target.company.organizationId,
        walletId: target.wallet.id,
        sendKey: `payout-${randomTxHash()}`,
        kind: "transfer",
        senderAccountId: target.wallet.address,
        receiverAccountId: randomNearAccount(),
        usdcAmount: 5_000_000n,
        nonce: 9_000n,
        maxBlockHeight: 1_000n,
        status,
        ...(status === "signed" && { signedDelegate: "c2lnbmVk" }),
      }),
  );
}

/** A cash-out whose USDC is on its way to the provider's address. */
export async function insertFundingPayout(
  db: Database,
  target: Target,
  overrides: Partial<NewPayout> = {},
): Promise<Payout> {
  const [payout] = await runInScope(
    db,
    { organizationId: target.company.organizationId },
    (tx) =>
      tx
        .insert(payouts)
        .values({
          organizationId: target.company.organizationId,
          walletId: target.wallet.id,
          subjectType: "claim",
          subjectId: randomUUID(),
          idempotencyKey: `claim:${randomUUID()}:1`,
          provider: "pretium",
          method: "mpesa_phone",
          recipient: {
            method: "mpesa_phone",
            phone: "+254712345678",
            accountName: "Jane Wanjiku",
          },
          requestedKesCents: 150_000n,
          amountKes: 150_000n,
          quotedRate: "128.68",
          quotedUsdc: 11_656_823n,
          maxDebitUsdc: 11_965_108n,
          status: "funding",
          approvalId: randomUUID(),
          approvedBy: target.company.admin.id,
          approvedAt: new Date(),
          amountToTransferUsdc: 11_700_000n,
          depositAddress: `0x${"ab".repeat(20)}`,
          fundingStartedAt: new Date(),
          ...overrides,
        })
        .returning(),
  );
  if (!payout) throw new Error("payout insert returned no row");
  return payout;
}
