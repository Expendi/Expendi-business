import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { ConfigService } from "../../config.js";
import { wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import {
  balanceHomeBusy,
  checkConfidentialReadiness,
  lockConfidentialRollout,
} from "./balance-home.js";
import { moveOut } from "./move-out.js";

/** One existing company admitted per tick, oldest attempted first. */
export function rolloutConfidentialAccounts() {
  return Effect.gen(function* () {
    const config = yield* ConfigService;
    if (!config.confidentialAccountsEnabled) return { enabled: 0, waiting: 0 };
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<{ organization_id: string }>(
          sql`SELECT organization_id FROM confidential_rollout_candidates(1)`,
        ),
      ),
    );
    const candidate = rows[0];
    if (!candidate) return { enabled: 0, waiting: 0 };
    return yield* withScope(
      { organizationId: candidate.organization_id },
      (tx) =>
        Effect.gen(function* () {
          yield* lockConfidentialRollout(tx);
          const [wallet] = yield* query(() =>
            tx
              .select()
              .from(wallets)
              .where(eq(wallets.organizationId, candidate.organization_id))
              .for("update"),
          );
          if (
            wallet?.status !== "active" ||
            wallet.chain !== "near" ||
            wallet.balanceHome !== "company_wallet" ||
            wallet.balanceHomeChanging ||
            wallet.confidentialOptOut
          ) {
            return { enabled: 0, waiting: 0 };
          }
          yield* query(() =>
            tx
              .update(wallets)
              .set({ confidentialRolloutCheckedAt: new Date() })
              .where(eq(wallets.id, wallet.id)),
          );
          if ((yield* balanceHomeBusy(tx, wallet)).length)
            return { enabled: 0, waiting: 1 };
          const readiness = yield* checkConfidentialReadiness(tx, wallet).pipe(
            Effect.either,
          );
          if (readiness._tag === "Left") {
            if (readiness.left._tag === "DatabaseError")
              return yield* Effect.fail(readiness.left);
            console.warn(
              `[confidential-rollout] ${wallet.organizationId}: ${readiness.left.message}`,
            );
            return { enabled: 0, waiting: 1 };
          }
          yield* query(() =>
            tx
              .update(wallets)
              .set({
                balanceHome: "confidential_account",
                balanceHomeChangedAt: new Date(),
              })
              .where(eq(wallets.id, wallet.id)),
          );
          const audit = yield* AuditLog;
          yield* audit.record(tx, {
            actor: { type: "system", id: "confidential-rollout" },
            organizationId: wallet.organizationId,
            action: "wallet.balance_home_changed",
            entity: { type: "wallet", id: wallet.id },
            before: { balanceHome: "company_wallet" },
            after: {
              balanceHome: "confidential_account",
              confidentialUsdc: readiness.right,
            },
          });
          return { enabled: 1, waiting: 0 };
        }),
    );
  });
}

/** Rollbacks always resume, even when the forward-rollout switch is off. */
export function advanceBalanceHomeChanges() {
  return Effect.gen(function* () {
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<{ organization_id: string }>(
          sql`SELECT organization_id FROM confidential_move_out_wallets()`,
        ),
      ),
    );
    let errors = 0;
    for (const row of rows) {
      yield* moveOut(row.organization_id).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            errors++;
            console.error(`[move-out] ${row.organization_id}`, cause);
          }),
        ),
      );
    }
    return {
      draining: rows.length,
      errors,
      ...(yield* rolloutConfidentialAccounts()),
    };
  });
}
