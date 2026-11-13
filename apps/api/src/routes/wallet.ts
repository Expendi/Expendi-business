import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import type { WalletChain } from "@expendi-business/shared";
import {
  fundInRequestSchema,
  WALLET_HISTORY_PAGE_SIZE,
} from "@expendi-business/shared";

import type { DatabaseService } from "../db/client.js";
import type { DatabaseError } from "../errors.js";
import type { Tenant, TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import type { Paycrest } from "../services/paycrest/paycrest-client.js";
import type { Pretium } from "../services/pretium/pretium-client.js";
import { wallets, walletTransactions } from "../db/schema/index.js";
import { query, withScope } from "../db/scope.js";
import { BadRequest, NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader } from "../middleware/tenant.js";
import { activeKesRateOrNull } from "../services/cash-out/active-rate.js";
import {
  createFundIn,
  getFundIn,
  listFundIns,
} from "../services/intents/fund-in.js";
import { kesCentsFor } from "../services/paycrest/amounts.js";
import { walletHistory } from "../services/wallet/history.js";
import {
  readyAddress,
  setUpCompanyWallet,
} from "../services/wallet/wallet-setup.js";

/** Only before sign-up's first wallet step has run, e.g. if it hit a database error. */
const noWallet = new NotFound({ message: "This company has no wallet yet" });

/**
 * At the active cash-out provider's rate. Display only, so a provider
 * outage shows the balance without its KES equivalent rather than failing
 * the whole wallet screen.
 */
function kesEquivalent(usdcBalance: bigint) {
  return activeKesRateOrNull("wallet").pipe(
    Effect.map((rate) =>
      rate === null
        ? null
        : {
            kesCents: kesCentsFor(usdcBalance > 0n ? usdcBalance : 0n, rate),
            rate,
          },
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
  DatabaseService | Paycrest | Pretium
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
    Effect.flatMap(
      (
        wallet,
      ): Effect.Effect<
        CompanyWallet,
        DatabaseError,
        DatabaseService | Paycrest | Pretium
      > =>
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

function parseQuery<T>(
  schema: z.ZodType<T>,
  raw: Record<string, string>,
): Effect.Effect<T, BadRequest> {
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(new BadRequest({ message: "Invalid history page request" }));
}

const historyQuerySchema = z.object({
  before: z.uuid().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(WALLET_HISTORY_PAGE_SIZE),
});

/**
 * Mounted at `/organizations/:organizationId/wallet`. Admins, and accountants
 * read-only (spec §4).
 * POST finishes a wallet whose setup stopped at sign-up; it's safe to repeat.
 *
 * `/fund-ins` follows the same rule: an admin starts a fund-in, and admins
 * and accountants can see the deposit address and how it is going.
 */
export function createWalletRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/", (c) => runEffect(runtime, c, getCompanyWallet(c.get("tenant"))))
    .get("/history", (c) => {
      const organizationId = c.get("tenant").organizationId;
      return runEffect(
        runtime,
        c,
        parseQuery(historyQuerySchema, c.req.query()).pipe(
          Effect.flatMap(({ before, limit }) =>
            walletHistory({ organizationId, before: before ?? null, limit }),
          ),
        ),
      );
    })
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
    })
    .post("/fund-ins", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, fundInRequestSchema).pipe(
          Effect.flatMap((body) =>
            createFundIn({
              organizationId: tenant.organizationId,
              actor: { type: "user", id: tenant.userId },
              chain: body.chain,
              amount: BigInt(body.amount),
            }),
          ),
        ),
        201,
      );
    })
    .get("/fund-ins", (c) =>
      runEffect(runtime, c, listFundIns(c.get("tenant").organizationId)),
    )
    .get("/fund-ins/:fundInId", (c) => {
      const fundInId = c.req.param("fundInId");
      return runEffect(
        runtime,
        c,
        z.uuid().safeParse(fundInId).success
          ? getFundIn(c.get("tenant").organizationId, fundInId)
          : Effect.fail(new NotFound({ message: "Fund-in not found" })),
      );
    });
}
