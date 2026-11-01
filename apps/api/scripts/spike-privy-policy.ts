/**
 * T5 spike (EXP-273): proves which Privy wallet-policy conditions are
 * enforced, against the real Privy app in apps/api/.env.
 *
 * Every transaction is only signed (`eth_signTransaction`), never broadcast,
 * so the throwaway wallet needs no funds. The wallet's owner key lives only
 * in this process, so the wallet is unusable once the script exits.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/spike-privy-policy.ts
 * Results: printed, and saved to apps/api/.cache/spike-privy-policy/<run>.json
 * Findings: docs/decisions/privy-wallet-policies.md
 */
import "../src/secrets/bootstrap.js";

import type { P256KeyPair } from "@privy-io/node";
import type { AbiSchema, PolicyCondition } from "@privy-io/node/resources";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { APIError, generateP256KeyPair, PrivyClient } from "@privy-io/node";
import { Config, Effect, Redacted } from "effect";

const PRIVY_API_URL = "https://api.privy.io";
const BASE_CHAIN_ID = 8453;
const ETHEREUM_CHAIN_ID = 1;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_BASE = "0x4200000000000000000000000000000000000006";

const USDC = 1_000_000n;
const CAP = 1_000n * USDC;
const LOWERED_CAP = 500n * USDC;
const CAP_RULE_NAME = "usdc-base-any-recipient-capped";
/** Policy changes are not guaranteed to apply instantly. */
const POLICY_PROPAGATION_MS = 3_000;

const ERC20_ABI: AbiSchema = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

type Hex = `0x${string}`;
type Outcome = "allowed" | "rejected";
type Expectation = Outcome | "observe";

interface CaseResult {
  readonly step: string;
  readonly expected: Expectation;
  readonly outcome: Outcome;
  readonly status?: number;
  readonly detail: string;
}

const { appId, appSecret } = await Effect.runPromise(
  Effect.all({
    appId: Config.string("PRIVY_APP_ID"),
    appSecret: Config.redacted("PRIVY_APP_SECRET"),
  }),
);

const privy = new PrivyClient({ appId, appSecret: Redacted.value(appSecret) });
const runId = `t5-spike-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const results: CaseResult[] = [];

const hex = (value: bigint): Hex => `0x${value.toString(16)}`;
const word = (value: string): string => value.padStart(64, "0");
const randomAddress = (): Hex => `0x${randomBytes(20).toString("hex")}`;
const addressWord = (address: string): string =>
  word(address.slice(2).toLowerCase());

const erc20 = {
  transfer: (to: string, amount: bigint): Hex =>
    `0xa9059cbb${addressWord(to)}${word(amount.toString(16))}`,
  approve: (spender: string, amount: bigint): Hex =>
    `0x095ea7b3${addressWord(spender)}${word(amount.toString(16))}`,
  transferFrom: (from: string, to: string, amount: bigint): Hex =>
    `0x23b872dd${addressWord(from)}${addressWord(to)}${word(amount.toString(16))}`,
};

const conditions = {
  usdcOnBase: [
    {
      field_source: "ethereum_transaction",
      field: "to",
      operator: "eq",
      value: USDC_BASE,
    },
    {
      field_source: "ethereum_transaction",
      field: "chain_id",
      operator: "eq",
      value: String(BASE_CHAIN_ID),
    },
  ] satisfies PolicyCondition[],
  amountAtMost: (cap: string): PolicyCondition => ({
    field_source: "ethereum_calldata",
    field: "transfer.amount",
    abi: ERC20_ABI,
    operator: "lte",
    value: cap,
  }),
  recipientIn: (conditionSetId: string): PolicyCondition => ({
    field_source: "ethereum_calldata",
    field: "transfer.recipient",
    abi: ERC20_ABI,
    operator: "in_condition_set",
    value: conditionSetId,
  }),
};

const describeError = (error: unknown): { status?: number; detail: string } =>
  error instanceof APIError
    ? {
        status: typeof error.status === "number" ? error.status : undefined,
        detail: error.message,
      }
    : { detail: error instanceof Error ? error.message : String(error) };

async function attempt(
  step: string,
  expected: Expectation,
  action: () => Promise<unknown>,
): Promise<void> {
  let result: CaseResult;
  try {
    await action();
    result = { step, expected, outcome: "allowed", detail: "ok" };
  } catch (error) {
    result = { step, expected, outcome: "rejected", ...describeError(error) };
  }
  results.push(result);
  const verdict =
    expected === "observe"
      ? "OBSERVE"
      : expected === result.outcome
        ? "PASS"
        : "FAIL";
  console.log(
    `${verdict.padEnd(7)} ${result.outcome.padEnd(8)} ${step}${result.outcome === "rejected" ? `\n                 ${result.status ?? "-"} ${result.detail}` : ""}`,
  );
}

/**
 * Raw REST for condition sets, which SDK 0.37 can only list. A request
 * without a body is signed over "" and must not send a JSON content type,
 * or Privy rejects the signature.
 */
async function privyRest<T>(
  method: "POST" | "DELETE",
  path: string,
  body: unknown,
  signers: readonly P256KeyPair[] = [],
): Promise<T> {
  const url = `${PRIVY_API_URL}${path}`;
  const signatures = signers.map((key) =>
    privy
      .utils()
      .requestSigner()
      .generateAuthorizationSignature({
        authorizationPrivateKey: key.privateKey,
        input: {
          version: 1,
          method,
          url,
          body: body ?? "",
          headers: { "privy-app-id": appId },
        },
      }),
  );
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${Redacted.value(appSecret)}`).toString("base64")}`,
      "privy-app-id": appId,
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(signatures.length > 0 && {
        "privy-authorization-signature": signatures.join(","),
      }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${text}`);
  }
  return JSON.parse(text) as T;
}

