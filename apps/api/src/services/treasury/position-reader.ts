import { Context, Data, Effect, Option } from "effect";

import type {
  PrivyWalletError,
  VaultPosition,
} from "../wallet/privy-wallets.js";

/**
 * Privy's live vault position for the staff app, and nothing else.
 *
 * Staff routes may never reach `privy-wallets.ts`, which can sign and send,
 * so they read the position through this narrow service instead (the staff
 * route guard in `internal-routes.test.ts` follows value imports). Its live
 * layer is built from the full Privy service in `layers/main.ts`, which no
 * route imports, and exposes only `vaultPosition`.
 */

export class PositionUnavailable extends Data.TaggedError(
  "PositionUnavailable",
)<{ readonly message: string }> {}

export interface TreasuryPositionReaderShape {
  readonly read: (
    privyWalletId: string,
  ) => Effect.Effect<VaultPosition, PositionUnavailable>;
}

export class TreasuryPositionReader extends Context.Tag(
  "TreasuryPositionReader",
)<TreasuryPositionReader, TreasuryPositionReaderShape>() {}

/** What Privy can read of a Treasury wallet's position, given how to read it. */
export function positionReaderFrom(
  vaultId: Option.Option<string>,
  vaultPosition: (input: {
    readonly privyWalletId: string;
    readonly vaultId: string;
  }) => Effect.Effect<VaultPosition, PrivyWalletError>,
): TreasuryPositionReaderShape {
  return {
    read: (privyWalletId) =>
      Option.isNone(vaultId)
        ? Effect.fail(
            new PositionUnavailable({
              message: "No Earn vault is configured.",
            }),
          )
        : vaultPosition({ privyWalletId, vaultId: vaultId.value }).pipe(
            Effect.mapError(
              (error) => new PositionUnavailable({ message: error.message }),
            ),
          ),
  };
}
