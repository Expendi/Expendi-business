import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { WalletChain } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { BadRequest, DatabaseError } from "../../errors.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import type { StaffPayoutSummaryView } from "./payouts.js";
import {
  expenses,
  memberships,
  organizations,
  payouts,
  platformSettings,
  users,
  wallets,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { NotFound } from "../../errors.js";
import { activeKesRateOrNull } from "../cash-out/active-rate.js";
import { kesCentsFor } from "../paycrest/amounts.js";
import { ledgerBalance } from "../wallet/ledger.js";
import { decodeCursor, encodeCursor, isoUtc, UUID } from "./paging.js";
import { payoutSummary } from "./payouts.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * Company views for staff (spec §6.15). The list comes from the
 * `staff_search_companies` definer function; one company's detail is read
 * in that company's scope, in a read-only transaction.
 */

/** Submitted, or approved and not yet paid (a failed payout waits for a retry). */
const UNPAID_CLAIM_STATUSES = ["submitted", "paying", "payout_failed"] as const;

const RECENT_PAYOUTS = 10;

export interface CompanySummaryView {
  readonly id: string;
  readonly name: string;
  readonly kraPin: string | null;
  readonly payoutsPaused: boolean;
  readonly createdAt: string;
}

interface CompanyRow extends Record<string, unknown> {
  readonly organization_id: string;
  readonly name: string;
  readonly sort_name: string;
  readonly kra_pin: string | null;
  readonly payouts_paused: boolean;
  readonly created_at: string;
}

const ANY_KEY = /^[\s\S]{0,400}$/;

export function searchCompanies(input: {
  readonly search?: string | undefined;
  readonly pausedOnly?: boolean;
  readonly cursor?: string | undefined;
  readonly limit: number;
}): Effect.Effect<
  { companies: CompanySummaryView[]; nextCursor: string | null },
  BadRequest | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const cursor = input.cursor
      ? yield* decodeCursor(input.cursor, ANY_KEY)
      : null;
    const { rows } = yield* withStaffReadScope({}, (tx) =>
      query(() =>
        tx.execute<CompanyRow>(sql`
          SELECT c.organization_id, c.name, c.sort_name, c.kra_pin,
                 c.payouts_paused, ${isoUtc(sql`c.created_at`)} AS created_at
          FROM staff_search_companies(
            ${input.search ?? null}::text,
            ${input.pausedOnly ?? false}::boolean,
            ${cursor?.at ?? null}::text,
            ${cursor?.id ?? null}::uuid,
            ${input.limit + 1}::integer
          ) AS c`),
      ),
    );
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      companies: page.map((row) => ({
        id: row.organization_id,
        name: row.name,
        kraPin: row.kra_pin,
        payoutsPaused: row.payouts_paused,
        createdAt: row.created_at,
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ at: last.sort_name, id: last.organization_id })
          : null,
    };
  });
}

export interface CompanyDetailView {
  readonly id: string;
  readonly name: string;
  readonly kraPin: string | null;
  readonly createdAt: string;
  readonly payoutsPaused: boolean;
  readonly platformPayoutsPaused: boolean;
  readonly dailyPayoutCapKesCents: bigint;
  readonly members: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly email: string;
    readonly role: "admin" | "employee" | "accountant";
    readonly status: "invited" | "active" | "removed";
  }[];
  readonly wallet: {
    readonly chain: WalletChain;
    readonly status: "creating" | "active";
    readonly address: string | null;
    readonly usdcBalance: bigint;
    readonly balanceHome: "company_wallet" | "confidential_account";
    readonly confidentialUsdc: bigint | null;
    readonly confidentialUsdcReadAt: string | null;
    readonly kesEquivalent: { kesCents: bigint; rate: string } | null;
  } | null;
  readonly unpaidClaims: {
    readonly count: number;
    readonly totalKesCents: bigint;
  };
  readonly recentPayouts: readonly StaffPayoutSummaryView[];
}

const noSuchCompany = new NotFound({ message: "No company with this ID" });

