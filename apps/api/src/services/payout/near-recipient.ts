import { Effect } from "effect";

import type { NearRelayerError } from "../chain/near-relayer.js";
import type { NearRpcError } from "../chain/near-rpc.js";
import { NearRelayer } from "../chain/near-relayer.js";
import { NearRpc } from "../chain/near-rpc.js";
import { isImplicitNearAccount } from "../chain/near.js";

/**
 * Makes sure a NEAR account can hold USDC before any is sent to it: a
 * transfer to an account the USDC contract doesn't know fails, whether the
 * company wallet makes it or a NEAR Intents quote does. The gas relayer
 * creates and registers an implicit account. Returns why the payee can't be
 * paid, or null once it can.
 */
export function prepareRecipient(
  accountId: string,
): Effect.Effect<
  string | null,
  NearRpcError | NearRelayerError,
  NearRpc | NearRelayer
> {
  return Effect.gen(function* () {
    const rpc = yield* NearRpc;
    const relayer = yield* NearRelayer;
    if (yield* rpc.usdcStorageRegistered(accountId)) return null;
    if (isImplicitNearAccount(accountId)) {
      yield* relayer.activateAccount(accountId);
      return null;
    }
    return (yield* rpc.accountExists(accountId))
      ? `${accountId} can't receive USDC yet: it isn't registered with the USDC contract on NEAR. Ask the recipient to register it (receiving USDC from an exchange or a wallet does this), then pay again. Nothing was sent.`
      : `The NEAR account ${accountId} doesn't exist, and a named account can't be created for someone else. Check the account with the recipient, correct it and pay again. Nothing was sent.`;
  });
}
