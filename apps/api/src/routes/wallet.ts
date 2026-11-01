import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";

import type { Tenant, TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { wallets, walletTransactions } from "../db/schema/index.js";
import { query, withScope } from "../db/scope.js";
import { NotFound } from "../errors.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import { kesCentsFor } from "../services/paycrest/amounts.js";
import { Paycrest } from "../services/paycrest/paycrest-client.js";

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

/** The ledger balance: what Expendi will let the company spend. */
function getCompanyWallet(tenant: Tenant) {
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const [wallet] = yield* query(() =>
        tx
          .select({
            id: wallets.id,
            address: wallets.address,
            chain: wallets.chain,
          })
          .from(wallets)
          .where(
            and(
              eq(wallets.organizationId, tenant.organizationId),
              eq(wallets.status, "active"),
            ),
          )
          .limit(1),
      );
      if (!wallet?.address) return yield* Effect.fail(noWallet);

      const [ledger] = yield* query(() =>
        tx
          .select({
            balance: sql<string>`coalesce(sum(${walletTransactions.usdcAmount}), 0)::text`,
          })
          .from(walletTransactions)
          .where(eq(walletTransactions.walletId, wallet.id)),
      );
      return {
        address: wallet.address,
        chain: wallet.chain,
        usdcBalance: BigInt(ledger?.balance ?? "0"),
      };
    }),
  ).pipe(
    Effect.flatMap((wallet) =>
      Effect.map(kesEquivalent(wallet.usdcBalance), (kes) => ({
        ...wallet,
        kesEquivalent: kes,
      })),
    ),
  );
}

/** Mounted at `/organizations/:organizationId/wallet`. Admins only (spec §4). */
export function createWalletRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("admin"))
    .get("/", (c) => runEffect(runtime, c, getCompanyWallet(c.get("tenant"))));
}
