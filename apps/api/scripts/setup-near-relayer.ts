/**
 * Creates the gas relayer (docs/decisions/near-main-chain.md), once per
 * environment: the one Expendi-owned Privy NEAR wallet that puts each
 * company wallet's account on chain, pays its USDC registration and pays
 * the gas for everything a company wallet sends.
 *
 * Like every company wallet, it is owned by the management key quorum and
 * the API signs for it as the runtime quorum, so both must already be in
 * the config (scripts/setup-privy-keys.ts). It holds no secret of its own:
 * nothing is written to disk, and what is printed is safe to share.
 *
 * Safe to run again: the wallet is found by its external ID rather than
 * made twice.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/setup-near-relayer.ts --env dev
 */
import "../src/secrets/bootstrap.js";

import { parseArgs } from "node:util";
import { PrivyClient } from "@privy-io/node";
import { Config, Effect, Redacted } from "effect";

import { isImplicitNearAccount } from "../src/services/chain/near.js";

const { values } = parseArgs({
  options: { env: { type: "string" } },
});
const environment = values.env;
if (!environment || !/^[a-z0-9-]+$/.test(environment)) {
  throw new Error("Pass --env <name>, e.g. --env dev or --env production");
}

const { appId, appSecret, managementQuorumId, runtimeSignerId } =
  await Effect.runPromise(
    Effect.all({
      appId: Config.string("PRIVY_APP_ID"),
      appSecret: Config.redacted("PRIVY_APP_SECRET"),
      managementQuorumId: Config.string("PRIVY_MANAGEMENT_QUORUM_ID"),
      runtimeSignerId: Config.string("PRIVY_RUNTIME_SIGNER_ID"),
    }),
  );
const privy = new PrivyClient({ appId, appSecret: Redacted.value(appSecret) });

const externalId = `near-gas-relayer-${environment}`;

async function existingRelayer() {
  for await (const wallet of privy
    .wallets()
    .list({ external_id: externalId, chain_type: "near" })) {
    return wallet;
  }
  return null;
}

const relayer =
  (await existingRelayer()) ??
  (await privy.wallets().create({
    chain_type: "near",
    external_id: externalId,
    display_name: `expendi-business-${environment}-near-gas-relayer`,
    owner_id: managementQuorumId,
    additional_signers: [{ signer_id: runtimeSignerId }],
    idempotency_key: `near-gas-relayer-${environment}`,
  }));

const signerIds = relayer.additional_signers.map((signer) => signer.signer_id);
if (
  relayer.owner_id !== managementQuorumId ||
  !signerIds.includes(runtimeSignerId) ||
  !isImplicitNearAccount(relayer.address)
) {
  throw new Error(
    `Privy wallet ${relayer.id} is not set up as a gas relayer: owner ${relayer.owner_id ?? "none"}, signers [${signerIds.join(", ")}], address ${relayer.address}`,
  );
}

console.log(`Gas relayer for "${environment}": NEAR account

  ${relayer.address}

Add to the API's config:

NEAR_RELAYER_PRIVY_WALLET_ID=${relayer.id}
NEAR_RELAYER_ACCOUNT_ID=${relayer.address}

Before the API can set up a company wallet:
- send NEAR to that account. It doesn't exist on chain until it receives
  some. Each company wallet costs it about 0.00225 NEAR once (0.001 to
  create the account, 0.00125 for its USDC registration), plus gas for
  every send.
- once it holds NEAR, register it with the USDC contract and send it the
  USDC that covers Base hop fees.`);
