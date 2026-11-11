/**
 * NEAR port spike: proves a Privy server wallet can act as a NEAR account
 * from the API, against the real Privy app in apps/api/.env.
 *
 * Signing and gas relaying run on NEAR testnet, which needs no funds from us.
 * The NEAR Intents and USDC checks are read-only calls against mainnet.
 * The wallet's owner key lives only in this process, so the wallet is
 * unusable once the script exits.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/spike-privy-near.ts
 * Results: printed, and saved to apps/api/.cache/spike-privy-near/<run>.json
 */
import "../src/secrets/bootstrap.js";

import { mkdir, writeFile } from "node:fs/promises";
import { APIError, generateP256KeyPair, PrivyClient } from "@privy-io/node";
import { Config, Effect, Redacted } from "effect";
import {
  Account,
  actions,
  JsonRpcProvider,
  KeyPair,
  nearToYocto,
  PublicKey,
  Signer,
} from "near-api-js";

const TESTNET_RPC = "https://rpc.testnet.near.org";
const MAINNET_RPC = "https://rpc.mainnet.near.org";
const TESTNET_HELPER = "https://helper.testnet.near.org/account";
const ONE_CLICK = "https://1click.chaindefuser.com";
const USDC_NEAR =
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_NEAR_ASSET = `nep141:${USDC_NEAR}`;
const USDC_BASE_ASSET =
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

interface StepResult {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: unknown;
}

const results: StepResult[] = [];

const describeError = (error: unknown): string =>
  error instanceof APIError
    ? `${String(error.status)} ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);

async function step<A>(
  name: string,
  action: () => Promise<A>,
): Promise<A | null> {
  try {
    const detail = await action();
    results.push({ step: name, ok: true, detail });
    console.log(`PASS  ${name}`, JSON.stringify(detail));
    return detail;
  } catch (error) {
    results.push({ step: name, ok: false, detail: describeError(error) });
    console.log(`FAIL  ${name}: ${describeError(error)}`);
    return null;
  }
}

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

class PrivyNearSigner extends Signer {
  constructor(
    private readonly privy: PrivyClient,
    private readonly walletId: string,
    private readonly accountId: string,
    private readonly authorizationKeys: readonly string[],
  ) {
    super();
  }

  getPublicKey(): Promise<PublicKey> {
    return Promise.resolve(
      new PublicKey({ keyType: 0, data: hexToBytes(this.accountId) }),
    );
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const signed = await this.privy.wallets().rawSign(this.walletId, {
      params: { hash: `0x${Buffer.from(bytes).toString("hex")}` },
      authorization_context: {
        authorization_private_keys: [...this.authorizationKeys],
      },
    });
    return hexToBytes(signed.signature);
  }
}

const { appId, appSecret } = await Effect.runPromise(
  Effect.all({
    appId: Config.string("PRIVY_APP_ID"),
    appSecret: Config.redacted("PRIVY_APP_SECRET"),
  }),
);

const privy = new PrivyClient({ appId, appSecret: Redacted.value(appSecret) });
const runId = `near-spike-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const suffix = Date.now().toString(36);

const management = await generateP256KeyPair();
const runtime = await generateP256KeyPair();

const wallet = await step("Privy creates a NEAR wallet", async () => {
  const managementQuorum = await privy.keyQuorums().create({
    display_name: `${runId}-management`,
    public_keys: [management.publicKey],
    authorization_threshold: 1,
  });
  const runtimeQuorum = await privy.keyQuorums().create({
    display_name: `${runId}-runtime`,
    public_keys: [runtime.publicKey],
    authorization_threshold: 1,
  });
  const created = await privy.wallets().create({
    chain_type: "near",
    display_name: runId,
    owner_id: managementQuorum.id,
    additional_signers: [{ signer_id: runtimeQuorum.id }],
  });
  if (!IMPLICIT_ACCOUNT.test(created.address)) {
    throw new Error(`Address is not a 64-hex account: ${created.address}`);
  }
  return { walletId: created.id, accountId: created.address };
});

if (!wallet) {
  throw new Error("No NEAR wallet, nothing else can run.");
}

const testnet = new JsonRpcProvider({ url: TESTNET_RPC });
const signer = new PrivyNearSigner(privy, wallet.walletId, wallet.accountId, [
  runtime.privateKey,
]);
const companyAccount = new Account(wallet.accountId, testnet, signer);

await step("Raw sign without an authorization key is refused", async () => {
  try {
    await privy.wallets().rawSign(wallet.walletId, {
      params: { hash: `0x${"11".repeat(32)}` },
    });
  } catch (error) {
    return { refused: describeError(error) };
  }
  throw new Error("Privy signed with no authorization key");
});

