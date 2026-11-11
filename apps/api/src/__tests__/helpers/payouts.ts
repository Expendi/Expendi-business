import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import type { PayeeChain } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type {
  KesPayoutRequest,
  PayoutRequest,
} from "../../services/payout/payout-service.js";
import type { TestCompany, TestWallet } from "./db.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import { payouts, walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  confirmAllowlistChange,
  requestAllowlistChange,
} from "../../services/allowlist/allowlist.js";
import {
  finishPasskeyEnrolment,
  startPasskeyEnrolment,
} from "../../services/approval/passkeys.js";
import {
  approveAndPay,
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { randomTxHash } from "./chain.js";
import { createActiveWallet, createCompany } from "./db.js";
import { TEST_ORIGIN } from "./fakes.js";

export const USDC = 1_000_000n;

/** A company with a funded wallet and an admin who has an approval passkey. */
export interface PayingCompany {
  readonly company: TestCompany;
  readonly wallet: TestWallet;
  readonly passkey: SoftwarePasskey;
}

export async function createPayingCompany(
  runtime: AppRuntime,
  db: Database,
  balance = 100n * USDC,
): Promise<PayingCompany> {
  const company = await createCompany(db);
  const wallet = await createActiveWallet(db, company);
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
  return { company, wallet, passkey };
}

export function claimRequest(
  overrides: Partial<KesPayoutRequest> = {},
): KesPayoutRequest {
  return {
    subjectType: "claim",
    subjectId: randomUUID(),
    idempotencyKey: `claim:${randomUUID()}:1`,
    recipient: {
      method: "mpesa_phone",
      phone: "+254712345678",
      accountName: "Jane Wanjiku",
    },
    amountKesCents: 149_950n,
    ...overrides,
  };
}

/** Prepares, approves with the admin's passkey, and funds. */
export async function payClaims(
  runtime: AppRuntime,
  database: Database,
  { company, passkey }: PayingCompany,
  requests: readonly PayoutRequest[],
): Promise<Payout[]> {
  const prepared = await runtime.runPromise(
    preparePayouts({
      organizationId: company.organizationId,
      actor: { type: "user", id: company.admin.id },
      requests,
    }),
  );
  const approval = await runtime.runPromise(
    requestPayoutApproval({
      organizationId: company.organizationId,
      userId: company.admin.id,
      payoutIds: prepared.map((payout) => payout.id),
    }),
  );
  await runtime.runPromise(
    approveAndPay({
      organizationId: company.organizationId,
      userId: company.admin.id,
      challengeId: approval.challengeId,
      response: passkey.sign(approval.options, TEST_ORIGIN),
    }),
  );
  return Promise.all(
    prepared.map((payout) => readPayout(database, company, payout.id)),
  );
}

export async function readPayout(
  database: Database,
  company: TestCompany,
  payoutId: string,
): Promise<Payout> {
  const [payout] = await runInScope(
    database,
    { organizationId: company.organizationId },
    (tx) => tx.select().from(payouts).where(eq(payouts.id, payoutId)),
  );
  if (!payout) throw new Error(`payout ${payoutId} not found`);
  return payout;
}

export async function updatePayout(
  database: Database,
  company: TestCompany,
  payoutId: string,
  changes: Partial<typeof payouts.$inferInsert>,
): Promise<void> {
  await runInScope(database, { organizationId: company.organizationId }, (tx) =>
    tx.update(payouts).set(changes).where(eq(payouts.id, payoutId)),
  );
}

export async function ledgerBalance(
  database: Database,
  company: TestCompany,
): Promise<bigint> {
  const rows = await runInScope(
    database,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .select({ usdcAmount: walletTransactions.usdcAmount })
        .from(walletTransactions),
  );
  return rows.reduce((sum, row) => sum + row.usdcAmount, 0n);
}

/**
 * Adds `address` to the company's allowlist, confirmed with the passkey. It
 * is a Base address unless `chain` says otherwise.
 */
export async function allowlistAddress(
  runtime: AppRuntime,
  { company, passkey }: PayingCompany,
  address: string,
  label = "Treasury",
  chain: PayeeChain = "base",
): Promise<string> {
  const change = { action: "add", chain, address, label } as const;
  const challenge = await runtime.runPromise(
    requestAllowlistChange({
      organizationId: company.organizationId,
      userId: company.admin.id,
      change,
    }),
  );
  const row = await runtime.runPromise(
    confirmAllowlistChange({
      organizationId: company.organizationId,
      userId: company.admin.id,
      challengeId: challenge.challengeId,
      response: passkey.sign(challenge.options, TEST_ORIGIN),
      change,
    }),
  );
  return row.id;
}
