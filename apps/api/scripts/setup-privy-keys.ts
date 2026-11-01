/**
 * Creates the two Privy key quorums every company wallet depends on
 * (docs/decisions/privy-wallet-policies.md), once per environment:
 *
 * - management: owns every wallet and policy. Its private key must live
 *   outside the API (an ops store), or the API could lift its own limits.
 * - runtime: the API's signer, bound by each wallet's policy. Its private key
 *   goes in the API's Doppler config.
 *
 * Private keys are written only to a git-ignored file readable by you
 * (mode 0600), never printed. Move them to their stores, then delete it.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/setup-privy-keys.ts --env dev
 */
import "../src/secrets/bootstrap.js";

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { generateP256KeyPair, PrivyClient } from "@privy-io/node";
import { Config, Effect, Redacted } from "effect";

const { values } = parseArgs({
  options: { env: { type: "string" } },
});
const environment = values.env;
if (!environment || !/^[a-z0-9-]+$/.test(environment)) {
  throw new Error("Pass --env <name>, e.g. --env dev or --env production");
}

const { appId, appSecret } = await Effect.runPromise(
  Effect.all({
    appId: Config.string("PRIVY_APP_ID"),
    appSecret: Config.redacted("PRIVY_APP_SECRET"),
  }),
);
const privy = new PrivyClient({ appId, appSecret: Redacted.value(appSecret) });

const [management, runtime] = await Promise.all([
  generateP256KeyPair(),
  generateP256KeyPair(),
]);
const managementQuorum = await privy.keyQuorums().create({
  display_name: `expendi-business-${environment}-management`,
  public_keys: [management.publicKey],
  authorization_threshold: 1,
});
const runtimeQuorum = await privy.keyQuorums().create({
  display_name: `expendi-business-${environment}-runtime`,
  public_keys: [runtime.publicKey],
  authorization_threshold: 1,
});

const dir = new URL("../.cache/privy-keys/", import.meta.url);
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = new URL(`${environment}-${Date.now()}.json`, dir);
await writeFile(
  file,
  `${JSON.stringify(
    {
      environment,
      privyAppId: appId,
      management: {
        quorumId: managementQuorum.id,
        publicKey: management.publicKey,
        privateKey: management.privateKey,
        store: "Ops only. Never in the API's environment or Doppler config.",
      },
      runtime: {
        quorumId: runtimeQuorum.id,
        publicKey: runtime.publicKey,
        privateKey: runtime.privateKey,
        store: "API Doppler config as PRIVY_RUNTIME_AUTHORIZATION_KEY.",
      },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
await chmod(file, 0o600);

console.log(`Key quorums created for "${environment}". Add to the API's config:

PRIVY_MANAGEMENT_QUORUM_ID=${managementQuorum.id}
PRIVY_RUNTIME_SIGNER_ID=${runtimeQuorum.id}

Private keys were written to ${file.pathname} (mode 0600):
- runtime → the API's Doppler config as PRIVY_RUNTIME_AUTHORIZATION_KEY
- management → an ops-only store with an offline backup; never the API
Delete the file once both are stored.`);
