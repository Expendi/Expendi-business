import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";

import type { WalletChain } from "@expendi-business/shared";

import type { DatabaseService } from "../db/client.js";
import type { DatabaseError } from "../errors.js";
import type { Tenant, TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { wallets, walletTransactions } from "../db/schema/index.js";
import { query, withScope } from "../db/scope.js";
import { NotFound } from "../errors.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import { kesCentsFor } from "../services/paycrest/amounts.js";
import { Paycrest } from "../services/paycrest/paycrest-client.js";
import {
  readyAddress,
  setUpCompanyWallet,
} from "../services/wallet/wallet-setup.js";

/** Only before sign-up's first wallet step has run, e.g. if it hit a database error. */
const noWallet = new NotFound({ message: "This company has no wallet yet" });

/** Paycrest's marginal sell rate, which is what a small payout gets. */
const RATE_PROBE_USDC = "1";

/**
 * Display only, so a Paycrest outage shows the balance without its KES
 * equivalent rather than failing the whole wallet screen.
 */
function kesEquivalent(usdcBalance: bigint) {
  return Effect.flatMap(Paycrest, (paycrest) =>
    paycrest.rate(RATE_PROBE_USDC),
  ).pipe(
    Effect.map(({ rate }) => ({
      kesCents: kesCentsFor(usdcBalance > 0n ? usdcBalance : 0n, rate),
      rate,
    })),
    Effect.catchTag("PaycrestError", (error) =>
      Effect.sync(() => {
        console.warn("[wallet] KES equivalent unavailable", error.message);
        return null;
      }),
    ),
  );
}

/** `WalletResponse` before serialisation, which turns bigints into strings. */
type CompanyWallet =
  | { readonly status: "creating" }
  | {
      readonly status: "active";
      readonly address: string;
      readonly chain: WalletChain;
      readonly usdcBalance: bigint;
      readonly kesEquivalent: {
        readonly kesCents: bigint;
        readonly rate: string;
      } | null;
    };

/**
 * The ledger balance: what Expendi will let the company spend. Read only: a
 * wallet still `creating` is reported as such, and `POST` resumes it.
 */
function getCompanyWallet(
  tenant: Tenant,
): Effect.Effect<
  CompanyWallet,
  NotFound | DatabaseError,
  DatabaseService | Paycrest
> {
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const [wallet] = yield* query(() =>
        tx
          .select({
            id: wallets.id,
            status: wallets.status,
            address: wallets.address,
            chain: wallets.chain,
            depositsWatchedAt: wallets.depositsWatchedAt,
          })
          .from(wallets)
          .where(eq(wallets.organizationId, tenant.organizationId))
          .limit(1),
      );
      if (!wallet) return yield* Effect.fail(noWallet);
      const address = readyAddress(wallet);
      if (address === null) return null;

      const [ledger] = yield* query(() =>
        tx
          .select({
            balance: sql<string>`coalesce(sum(${walletTransactions.usdcAmount}), 0)::text`,
          })
          .from(walletTransactions)
          .where(eq(walletTransactions.walletId, wallet.id)),
      );
      return {
        address,
        chain: wallet.chain,
        usdcBalance: BigInt(ledger?.balance ?? "0"),
      };
    }),
  ).pipe(
    Effect.flatMap((wallet): Effect.Effect<CompanyWallet, never, Paycrest> =>
      wallet === null
        ? Effect.succeed({ status: "creating" })
        : Effect.map(kesEquivalent(wallet.usdcBalance), (kes) => ({
            status: "active",
            ...wallet,
            kesEquivalent: kes,
          })),
    ),
  );
}

/**
 * Mounted at `/organizations/:organizationId/wallet`. Admins only (spec §4).
 * POST finishes a wallet whose setup stopped at sign-up; it's safe to repeat.
 */
export function createWalletRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("admin"))
    .get("/", (c) => runEffect(runtime, c, getCompanyWallet(c.get("tenant"))))
    .post("/", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        setUpCompanyWallet({
          organizationId: tenant.organizationId,
          actor: { type: "user", id: tenant.userId },
        }),
      );
    });
}