const management = await generateP256KeyPair();
const runtime = await generateP256KeyPair();

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

const allowlisted = randomAddress();
const notYetAllowlisted = randomAddress();
const stranger = randomAddress();

const allowlist = await privyRest<{ id: string }>(
  "POST",
  "/v1/condition_sets",
  { name: `${runId}-allowlist`, owner_id: managementQuorum.id },
);
await privyRest(
  "POST",
  `/v1/condition_sets/${allowlist.id}/condition_set_items`,
  [{ value: allowlisted }],
  [management],
);

const policy = await privy.policies().create({
  chain_type: "ethereum",
  version: "1.0",
  name: `${runId}-policy`,
  owner_id: managementQuorum.id,
  rules: [
    {
      name: CAP_RULE_NAME,
      method: "eth_signTransaction",
      action: "ALLOW",
      conditions: [...conditions.usdcOnBase, conditions.amountAtMost(hex(CAP))],
    },
    {
      name: "usdc-base-allowlisted-recipient",
      method: "eth_signTransaction",
      action: "ALLOW",
      conditions: [
        ...conditions.usdcOnBase,
        conditions.recipientIn(allowlist.id),
      ],
    },
  ],
});
const capRule = policy.rules.find((rule) => rule.name === CAP_RULE_NAME);
if (!capRule) throw new Error("Cap rule missing from created policy");

const wallet = await privy.wallets().create({
  chain_type: "ethereum",
  display_name: runId,
  owner_id: managementQuorum.id,
  policy_ids: [policy.id],
  additional_signers: [{ signer_id: runtimeQuorum.id }],
});

console.log(`run ${runId}`);
console.log(`wallet ${wallet.id} ${wallet.address}`);
console.log(`policy ${policy.id}, allowlist ${allowlist.id}`);
console.log(
  `quorums management ${managementQuorum.id}, runtime ${runtimeQuorum.id}\n`,
);

interface TxOverrides {
  readonly chainId?: number;
  readonly value?: bigint;
}

const sign = (
  to: string,
  data: Hex,
  signers: readonly P256KeyPair[],
  overrides: TxOverrides = {},
) =>
  privy
    .wallets()
    .ethereum()
    .signTransaction(wallet.id, {
      params: {
        transaction: {
          type: 2,
          chain_id: overrides.chainId ?? BASE_CHAIN_ID,
          to,
          data,
          value: hex(overrides.value ?? 0n),
          nonce: 0,
          gas_limit: hex(100_000n),
          max_fee_per_gas: hex(1_000_000_000n),
          max_priority_fee_per_gas: hex(1_000_000n),
        },
      },
      authorization_context: {
        authorization_private_keys: signers.map((key) => key.privateKey),
      },
    });

