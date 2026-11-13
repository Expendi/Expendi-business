import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import type { WalletBalanceHome } from "../../db/schema/wallets.js";
import type { makeFakePrivyWallets } from "./fakes.js";
import type { FundedCompany } from "./money-in.js";
import {
  intentQuotes,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { createActiveNearWallet, createCompany } from "./db.js";

/**
 * A company with an active company wallet on NEAR whose Privy wallet exists
 * in `privy`, so the real sign-in to 1Click works for it. A fund-in, a pay
 * link quote or a return for it is delivered to a confidential account when
 * `balanceHome` is `confidential_account`.
 */
export async function createDeliveryCompany(
  db: Database,
  privy: ReturnType<typeof makeFakePrivyWallets>,
  balanceHome: WalletBalanceHome = "confidential_account",
): Promise<FundedCompany> {
  const company = await createCompany(db);
  const nearWallet = privy.state.addNearWallet(company.organizationId);
  const wallet = await createActiveNearWallet(
    db,
    company,
    nearWallet,
    undefined,
    balanceHome,
  );
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

/** Switches where the company's USDC sits at rest, as staff will. */
export function switchBalanceHome(
  db: Database,
  funded: FundedCompany,
  balanceHome: WalletBalanceHome,
): Promise<unknown> {
  return runInScope(
    db,
    { organizationId: funded.company.organizationId },
    (tx) =>
      tx
        .update(wallets)
        .set({ balanceHome })
        .where(eq(wallets.id, funded.walletId)),
  );
}

/**
 * Ends the company's open quotes. The jobs walk every company in the
 * database, so one test's open quote would otherwise be asked about, and
 * hold deposits, in every later test of the file.
 */
export function settleOpenQuotes(
  db: Database,
  funded: FundedCompany,
): Promise<unknown> {
  return runInScope(
    db,
    { organizationId: funded.company.organizationId },
    (tx) =>
      tx
        .update(intentQuotes)
        .set({ status: "refunded", settledAt: new Date() })
        .where(
          and(
            eq(intentQuotes.organizationId, funded.company.organizationId),
            inArray(intentQuotes.status, [...UNSETTLED_INTENT_QUOTE_STATUSES]),
          ),
        ),
  );
}
