import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { CardAction } from "@expendi-business/shared";
import { USDC_UNITS_PER_US_CENT } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import type { CardLoadView } from "./views.js";
import {
  cardLoads,
  cardPrograms,
  users,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, ServiceUnavailable } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { activeKesRate } from "../cash-out/active-rate.js";
import { fromMicro, kesCentsFor } from "../paycrest/amounts.js";
import { payoutsTodayKes } from "../payout/approve.js";
import { cardLoadsTodayKes, lockCardProgram } from "./balance.js";
import { cardsNotOn } from "./issue.js";
import { userActor } from "./manage.js";
import { companyControls } from "./views.js";

/**
 * A Card load (spec §6.25): money set aside for the company's Expendi cards.
 * In the sandbox it is only a `card_loads` row: it never touches the wallet's
 * ledger, payouts or Privy, and no USDC moves. It counts against the KES
 * daily cap at the active cash-out provider's rate, together with today's
 * payouts.
 */

type LoadBalance = Extract<CardAction, { type: "load_balance" }>;

interface LoadQuote {
  readonly amountKes: bigint;
  readonly rate: string;
}

function quoteLoad(
  amountUsdCents: bigint,
): Effect.Effect<
  LoadQuote,
  ServiceUnavailable | DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  return Effect.gen(function* () {
    const usdc = amountUsdCents * USDC_UNITS_PER_US_CENT;
    const rateUnavailable = Effect.fail(
      new ServiceUnavailable({
        message: "Couldn't get today's KES rate. Try again in a minute.",
      }),
    );
    const rate = yield* activeKesRate(fromMicro(usdc)).pipe(
      Effect.catchTags({
        PaycrestError: () => rateUnavailable,
        PretiumError: () => rateUnavailable,
      }),
    );
    return { rate, amountKes: kesCentsFor(usdc, rate) };
  });
}

function refuseOverCapOrPaused(
  tx: Transaction,
  organizationId: string,
  amountKes: bigint,
): Effect.Effect<void, Conflict | DatabaseError> {
  return Effect.gen(function* () {
    const { paused, dailyCapKes } = yield* companyControls(tx, organizationId);
    if (paused) {
      return yield* Effect.fail(
        new Conflict({
          message: "Card loads are paused right now. Nothing was moved.",
        }),
      );
    }
    const today =
      (yield* payoutsTodayKes(tx, organizationId)) +
      (yield* cardLoadsTodayKes(tx, organizationId));
    if (today + amountKes > dailyCapKes) {
      return yield* Effect.fail(
        new Conflict({
          message:
            "This would take today's payouts and Card loads over the company's daily cap.",
        }),
      );
    }
  });
}

/** Refuses a Card load before the passkey; loading checks again under lock. */
export function checkLoad(
  tenant: Tenant,
  action: LoadBalance,
): Effect.Effect<
  void,
  Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const quote = yield* quoteLoad(action.amountUsd);
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const [program] = yield* query(() =>
          tx
            .select({ id: cardPrograms.id })
            .from(cardPrograms)
            .where(eq(cardPrograms.organizationId, organizationId))
            .limit(1),
        );
        if (!program) return yield* Effect.fail(cardsNotOn);
        yield* refuseOverCapOrPaused(tx, organizationId, quote.amountKes);
      }),
    );
  });
}

export function loadCardBalance(
  tenant: Tenant,
  action: LoadBalance,
  approvalId: string,
): Effect.Effect<
  CardLoadView,
  Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | Paycrest | Pretium
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const quote = yield* quoteLoad(action.amountUsd);
    const audit = yield* AuditLog;

    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const program = yield* lockCardProgram(tx, organizationId);
        if (!program) return yield* Effect.fail(cardsNotOn);
        // Approvals check the daily cap holding the wallet's row lock, so a
        // Card load queues with them and the two can't both use the same room.
        yield* query(() =>
          tx
            .select({ id: wallets.id })
            .from(wallets)
            .where(
              and(
                eq(wallets.organizationId, organizationId),
                eq(wallets.status, "active"),
              ),
            )
            .for("update"),
        );
        yield* refuseOverCapOrPaused(tx, organizationId, quote.amountKes);

        const [load] = yield* query(() =>
          tx
            .insert(cardLoads)
            .values({
              organizationId,
              amountUsdCents: action.amountUsd,
              amountKes: quote.amountKes,
              usdKesRate: quote.rate,
              simulated: true,
              loadedBy: tenant.userId,
              approvalId,
            })
            .returning(),
        );
        if (!load) {
          return yield* Effect.dieMessage("card load insert returned no row");
        }
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "card_load.recorded",
          entity: { type: "card_load", id: load.id },
          after: {
            amountUsdCents: load.amountUsdCents,
            amountKes: load.amountKes,
            usdKesRate: load.usdKesRate,
            simulated: true,
            approvalId,
          },
        });

        const [loadedBy] = yield* query(() =>
          tx
            .select({ fullName: users.fullName, email: users.email })
            .from(users)
            .where(eq(users.id, tenant.userId))
            .limit(1),
        );
        return {
          id: load.id,
          amountUsdCents: load.amountUsdCents,
          amountKes: load.amountKes,
          usdKesRate: load.usdKesRate,
          simulated: load.simulated,
          loadedBy: loadedBy?.fullName ?? loadedBy?.email ?? "",
          createdAt: load.createdAt,
        };
      }),
    );
  });
}