const asRuntime = (to: string, data: Hex, overrides?: TxOverrides) =>
  sign(to, data, [runtime], overrides);

console.log("— Cap rule (hex value), runtime signer —");
await attempt("USDC 1,000 (at the cap)", "allowed", () =>
  asRuntime(USDC_BASE, erc20.transfer(stranger, CAP)),
);
await attempt("USDC 1,000.000001 (one unit over)", "rejected", () =>
  asRuntime(USDC_BASE, erc20.transfer(stranger, CAP + 1n)),
);
await attempt(
  "USDC 0.000005 (string compare would read 0x5 > 0x3b9aca00)",
  "allowed",
  () => asRuntime(USDC_BASE, erc20.transfer(stranger, 5n)),
);
await attempt("USDC 999.999999", "allowed", () =>
  asRuntime(USDC_BASE, erc20.transfer(stranger, CAP - 1n)),
);
await attempt("USDC 50,000 to a non-allowlisted address", "rejected", () =>
  asRuntime(USDC_BASE, erc20.transfer(stranger, 50_000n * USDC)),
);
await attempt("USDC 10 with the contract address in lowercase", "observe", () =>
  asRuntime(USDC_BASE.toLowerCase(), erc20.transfer(stranger, 10n * USDC)),
);

console.log("\n— Anything that isn't a USDC transfer on Base —");
await attempt("USDC approve(stranger, 10)", "rejected", () =>
  asRuntime(USDC_BASE, erc20.approve(stranger, 10n * USDC)),
);
await attempt("USDC transferFrom(stranger, stranger, 10)", "rejected", () =>
  asRuntime(USDC_BASE, erc20.transferFrom(stranger, stranger, 10n * USDC)),
);
await attempt("WETH transfer of 10 base units", "rejected", () =>
  asRuntime(WETH_BASE, erc20.transfer(stranger, 10n)),
);
await attempt("Native ETH, 1 wei", "rejected", () =>
  asRuntime(stranger, "0x", { value: 1n }),
);
await attempt("Call to the USDC contract with empty calldata", "rejected", () =>
  asRuntime(USDC_BASE, "0x"),
);
await attempt(
  "USDC 10 with chain ID 1 (Ethereum) instead of Base",
  "rejected",
  () =>
    asRuntime(USDC_BASE, erc20.transfer(stranger, 10n * USDC), {
      chainId: ETHEREUM_CHAIN_ID,
    }),
);

console.log("\n— Allowlist rule (condition set) —");
await attempt("USDC 50,000 to the allowlisted address", "allowed", () =>
  asRuntime(USDC_BASE, erc20.transfer(allowlisted, 50_000n * USDC)),
);
await attempt("USDC 50,000 to an address not yet allowlisted", "rejected", () =>
  asRuntime(USDC_BASE, erc20.transfer(notYetAllowlisted, 50_000n * USDC)),
);

console.log("\n— Who can sign —");
await attempt("App secret alone, USDC 10", "rejected", () =>
  sign(USDC_BASE, erc20.transfer(stranger, 10n * USDC), []),
);
await attempt("Management (owner) key, USDC 10", "allowed", () =>
  sign(USDC_BASE, erc20.transfer(stranger, 10n * USDC), [management]),
);
await attempt("Management (owner) key, USDC over the cap", "rejected", () =>
  sign(USDC_BASE, erc20.transfer(stranger, CAP + 1n), [management]),
);