await step("Runtime key signature verifies as ed25519", async () => {
  const message = hexToBytes("22".repeat(32));
  const signed = await privy.wallets().rawSign(wallet.walletId, {
    params: { hash: `0x${Buffer.from(message).toString("hex")}` },
    authorization_context: {
      authorization_private_keys: [runtime.privateKey],
    },
  });
  const publicKey = await signer.getPublicKey();
  const valid = publicKey.verify(message, hexToBytes(signed.signature));
  if (!valid) throw new Error("Signature does not verify");
  return { publicKey: publicKey.toString() };
});

const relayerKey = KeyPair.fromRandom("ed25519");
const relayerId = `expendi-spike-${suffix}.testnet`;

const relayer = await step("Testnet relayer account is created", async () => {
  const response = await fetch(TESTNET_HELPER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      newAccountId: relayerId,
      newAccountPublicKey: relayerKey.getPublicKey().toString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`${String(response.status)} ${await response.text()}`);
  }
  const account = new Account(relayerId, testnet, relayerKey.toString());
  const state = await account.getState();
  return { relayerId, balance: state.balance.total.toString() };
});

if (relayer) {
  const relayerAccount = new Account(relayerId, testnet, relayerKey.toString());

  await step("Relayer funds the company account into existence", async () => {
    const sent = await relayerAccount.transfer({
      receiverId: wallet.accountId,
      amount: nearToYocto("0.05"),
    });
    return { txHash: sent.transaction.hash };
  });

  await step("Privy-signed transaction is accepted on chain", async () => {
    const started = Date.now();
    const sent = await companyAccount.signAndSendTransaction({
      receiverId: relayerId,
      actions: [actions.transfer(1n)],
    });
    return { txHash: sent.transaction.hash, ms: Date.now() - started };
  });

  await step(
    "Relayer pays gas for a Privy-signed delegate action",
    async () => {
      const before = await companyAccount.getState();
      const { signedDelegate } =
        await companyAccount.createSignedMetaTransaction({
          receiverId: relayerId,
          actions: [actions.transfer(1n)],
          blockHeightTtl: 120,
        });
      const sent = await relayerAccount.signAndSendTransaction({
        receiverId: wallet.accountId,
        actions: [actions.signedDelegate(signedDelegate)],
      });
      const after = await companyAccount.getState();
      return {
        txHash: sent.transaction.hash,
        companySpentYocto: (
          before.balance.total - after.balance.total
        ).toString(),
      };
    },
  );
}

const mainnet = new JsonRpcProvider({ url: MAINNET_RPC });

await step("USDC on NEAR storage registration rules", async () => {
  const bounds = await mainnet.callFunction({
    contractId: USDC_NEAR,
    method: "storage_balance_bounds",
    args: {},
  });
  const freshAccount = await mainnet.callFunction({
    contractId: USDC_NEAR,
    method: "storage_balance_of",
    args: { account_id: wallet.accountId },
  });
  return { bounds, freshAccountRegistered: freshAccount ?? null };
});

const dryQuote = (originAsset: string, destinationAsset: string) =>
  step(`1Click dry quote ${originAsset} to ${destinationAsset}`, async () => {
    const started = Date.now();
    const response = await fetch(`${ONE_CLICK}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dry: true,
        swapType: "EXACT_OUTPUT",
        slippageTolerance: 50,
        originAsset,
        destinationAsset,
        amount: "5000000",
        depositType: "ORIGIN_CHAIN",
        refundTo:
          originAsset === USDC_NEAR_ASSET
            ? wallet.accountId
            : "0x2a1b84c7b8dc9fac24505ab87a41b21e654017bd",
        refundType: "ORIGIN_CHAIN",
        recipient:
          destinationAsset === USDC_NEAR_ASSET
            ? wallet.accountId
            : "0x2a1b84c7b8dc9fac24505ab87a41b21e654017bd",
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`${String(response.status)} ${JSON.stringify(body)}`);
    }
    return { ms: Date.now() - started, body };
  });

await dryQuote(USDC_NEAR_ASSET, USDC_BASE_ASSET);
await dryQuote(USDC_BASE_ASSET, USDC_NEAR_ASSET);

const directory = new URL("../.cache/spike-privy-near/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL(`${runId}.json`, directory),
  JSON.stringify({ runId, wallet, results }, null, 2),
);

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${String(results.length - failed.length)}/${String(results.length)} steps passed`,
);
process.exit(failed.length === 0 ? 0 : 1);
