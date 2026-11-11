import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import type { CompanyWalletSend, Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { UsdcPayoutRequest } from "../../services/payout/payout-service.js";
import type { TestCompany } from "./db.js";
import type { PayingCompany } from "./payouts.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import {
  companyWalletSends,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  finishPasskeyEnrolment,
  startPasskeyEnrolment,
} from "../../services/approval/passkeys.js";
import { followOnchainPayout } from "../../services/payout/onchain.js";
import { DELEGATE_TTL_BLOCKS } from "../../services/wallet/company-wallet-send.js";
import { randomTxHash } from "./chain.js";
import { createActiveNearWallet, createCompany } from "./db.js";
import { makeFakePrivyWallets, TEST_ORIGIN } from "./fakes.js";
import {
  makeFakeNearRpc,
  nearRelayerOnFakeChain,
  randomNearAccount,
} from "./near.js";
import { USDC } from "./payouts.js";

/**
 * Privy, a NEAR chain and the real gas relayer on it, all in memory: what a
 * test needs to watch a USDC payout leave a company wallet.
 */
export function makeNearUsdcFakes() {
  const privy = makeFakePrivyWallets();
  const chain = makeFakeNearRpc();
  const relayer = nearRelayerOnFakeChain(privy.state, chain);
  return {
    privy,
    chain,
    relayer,
    /** For `makeTestRuntime`. */
    layers: {
      privyWallets: privy.layer,
      nearRpc: chain.layer,
      nearRelayer: relayer.layer,
    },
    /**
     * For `makeTestRuntime`'s environment: the relayer's account, which the
     * staff evidence reads from configuration.
     */
    env: { NEAR_RELAYER_ACCOUNT_ID: relayer.accountId },
    /** Moves the chain past the expiry of every send signed so far. */
    passExpiry(extraBlocks = 0n) {
      chain.state.height += DELEGATE_TTL_BLOCKS + 1n + extraBlocks;
    },
  };
}

export type NearUsdcFakes = ReturnType<typeof makeNearUsdcFakes>;

export interface NearUsdcPayingCompany extends PayingCompany {
  /** The Privy wallet that signs for the company wallet. */
  readonly privyWalletId: string;
}

/**
 * A company whose company wallet is on NEAR and holds `balance` both on the
 * fake chain and in the ledger, with an admin who has an approval passkey.
 */
export async function createNearUsdcPayingCompany(
  runtime: AppRuntime,
  db: Database,
  fakes: NearUsdcFakes,
  balance = 100n * USDC,
  perTransactionMaxUsdc?: bigint,
): Promise<NearUsdcPayingCompany> {
  const company = await createCompany(db);
  const nearWallet = fakes.privy.state.addNearWallet(company.organizationId);
  fakes.chain.state.fundWithUsdc(nearWallet.accountId, balance);
  const wallet = await createActiveNearWallet(
    db,
    company,
    nearWallet,
    perTransactionMaxUsdc,
  );
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(walletTransactions).values({
      organizationId: company.organizationId,
      walletId: wallet.id,
      type: "deposit",
      usdcAmount: balance,
      txHash: randomTxHash(),
      logIndex: 0,
      blockNumber: 1n,
    }),
  );
  const passkey = SoftwarePasskey.create();
  const options = await runtime.runPromise(
    startPasskeyEnrolment(company.admin.id),
  );
  await runtime.runPromise(
    finishPasskeyEnrolment(
      company.admin.id,
      passkey.register(options, TEST_ORIGIN),
    ),
  );
  return { company, wallet, passkey, privyWalletId: nearWallet.privyWalletId };
}

/** An implicit NEAR account that exists and is registered with USDC. */
export function registeredNearAccount(fakes: NearUsdcFakes): string {
  const account = randomNearAccount();
  fakes.chain.state.fundWithUsdc(account, 0n);
  return account;
}

export function nearUsdcBill(
  address: string,
  overrides: Partial<UsdcPayoutRequest> = {},
): UsdcPayoutRequest {
  return {
    subjectType: "bill",
    subjectId: randomUUID(),
    idempotencyKey: `bill:${randomUUID()}:1`,
    recipient: {
      method: "usdc",
      chain: "near",
      address,
      accountName: "Acme Ltd",
    },
    amountUsdc: 25n * USDC,
    ...overrides,
  };
}

/** What the minute job does for one payout, without touching any other. */
export function followPayout(runtime: AppRuntime, payout: Payout) {
  return runtime.runPromise(
    followOnchainPayout({
      organizationId: payout.organizationId,
      payoutId: payout.id,
    }),
  );
}

/** Every send the company wallet has saved, oldest first. */
export function savedSends(
  db: Database,
  company: TestCompany,
): Promise<CompanyWalletSend[]> {
  return runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .select()
      .from(companyWalletSends)
      .where(eq(companyWalletSends.organizationId, company.organizationId))
      .orderBy(asc(companyWalletSends.nonce)),
  );
}