console.log("\n— What the runtime signer can't change —");
const raisedCapRule = {
  policy_id: policy.id,
  name: capRule.name,
  method: capRule.method,
  action: capRule.action,
  conditions: [
    ...conditions.usdcOnBase,
    conditions.amountAtMost(hex(1_000_000n * USDC)),
  ],
};
await attempt("Runtime key raises the cap", "rejected", () =>
  privy.policies().updateRule(capRule.id, {
    ...raisedCapRule,
    authorization_context: { authorization_private_keys: [runtime.privateKey] },
  }),
);
await attempt("App secret alone raises the cap", "rejected", () =>
  privy.policies().updateRule(capRule.id, raisedCapRule),
);
await attempt("Runtime key adds an address to the allowlist", "rejected", () =>
  privyRest(
    "POST",
    `/v1/condition_sets/${allowlist.id}/condition_set_items`,
    [{ value: stranger }],
    [runtime],
  ),
);
await attempt("Runtime key removes the wallet's policy", "rejected", () =>
  privy.wallets().update(wallet.id, {
    policy_ids: [],
    authorization_context: { authorization_private_keys: [runtime.privateKey] },
  }),
);
await attempt("Runtime key exports the private key", "rejected", () =>
  privy.wallets().exportPrivateKey(wallet.id, {
    authorization_context: { authorization_private_keys: [runtime.privateKey] },
  }),
);

console.log("\n— Management key updates the policy through the API —");
await attempt(
  `Management key lowers the cap to 500 USDC, as a decimal string`,
  "allowed",
  () =>
    privy.policies().updateRule(capRule.id, {
      ...raisedCapRule,
      conditions: [
        ...conditions.usdcOnBase,
        conditions.amountAtMost(LOWERED_CAP.toString()),
      ],
      authorization_context: {
        authorization_private_keys: [management.privateKey],
      },
    }),
);
await sleep(POLICY_PROPAGATION_MS);
await attempt("USDC 500 (at the new cap)", "allowed", () =>
  asRuntime(USDC_BASE, erc20.transfer(stranger, LOWERED_CAP)),
);
await attempt("USDC 500.000001", "rejected", () =>
  asRuntime(USDC_BASE, erc20.transfer(stranger, LOWERED_CAP + 1n)),
);
await attempt(
  "USDC 60 (string compare would read '60000000' > '500000000')",
  "allowed",
  () => asRuntime(USDC_BASE, erc20.transfer(stranger, 60n * USDC)),
);
await attempt("USDC 999.999999 (allowed under the old cap)", "rejected", () =>
  asRuntime(USDC_BASE, erc20.transfer(stranger, CAP - 1n)),
);

let addedItemId: string | undefined;
await attempt(
  "Management key allowlists a new address",
  "allowed",
  async () => {
    const added = await privyRest<{ id: string; value: string }[]>(
      "POST",
      `/v1/condition_sets/${allowlist.id}/condition_set_items`,
      [{ value: notYetAllowlisted }],
      [management],
    );
    addedItemId = added.find(
      (item) => item.value.toLowerCase() === notYetAllowlisted,
    )?.id;
  },
);
await sleep(POLICY_PROPAGATION_MS);
await attempt("USDC 50,000 to the newly allowlisted address", "allowed", () =>
  asRuntime(USDC_BASE, erc20.transfer(notYetAllowlisted, 50_000n * USDC)),
);
await attempt("Management key removes that address", "allowed", async () => {
  if (!addedItemId) throw new Error("No item ID returned when adding");
  await privyRest(
    "DELETE",
    `/v1/condition_sets/${allowlist.id}/condition_set_items/${addedItemId}`,
    undefined,
    [management],
  );
});
await sleep(POLICY_PROPAGATION_MS);
await attempt("USDC 50,000 to the removed address", "rejected", () =>
  asRuntime(USDC_BASE, erc20.transfer(notYetAllowlisted, 50_000n * USDC)),
);

const failures = results.filter(
  (result) =>
    result.expected !== "observe" && result.expected !== result.outcome,
);
const report = {
  runId,
  ranAt: new Date().toISOString(),
  sdk: "@privy-io/node 0.37.0",
  method: "eth_signTransaction",
  resources: {
    walletId: wallet.id,
    walletAddress: wallet.address,
    policyId: policy.id,
    conditionSetId: allowlist.id,
    managementQuorumId: managementQuorum.id,
    runtimeQuorumId: runtimeQuorum.id,
  },
  results,
  failures: failures.length,
};
const reportDir = new URL("../.cache/spike-privy-policy/", import.meta.url);
await mkdir(reportDir, { recursive: true });
await writeFile(
  new URL(`${runId}.json`, reportDir),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(
  `\n${results.length} steps, ${failures.length} not as expected. Report: apps/api/.cache/spike-privy-policy/${runId}.json`,
);
process.exitCode = failures.length > 0 ? 1 : 0;
