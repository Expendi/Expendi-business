import { desc, eq } from "drizzle-orm";
import { Effect, Option } from "effect";

import type { TreasuryOffer } from "@expendi-business/shared";
import { MIN_TREASURY_MOVE_USDC } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { PayoutRejected } from "../payout/payout-errors.js";
import { treasurySnapshots, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict } from "../../errors.js";
import { fromMicro } from "../paycrest/amounts.js";
import { PayoutRejected as PayoutRejectedError } from "../payout/payout-errors.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { earnVaultId } from "./turn-on.js";

/**
 * "The wallet is short" with money in Treasury (docs/work/treasury/spec.md,
 * section 5): a payment refused for lack of available USDC also says how
 * much is short and how much Treasury holds, and offers "Move to wallet".
 * The offer is the `treasuryOffer` of the refusal's `details`, for a client
 * to act on; nothing moves here.
 *
 * Only the refusal is touched. A company without Treasury, or with nothing in
 * it, or whose Treasury can't be read at all, gets the refusal it always got.
 */

/**
 * What Treasury holds: Privy's position now, or the last snapshot if Privy
 * can't be reached. Zero when Treasury is off or can't be told. Never fails,
 * so a refusal is never worse for it.
 */
function inTreasuryUsdc(
  organizationId: string,
): Effect.Effect<bigint, never, DatabaseService | PrivyWallets> {
  return Effect.gen(function* () {
    const vault = yield* earnVaultId;
    if (Option.isNone(vault)) return 0n;
    const { wallet, snapshot } = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [wallet] = yield* query(() =>
          tx
            .select({
              on: wallets.treasuryTurnedOnAt,
              privyWalletId: wallets.treasuryPrivyWalletId,
            })
            .from(wallets)
            .where(eq(wallets.organizationId, organizationId))
            .limit(1),
        );
        const [snapshot] = yield* query(() =>
          tx
            .select({ assetsInVault: treasurySnapshots.assetsInVault })
            .from(treasurySnapshots)
            .where(eq(treasurySnapshots.organizationId, organizationId))
            .orderBy(desc(treasurySnapshots.readAt))
            .limit(1),
        );
        return { wallet, snapshot };
      }),
    );
    if (!wallet?.on || !wallet.privyWalletId) return 0n;
    const privy = yield* PrivyWallets;
    const position = yield* privy
      .vaultPosition({
        privyWalletId: wallet.privyWalletId,
        vaultId: vault.value,
      })
      .pipe(Effect.option);
    return Option.isSome(position)
      ? position.value.assetsInVault
      : (snapshot?.assetsInVault ?? 0n);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(
          `[treasury] couldn't tell what Treasury holds for ${organizationId}`,
          error,
        );
        return 0n;
      }),
    ),
  );
}

/** The offer for a wallet short by `shortfallUsdc`, or null if Treasury holds nothing. */
export function treasuryOfferFor(
  organizationId: string,
  shortfallUsdc: bigint,
): Effect.Effect<TreasuryOffer | null, never, DatabaseService | PrivyWallets> {
  return Effect.map(inTreasuryUsdc(organizationId), (held) => {
    if (held <= 0n || shortfallUsdc <= 0n) return null;
    const covering =
      shortfallUsdc > MIN_TREASURY_MOVE_USDC
        ? shortfallUsdc
        : MIN_TREASURY_MOVE_USDC;
    return {
      action: "move_to_wallet",
      shortfallUsdc: shortfallUsdc.toString(),
      inTreasuryUsdc: held.toString(),
      suggestedUsdc: (covering < held ? covering : held).toString(),
    };
  });
}

const offerMessage = (offer: TreasuryOffer, then: string): string =>
  `The wallet is short by ${fromMicro(BigInt(offer.shortfallUsdc))} USDC and Treasury holds ${fromMicro(BigInt(offer.inTreasuryUsdc))} USDC. Use Move to wallet, then ${then}. Nothing was sent.`;

/**
 * The refusal `refusal`, with the Treasury offer when the company has money
 * in Treasury; otherwise `refusal` as it is. `then` finishes the sentence
 * "…then <approve again>".
 */
export function withTreasuryOffer(
  organizationId: string,
  shortfallUsdc: bigint,
  refusal: Conflict,
  then: string,
): Effect.Effect<Conflict, never, DatabaseService | PrivyWallets> {
  return Effect.map(treasuryOfferFor(organizationId, shortfallUsdc), (offer) =>
    offer === null
      ? refusal
      : new Conflict({
          message: offerMessage(offer, then),
          details: { ...refusal.details, treasuryOffer: offer },
        }),
  );
}

/**
 * The same for a withdrawal's refusal, which stays a `PayoutRejected` for
 * the route to turn into the client error. Anything but a shortfall passes
 * through.
 */
export function withTreasuryOfferOnRejection(
  organizationId: string,
  rejection: PayoutRejected,
  then: string,
): Effect.Effect<PayoutRejected, never, DatabaseService | PrivyWallets> {
  const { shortfallUsdc } = rejection;
  if (rejection.reason !== "insufficient_balance" || !shortfallUsdc) {
    return Effect.succeed(rejection);
  }
  return Effect.map(treasuryOfferFor(organizationId, shortfallUsdc), (offer) =>
    offer === null
      ? rejection
      : new PayoutRejectedError({
          reason: rejection.reason,
          message: offerMessage(offer, then),
          shortfallUsdc,
          details: { treasuryOffer: offer },
        }),
  );
}
