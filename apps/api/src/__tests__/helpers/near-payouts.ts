import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import type { Database } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { ExternalLayers } from "../../layers/main.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "./db.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import {
  intentQuotes,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  finishPasskeyEnrolment,
  startPasskeyEnrolment,
} from "../../services/approval/passkeys.js";
import { USDC_BASE_ADDRESS } from "../../services/chain/base.js";
import { isImplicitNearAccount } from "../../services/chain/near.js";
import { OneClick } from "../../services/intents/one-click.js";
import { randomTxHash } from "./chain.js";
import { createActiveNearWallet, createCompany } from "./db.js";
import {
  callKey,
  makeFakeBaseRpc,
  makeFakePaycrest,
  makeFakePretium,
  makeFakePrivyWallets,
  TEST_ORIGIN,
} from "./fakes.js";
import { makeFakeFastNear } from "./fast-near.js";
import { makeFakeNearRpc, nearRelayerOnFakeChain } from "./near.js";
import { makeFakeOneClick } from "./one-click.js";
import { makeTestRuntime } from "./runtime.js";

const USDC = 1_000_000n;

/**
 * Everything a company on NEAR pays through, in memory: Privy, the NEAR
 * chain with the real gas relayer on it, its transfers indexer, 1Click,
 * Base, Paycrest and Pretium. The fake 1Click never moves money, so a test that
 * needs a hop delivered sets the transit wallet's balance and 1Click's
 * status itself. `extra` adds fakes a test needs beyond these, and `env`
 * settings such as the Earn vault ID.
 */
export function makeNearPayoutWorld(
  extra: Partial<ExternalLayers> = {},
  env: Readonly<Record<string, string | undefined>> = {},
) {
  const privy = makeFakePrivyWallets();
  const near = makeFakeNearRpc();
  const relayer = nearRelayerOnFakeChain(privy.state, near);
  const oneClick = makeFakeOneClick();
  const base = makeFakeBaseRpc();
  const paycrest = makeFakePaycrest();
  const pretium = makeFakePretium();
  const fastNear = makeFakeFastNear();
  near.state.fundWithUsdc(relayer.accountId, 1_000n * USDC);

  // On the real chain the USDC contract registers an account that doesn't
  // exist yet; the fake chain wants it to exist, as receiving NEAR makes it.
  const plain = Effect.runSync(Effect.provide(OneClick, oneClick.layer));
  const oneClickLayer = Layer.succeed(OneClick, {
    ...plain,
    quote: (request) =>
      plain.quote(request).pipe(
        Effect.tap((quote) =>
          Effect.sync(() => {
            if (!quote.dry && isImplicitNearAccount(quote.depositAddress)) {
              near.state.createAccount(quote.depositAddress);
            }
          }),
        ),
      ),
  });

  // The staff evidence reads the relayer's account from configuration.
  const runtime: AppRuntime = makeTestRuntime(
    {
      privyWallets: privy.layer,
      nearRpc: near.layer,
      nearRelayer: relayer.layer,
      fastNear: fastNear.layer,
      oneClick: oneClickLayer,
      baseRpc: base.layer,
      paycrest: paycrest.layer,
      pretium: pretium.layer,
      ...extra,
    },
    { NEAR_RELAYER_ACCOUNT_ID: relayer.accountId, ...env },
  );

  const balanceKey = (address: string) =>
    callKey(
      USDC_BASE_ADDRESS,
      `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`,
    );

  return {
    runtime,
    privy,
    near,
    relayer,
    oneClick,
    base,
    paycrest,
    pretium,
    fastNear,
    /** What a Base address holds in USDC, as the chain reports it. */
    setBaseUsdc(address: string, amount: bigint) {
      base.state.callResults.set(
        balanceKey(address),
        `0x${amount.toString(16).padStart(64, "0")}`,
      );
    },
  };
}

export type NearPayoutWorld = ReturnType<typeof makeNearPayoutWorld>;

export interface NearPayingCompany {
  readonly company: TestCompany;
  readonly wallet: TestWallet;
  readonly passkey: SoftwarePasskey;
  /** The company wallet's NEAR account. */
  readonly accountId: string;
  readonly transitAddress: string;
  readonly transitPrivyWalletId: string;
}

/**
 * A company whose money is on NEAR: an active company wallet holding
 * `balance` on chain and in the ledger, an empty transit wallet, and an
 * admin with an approval passkey.
 */
export async function createNearPayingCompany(
  world: NearPayoutWorld,
  db: Database,
  options: {
    readonly balance?: bigint;
    readonly perTransactionMaxUsdc?: bigint;
  } = {},
): Promise<NearPayingCompany> {
  const balance = options.balance ?? 100n * USDC;
  const company = await createCompany(db);
  const nearWallet = world.privy.state.addNearWallet();
  const wallet = await createActiveNearWallet(
    db,
    company,
    nearWallet,
    options.perTransactionMaxUsdc,
  );
  world.near.state.fundWithUsdc(nearWallet.accountId, balance);
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    async (tx) => {
      await tx.insert(walletTransactions).values({
        organizationId: company.organizationId,
        walletId: wallet.id,
        type: "deposit",
        usdcAmount: balance,
        txHash: randomTxHash(),
        logIndex: 0,
        blockNumber: 1n,
      });
      return tx.select().from(wallets).where(eq(wallets.id, wallet.id));
    },
  );
  if (!row?.transitAddress || !row.transitPrivyWalletId) {
    throw new Error("the NEAR wallet has no transit wallet");
  }
  world.setBaseUsdc(row.transitAddress, 0n);
  const passkey = SoftwarePasskey.create();
  const enrolment = await world.runtime.runPromise(
    startPasskeyEnrolment(company.admin.id),
  );
  await world.runtime.runPromise(
    finishPasskeyEnrolment(
      company.admin.id,
      passkey.register(enrolment, TEST_ORIGIN),
    ),
  );
  return {
    company,
    wallet,
    passkey,
    accountId: nearWallet.accountId,
    transitAddress: row.transitAddress,
    transitPrivyWalletId: row.transitPrivyWalletId,
  };
}

/** Every NEAR Intents quote the company has, oldest first. */
export async function readQuotes(
  db: Database,
  company: TestCompany,
): Promise<IntentQuote[]> {
  const rows = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) => tx.select().from(intentQuotes),
  );
  return rows.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );
}

export async function updateQuote(
  db: Database,
  company: TestCompany,
  quoteId: string,
  changes: Partial<typeof intentQuotes.$inferInsert>,
): Promise<void> {
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.update(intentQuotes).set(changes).where(eq(intentQuotes.id, quoteId)),
  );
}

/**
 * What 1Click does when it delivers a hop: the transit wallet holds the
 * quote's amount out more, and its status reports the delivery.
 */
export function deliverHop(
  world: NearPayoutWorld,
  paying: NearPayingCompany,
  quote: IntentQuote,
  transitBalanceAfter: bigint = quote.amountOut,
): void {
  world.setBaseUsdc(paying.transitAddress, transitBalanceAfter);
  world.oneClick.state.setStatus(quote.depositAddress, {
    status: "SUCCESS",
    depositedAmount: quote.amountIn,
    amountIn: quote.minAmountIn ?? quote.amountIn,
    amountOut: quote.amountOut,
    destinationChainTxHashes: [randomTxHash()],
  });
}