/**
 * At the active cash-out provider's rate, as the company's own wallet
 * screen shows it. Display only: a provider outage leaves it out.
 */
function kesEquivalent(usdcBalance: bigint) {
  return activeKesRateOrNull("staff-companies").pipe(
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

export function companyDetail(
  organizationId: string,
): Effect.Effect<
  CompanyDetailView,
  NotFound | DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  if (!UUID.test(organizationId)) return Effect.fail(noSuchCompany);
  return Effect.gen(function* () {
    const read = yield* withStaffReadScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [company] = yield* query(() =>
          tx
            .select()
            .from(organizations)
            .where(eq(organizations.id, organizationId)),
        );
        if (!company) return null;
        const [platform] = yield* query(() =>
          tx
            .select({ paused: platformSettings.payoutsPaused })
            .from(platformSettings)
            .limit(1),
        );
        const members = yield* query(() =>
          tx
            .select({
              id: memberships.id,
              name: users.fullName,
              email: users.email,
              role: memberships.role,
              status: memberships.status,
            })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(eq(memberships.organizationId, organizationId))
            .orderBy(memberships.role, memberships.createdAt),
        );
        const [wallet] = yield* query(() =>
          tx
            .select({
              id: wallets.id,
              chain: wallets.chain,
              status: wallets.status,
              address: wallets.address,
              balanceHome: wallets.balanceHome,
              confidentialUsdc: wallets.confidentialUsdc,
              confidentialUsdcReadAt: wallets.confidentialUsdcReadAt,
            })
            .from(wallets)
            .where(eq(wallets.organizationId, organizationId)),
        );
        const balance = wallet ? yield* ledgerBalance(tx, wallet.id) : 0n;
        const [unpaid] = yield* query(() =>
          tx
            .select({
              count: sql<number>`count(*)::int`,
              total: sql<string>`coalesce(sum(${expenses.amountKes}), 0)::text`,
            })
            .from(expenses)
            .where(
              and(
                eq(expenses.organizationId, organizationId),
                eq(expenses.kind, "claim"),
                inArray(expenses.status, [...UNPAID_CLAIM_STATUSES]),
              ),
            ),
        );
        const recent = yield* query(() =>
          tx
            .select({ payout: payouts, walletChain: wallets.chain })
            .from(payouts)
            .innerJoin(wallets, eq(wallets.id, payouts.walletId))
            .where(eq(payouts.organizationId, organizationId))
            .orderBy(desc(payouts.createdAt), desc(payouts.id))
            .limit(RECENT_PAYOUTS),
        );
        return {
          company,
          platformPaused: platform?.paused ?? true,
          members,
          wallet: wallet ? { ...wallet, balance } : null,
          unpaid: {
            count: unpaid?.count ?? 0,
            totalKesCents: BigInt(unpaid?.total ?? "0"),
          },
          recent,
        };
      }),
    );
    if (!read) return yield* Effect.fail(noSuchCompany);
    const { company, wallet } = read;
    const kes = wallet ? yield* kesEquivalent(wallet.balance) : null;
    return {
      id: company.id,
      name: company.name,
      kraPin: company.kraPin,
      createdAt: company.createdAt.toISOString(),
      payoutsPaused: company.payoutsPaused,
      platformPayoutsPaused: read.platformPaused,
      dailyPayoutCapKesCents: company.dailyPayoutCapKes,
      members: read.members,
      wallet: wallet
        ? {
            chain: wallet.chain,
            status: wallet.status,
            address: wallet.address,
            usdcBalance: wallet.balance,
            balanceHome: wallet.balanceHome,
            confidentialUsdc: wallet.confidentialUsdc,
            confidentialUsdcReadAt:
              wallet.confidentialUsdcReadAt?.toISOString() ?? null,
            kesEquivalent: kes,
          }
        : null,
      unpaidClaims: read.unpaid,
      recentPayouts: read.recent.map(({ payout, walletChain }) =>
        payoutSummary(payout, company.name, walletChain),
      ),
    };
  });
}
