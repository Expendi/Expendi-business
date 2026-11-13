import { eq } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import type { TransactionReceipt } from "../../services/chain/base.js";
import type { TestCompany } from "./db.js";
import type { makeFakePrivyWallets } from "./fakes.js";
import { wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";

/**
 * Makes the company's sends through the fake Privy land on the fake Base
 * chain, from its Base wallet or its transit wallet, as they would within
 * seconds in production.
 */
export async function mineCompanySends(
  privy: ReturnType<typeof makeFakePrivyWallets>,
  receipts: Map<string, TransactionReceipt>,
  db: Database,
  company: TestCompany,
): Promise<void> {
  const rows = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .select({
          chain: wallets.chain,
          address: wallets.address,
          privyWalletId: wallets.privyWalletId,
          transitAddress: wallets.transitAddress,
          transitPrivyWalletId: wallets.transitPrivyWalletId,
        })
        .from(wallets)
        .where(eq(wallets.organizationId, company.organizationId)),
  );
  for (const row of rows) {
    if (row.chain === "base" && row.address && row.privyWalletId) {
      privy.state.walletAt(row.privyWalletId, row.address);
    }
    if (row.transitAddress && row.transitPrivyWalletId) {
      privy.state.walletAt(row.transitPrivyWalletId, row.transitAddress);
    }
  }
  privy.state.mineOn(receipts);
}
