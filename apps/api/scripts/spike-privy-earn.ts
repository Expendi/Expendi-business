/**
 * Treasury spike (docs/work/treasury/spec.md, section 12): proves that a
 * Treasury wallet on Base can put USDC into the configured Privy Earn vault
 * and take it out with the runtime key alone, and that its policy refuses
 * everything else. Runs against the real Privy app and Base mainnet, with
 * real USDC.
 *
 * Every step is keyed by --run and saved once done, so running it again with
 * the same --run resumes and never deposits or withdraws twice:
 *
 * 1. First run: creates the Treasury wallet and a wallet with the transit
 *    policy, prints the Treasury wallet's address and stops.
 * 2. Send that address USDC on Base, then run again: refusal checks, the
 *    deposit, replay checks, the position, the full withdrawal.
 * 3. Run again with --return-to <address>: sends back what is left, at most
 *    the spike's 1 USDC cap per run.
 *
 * Section 12 item 9 (the 1Click legs) is not covered here.
 *
 * Run: doppler run -p expendi-business -c stg -- \
 *        pnpm --filter @expendi-business/api exec tsx scripts/spike-privy-earn.ts \
 *        --run 1 --vault-id <id> [--usdc 1] [--return-to 0x…]
 * Results: printed, and saved to apps/api/.cache/spike-privy-earn/<run>.json
 */
import "../src/secrets/bootstrap.js";

import type { PolicyCreateParams, Wallets } from "@privy-io/node/resources";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { APIError, PrivyClient } from "@privy-io/node";
import { Config, Effect, Redacted } from "effect";

import {
  BASE_CHAIN_ID,
  USDC_BASE_ADDRESS,
  usdcTransferCalldata,
} from "../src/services/chain/base.js";
import { companyWalletPolicyRules } from "../src/services/wallet/wallet-policy.js";

const { values } = parseArgs({
  options: {
    run: { type: "string" },
    "vault-id": { type: "string" },
    usdc: { type: "string", default: "1" },
    "return-to": { type: "string" },
  },
});

const run = values.run;
if (!run || !/^[a-z0-9-]+$/.test(run)) {
  throw new Error("Pass --run <label> (lowercase letters, digits and -)");
}
const vaultId = values["vault-id"] ?? "";
if (vaultId === "") throw new Error("Pass --vault-id <Privy Earn vault ID>");
const returnTo = values["return-to"];
if (returnTo !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(returnTo)) {
  throw new Error(`Not a Base address: ${returnTo}`);
}

type WalletActionResponse = Wallets.WalletActionResponse;

const USDC = 1_000_000n;
/** Small, so the over-cap check costs nothing if Privy wrongly allows it. */
const SPIKE_CAP = USDC;
const ACTION_POLL_MS = 3_000;
const ACTION_TIMEOUT_MS = 5 * 60_000;
const POSITION_POLL_MS = 10_000;
const POSITION_TIMEOUT_MS = 60_000;
const NOT_THE_VAULT = "spikenotarealvaultid0000";
const PROBE = 10_000n;

const toBaseUnits = (usdc: string): bigint => {
  if (!/^\d+(\.\d{1,6})?$/.test(usdc)) {
    throw new Error(`Not a USDC amount: ${usdc}`);
  }
  const [whole = "0", fraction = ""] = usdc.split(".");
  return BigInt(whole) * USDC + BigInt(fraction.padEnd(6, "0"));
};
const toUsdc = (units: bigint): string =>
  `${(units / USDC).toString()}.${(units % USDC).toString().padStart(6, "0")}`;
const maxDeposit = toBaseUnits(values.usdc);

const settings = await Effect.runPromise(
  Effect.all({
    appId: Config.string("PRIVY_APP_ID"),
    appSecret: Config.redacted("PRIVY_APP_SECRET"),
    managementQuorumId: Config.string("PRIVY_MANAGEMENT_QUORUM_ID"),
    runtimeSignerId: Config.string("PRIVY_RUNTIME_SIGNER_ID"),
    runtimeKey: Config.redacted("PRIVY_RUNTIME_AUTHORIZATION_KEY"),
    baseRpcUrl: Config.redacted("BASE_RPC_URL"),
  }),
);

const privy = new PrivyClient({
  appId: settings.appId,
  appSecret: Redacted.value(settings.appSecret),
});
const asRuntime = {
  authorization_private_keys: [Redacted.value(settings.runtimeKey)],
};
const earn = () => privy.wallets().earn().ethereum();

// ── Saved progress ──────────────────────────────────────────────────────

type Verdict = "PASS" | "FAIL" | "CHECK" | "OBSERVE";

interface Check {
  /** The item in spec section 12 this answers. */
  readonly item: number;
  readonly step: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

interface SpikeWallet {
  readonly walletId: string;
  readonly address: string;
  readonly policyId: string;
}

interface PositionRead {
  readonly secondsAfterDeposit: number;
  readonly assetsInVault: string;
  readonly sharesInVault: string;
  readonly totalDeposited: string;
  readonly totalWithdrawn: string;
  readonly apyBps: number | null;
}

interface SpikeState {
  readonly run: string;
  readonly vaultId: string;
  vault?: unknown;
  treasury?: SpikeWallet;
  transit?: SpikeWallet;
  depositActionId?: string;
  depositAction?: WalletActionResponse;
  positionsAfterDeposit: PositionRead[];
  withdrawActionId?: string;
  withdrawAction?: WalletActionResponse;
  positionAfterWithdrawal?: PositionRead;
  otherVault?: SpikeWallet;
  probesDone?: boolean;
  returnTxHashes: string[];
  checks: Check[];
}

const cacheDir = new URL("../.cache/spike-privy-earn/", import.meta.url);
const statePath = new URL(`${run}.json`, cacheDir);

const loadState = async (): Promise<SpikeState> => {
  try {
    const saved = JSON.parse(await readFile(statePath, "utf8")) as SpikeState;
    if (saved.vaultId !== vaultId) {
      throw new Error(
        `Run ${run} used vault ${saved.vaultId}; start a new --run for ${vaultId}`,
      );
    }
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      run,
      vaultId,
      positionsAfterDeposit: [],
      returnTxHashes: [],
      checks: [],
    };
  }
};

const state = await loadState();

const save = async (): Promise<void> => {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
};

const record = (check: Check): void => {
  const at = state.checks.findIndex(
    (saved) => saved.item === check.item && saved.step === check.step,
  );
  if (at === -1) state.checks.push(check);
  else state.checks[at] = check;
  console.log(
    `${check.verdict.padEnd(7)} [${check.item}] ${check.step}\n          ${check.detail}`,
  );
};

const fact = (item: number, step: string, holds: boolean, detail: string) =>
  record({ item, step, verdict: holds ? "PASS" : "FAIL", detail });

const describeError = (error: unknown): string =>
  error instanceof APIError
    ? `${String(error.status ?? "-")} ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);

const summarize = (value: unknown): string => {
  if (value && typeof value === "object" && "id" in value) {
    const { id, status } = value as { id: string; status?: string };
    return `allowed: ${id}${status === undefined ? "" : ` ${status}`}`;
  }
  return `allowed: ${JSON.stringify(value).slice(0, 300)}`;
};

/**
 * A refusal passes only when Privy's message gives the expected reason, by
 * default a policy: a refusal for any other reason (an unknown vault, no
 * balance) proves nothing about it.
 */
async function attempt<T>(
  item: number,
  step: string,
  expected: "allowed" | "refused",
  action: () => Promise<T>,
  because = /polic/i,
): Promise<T | undefined> {
  try {
    const value = await action();
    record({
      item,
      step,
      verdict: expected === "allowed" ? "PASS" : "FAIL",
      detail: summarize(value),
    });
    return value;
  } catch (error) {
    const detail = describeError(error);
    const verdict: Verdict =
      expected === "allowed" ? "FAIL" : because.test(detail) ? "PASS" : "CHECK";
    record({ item, step, verdict, detail: `refused: ${detail}` });
    return undefined;
  }
}

// ── Base reads ──────────────────────────────────────────────────────────

async function rpc<T>(method: string, params: readonly unknown[]): Promise<T> {
  const response = await fetch(Redacted.value(settings.baseRpcUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (body.error || body.result === undefined) {
    throw new Error(
      `Base RPC ${method}: ${body.error?.message ?? "no result"}`,
    );
  }
  return body.result;
}

const word = (hex: string): string => hex.toLowerCase().padStart(64, "0");

const balances = async (address: string) => ({
  usdc: BigInt(
    await rpc<string>("eth_call", [
      { to: USDC_BASE_ADDRESS, data: `0x70a08231${word(address.slice(2))}` },
      "latest",
    ]),
  ),
  eth: BigInt(await rpc<string>("eth_getBalance", [address, "latest"])),
});

async function awaitReceipt(txHash: string): Promise<boolean | null> {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await rpc<{ status: string } | null>(
      "eth_getTransactionReceipt",
      [txHash],
    ).catch(() => null);
    if (receipt) return receipt.status === "0x1";
    await sleep(ACTION_POLL_MS);
  }
  return null;
}

// ── Privy ───────────────────────────────────────────────────────────────

const earnRule = (
  method: "earn_deposit" | "earn_withdraw",
  vault: string,
): PolicyCreateParams.Rule => ({
  name: `${method.replace("_", "-")}-one-vault`,
  method,
  action: "ALLOW",
  conditions: [
    {
      field_source: "action_request_body",
      field: "vault_id",
      operator: "eq",
      value: vault,
    },
  ],
});

const treasuryPolicyRules = (
  vault: string,
  cap: bigint,
): PolicyCreateParams.Rule[] => [
  earnRule("earn_deposit", vault),
  earnRule("earn_withdraw", vault),
  ...companyWalletPolicyRules(cap),
];

async function ensureWallet(
  externalId: string,
  rules: PolicyCreateParams.Rule[],
): Promise<SpikeWallet> {
  let wallet = null;
  for await (const found of privy
    .wallets()
    .list({ external_id: externalId, chain_type: "ethereum" })) {
    wallet = found;
    break;
  }
  if (!wallet) {
    const policy = await privy.policies().create({
      chain_type: "ethereum",
      version: "1.0",
      name: externalId,
      owner_id: settings.managementQuorumId,
      rules,
      idempotency_key: `${externalId}-policy`,
    });
    wallet = await privy.wallets().create({
      chain_type: "ethereum",
      external_id: externalId,
      display_name: externalId,
      owner_id: settings.managementQuorumId,
      policy_ids: [policy.id],
      additional_signers: [{ signer_id: settings.runtimeSignerId }],
      idempotency_key: `${externalId}-wallet`,
    });
  }
  const [policyId] = wallet.policy_ids;
  const signers = wallet.additional_signers.map((signer) => signer.signer_id);
  if (
    wallet.owner_id !== settings.managementQuorumId ||
    wallet.policy_ids.length !== 1 ||
    policyId === undefined ||
    signers.length !== 1 ||
    signers[0] !== settings.runtimeSignerId
  ) {
    throw new Error(
      `Wallet ${wallet.id} (${externalId}) doesn't have the owner, policy and signer this spike sets`,
    );
  }
  return { walletId: wallet.id, address: wallet.address, policyId };
}

const deposit = (
  walletId: string,
  vault: string,
  rawAmount: bigint,
  referenceId: string,
  idempotencyKey = referenceId,
) =>
  earn().deposit(walletId, {
    vault_id: vault,
    raw_amount: rawAmount.toString(),
    reference_id: referenceId,
    idempotency_key: idempotencyKey,
    authorization_context: asRuntime,
  });

const sendUsdcCall = (walletId: string, data: string, idempotencyKey: string) =>
  privy
    .wallets()
    .ethereum()
    .sendTransaction(walletId, {
      caip2: `eip155:${BASE_CHAIN_ID}`,
      sponsor: true,
      params: {
        transaction: { to: USDC_BASE_ADDRESS, data, chain_id: BASE_CHAIN_ID },
      },
      idempotency_key: idempotencyKey,
      authorization_context: asRuntime,
    });

const approveCalldata = (spender: string, amount: bigint): string =>
  `0x095ea7b3${word(spender.slice(2))}${word(amount.toString(16))}`;

async function awaitAction(
  walletId: string,
  actionId: string,
): Promise<WalletActionResponse> {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  for (;;) {
    const action = await privy
      .wallets()
      .actions.get(actionId, { wallet_id: walletId, include: "steps" });
    if (action.status !== "pending" || Date.now() > deadline) return action;
    await sleep(ACTION_POLL_MS);
  }
}

const describeAction = (action: WalletActionResponse): string => {
  const hashes = (action.steps ?? [])
    .map((step) =>
      step.type === "evm_transaction"
        ? `${step.status} https://basescan.org/tx/${step.transaction_hash ?? "?"}`
        : step.type === "evm_user_operation"
          ? `user operation ${step.status} https://basescan.org/tx/${step.bundle_transaction_hash ?? "?"}`
          : `${step.type} ${step.status}`,
    )
    .join("; ");
  const failure =
    "failure_reason" in action && action.failure_reason
      ? ` failure: ${JSON.stringify(action.failure_reason)}`
      : "";
  return `${action.id} ${action.status}${failure}${hashes ? ` steps: ${hashes}` : ""}`;
};

const readPosition = async (
  walletId: string,
  depositedAt: number,
): Promise<PositionRead> => {
  const position: Wallets.EthereumEarnPositionResponse =
    await earn().vaultPosition(walletId, { vault_id: vaultId });
  return {
    secondsAfterDeposit: Math.round((Date.now() - depositedAt) / 1000),
    assetsInVault: position.assets_in_vault,
    sharesInVault: position.shares_in_vault,
    totalDeposited: position.total_deposited,
    totalWithdrawn: position.total_withdrawn,
    apyBps: position.apy_bps ?? null,
  };
};

// ── The spike ───────────────────────────────────────────────────────────

const vault = await earn().vaultDetails(vaultId);
state.vault = vault;
console.log(`Run ${run}, vault ${vault.name} (${vault.provider})`);
console.log(
  `  ${vault.asset.symbol} ${vault.caip2} ${vault.vault_address}, user APY ${String(vault.user_apy)} bps, Expendi's share ${String(vault.app_apy)} bps, liquidity ${String(vault.available_liquidity_usd)} USD`,
);
if (
  vault.caip2 !== `eip155:${BASE_CHAIN_ID}` ||
  vault.asset.address.toLowerCase() !== USDC_BASE_ADDRESS.toLowerCase()
) {
  await save();
  throw new Error("This spike only covers a USDC vault on Base");
}
fact(8, "vaultDetails(vaultId) in SDK 0.37.0", true, vault.id);

state.treasury ??= await ensureWallet(
  `spike-treasury-${run}`,
  treasuryPolicyRules(vaultId, SPIKE_CAP),
);
state.transit ??= await ensureWallet(
  `spike-transit-${run}`,
  companyWalletPolicyRules(SPIKE_CAP),
);
await save();
const { treasury, transit } = state;
console.log(`Treasury wallet ${treasury.walletId} ${treasury.address}`);
console.log(`Transit-policy wallet ${transit.walletId} ${transit.address}\n`);

if (!state.depositActionId) {
  const before = await balances(treasury.address);
  if (before.usdc === 0n) {
    await save();
    console.log(
      `Send up to ${toUsdc(maxDeposit)} USDC on Base to ${treasury.address}, then run again with --run ${run}.`,
    );
    process.exit(0);
  }
  const amount = before.usdc < maxDeposit ? before.usdc : maxDeposit;
  fact(4, "No ETH before the deposit", before.eth === 0n, `${before.eth} wei`);

  await attempt(2, "Earn deposit to another vault ID", "refused", () =>
    deposit(
      treasury.walletId,
      NOT_THE_VAULT,
      amount,
      `spike-${run}-other-vault`,
    ),
  );
  await attempt(
    2,
    "USDC approve(vault, 0.000001) through eth_sendTransaction",
    "refused",
    () =>
      sendUsdcCall(
        treasury.walletId,
        approveCalldata(vault.vault_address, 1n),
        `spike-${run}-approve`,
      ),
  );
  await attempt(
    2,
    `USDC transfer of ${toUsdc(SPIKE_CAP + 1n)} (cap + 0.000001) to itself`,
    "refused",
    () =>
      sendUsdcCall(
        treasury.walletId,
        usdcTransferCalldata(treasury.address, SPIKE_CAP + 1n),
        `spike-${run}-over-cap`,
      ),
  );
  await attempt(
    3,
    "Earn deposit from a wallet with the transit policy",
    "refused",
    () => deposit(transit.walletId, vaultId, amount, `spike-${run}-transit`),
  );

  const depositKey = `spike-${run}-deposit`;
  const first = await attempt(
    1,
    `Earn deposit of ${toUsdc(amount)} USDC with the runtime key alone`,
    "allowed",
    () => deposit(treasury.walletId, vaultId, amount, depositKey),
  );
  if (!first) {
    await save();
    process.exit(1);
  }
  state.depositActionId = first.id;
  await save();

  await attempt(
    5,
    "The same deposit again, same idempotency key",
    "allowed",
    async () => {
      const again = await deposit(
        treasury.walletId,
        vaultId,
        amount,
        depositKey,
      );
      if (again.id !== first.id) {
        throw new Error(`a new action ${again.id}, not ${first.id}`);
      }
      return again;
    },
  );
  await attempt(
    5,
    "Same reference_id, new idempotency key",
    "refused",
    () =>
      deposit(
        treasury.walletId,
        vaultId,
        amount,
        depositKey,
        `${depositKey}-again`,
      ),
    /reference_id already exists/i,
  );
}

const depositAction = await awaitAction(
  treasury.walletId,
  state.depositActionId,
);
state.depositAction = depositAction;
fact(
  1,
  "The deposit succeeds",
  depositAction.status === "succeeded",
  describeAction(depositAction),
);
fact(
  8,
  "wallets().actions.get(id, { include: 'steps' }) in SDK 0.37.0",
  true,
  depositAction.id,
);
await save();
if (depositAction.status !== "succeeded") process.exit(1);
const depositedAt = Date.parse(depositAction.created_at);

if (!state.withdrawActionId) {
  const deadline = Date.now() + POSITION_TIMEOUT_MS;
  let position = await readPosition(treasury.walletId, depositedAt);
  state.positionsAfterDeposit.push(position);
  while (BigInt(position.totalDeposited) === 0n && Date.now() < deadline) {
    await sleep(POSITION_POLL_MS);
    position = await readPosition(treasury.walletId, depositedAt);
    state.positionsAfterDeposit.push(position);
  }
  await save();
  record({
    item: 6,
    step: "Position after the deposit",
    verdict: "OBSERVE",
    detail: state.positionsAfterDeposit
      .map(
        (read) =>
          `+${read.secondsAfterDeposit}s assets ${read.assetsInVault}, shares ${read.sharesInVault}, deposited ${read.totalDeposited}, withdrawn ${read.totalWithdrawn}, APY ${String(read.apyBps)} bps`,
      )
      .join("\n          "),
  });
  fact(8, "vaultPosition(walletId, { vault_id }) in SDK 0.37.0", true, "read");

  const everything = BigInt(position.assetsInVault);
  if (everything === 0n) {
    await save();
    throw new Error("The position shows nothing to withdraw");
  }
  const withdrawKey = `spike-${run}-withdraw`;
  const withdrawal = await attempt(
    1,
    `Earn withdrawal of all ${toUsdc(everything)} USDC with the runtime key alone`,
    "allowed",
    () =>
      earn().withdraw(treasury.walletId, {
        vault_id: vaultId,
        raw_amount: everything.toString(),
        reference_id: withdrawKey,
        idempotency_key: withdrawKey,
        authorization_context: asRuntime,
      }),
  );
  if (!withdrawal) {
    await save();
    process.exit(1);
  }
  state.withdrawActionId = withdrawal.id;
  await save();
}

const withdrawAction = await awaitAction(
  treasury.walletId,
  state.withdrawActionId,
);
state.withdrawAction = withdrawAction;
fact(
  1,
  "The withdrawal succeeds",
  withdrawAction.status === "succeeded",
  describeAction(withdrawAction),
);
if (withdrawAction.status === "succeeded") {
  state.positionAfterWithdrawal = await readPosition(
    treasury.walletId,
    depositedAt,
  );
  const left = state.positionAfterWithdrawal;
  record({
    item: 7,
    step: "Left in the vault after withdrawing all of assets_in_vault",
    verdict: "OBSERVE",
    detail: `assets ${left.assetsInVault}, shares ${left.sharesInVault}, deposited ${left.totalDeposited}, withdrawn ${left.totalWithdrawn}`,
  });
}
/**
 * Privy checks that the vault exists and that the wallet holds enough before
 * it reads the policy, so a refusal is only conclusive from a funded wallet
 * asking for the real vault. Each probe wallet gets 0.01 USDC from the
 * Treasury wallet and sends it back afterwards.
 */
async function waitForUsdc(
  address: string,
  done: (usdc: bigint) => boolean,
): Promise<bigint> {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  for (;;) {
    const { usdc } = await balances(address);
    if (done(usdc)) return usdc;
    if (Date.now() > deadline) {
      throw new Error(`${address} still holds ${toUsdc(usdc)} USDC`);
    }
    await sleep(ACTION_POLL_MS);
  }
}

async function probeRefusal(
  item: number,
  step: string,
  name: string,
  wallet: SpikeWallet,
): Promise<void> {
  if ((await balances(wallet.address)).usdc < PROBE) {
    await sendUsdcCall(
      treasury.walletId,
      usdcTransferCalldata(wallet.address, PROBE),
      `spike-${run}-probe-fund-${name}`,
    );
    await waitForUsdc(wallet.address, (usdc) => usdc >= PROBE);
  }
  const allowed = await attempt(item, step, "refused", () =>
    deposit(wallet.walletId, vaultId, PROBE, `spike-${run}-probe-${name}`),
  );
  if (allowed) {
    const action = await awaitAction(wallet.walletId, allowed.id);
    console.log(`          ${describeAction(action)}`);
    if (action.status === "succeeded") {
      await attempt(item, `${step}: taking it back out`, "allowed", () =>
        earn().withdraw(wallet.walletId, {
          vault_id: vaultId,
          raw_amount: (PROBE - 1n).toString(),
          reference_id: `spike-${run}-probe-${name}-out`,
          idempotency_key: `spike-${run}-probe-${name}-out`,
          authorization_context: asRuntime,
        }),
      );
    }
  }
  const left = (await balances(wallet.address)).usdc;
  if (left > 0n) {
    await sendUsdcCall(
      wallet.walletId,
      usdcTransferCalldata(treasury.address, left),
      `spike-${run}-probe-back-${name}`,
    );
    await waitForUsdc(wallet.address, (usdc) => usdc === 0n);
  }
}

if (withdrawAction.status === "succeeded" && !state.probesDone) {
  state.otherVault ??= await ensureWallet(`spike-othervault-${run}`, [
    earnRule("earn_deposit", NOT_THE_VAULT),
    // Recovers the probe if Privy wrongly lets it into the real vault.
    earnRule("earn_withdraw", vaultId),
    ...companyWalletPolicyRules(SPIKE_CAP),
  ]);
  await save();
  await probeRefusal(
    2,
    "Earn deposit into the vault from a funded wallet whose policy names another vault",
    "other-vault",
    state.otherVault,
  );
  await probeRefusal(
    3,
    "Earn deposit from a funded wallet with the transit policy",
    "transit",
    transit,
  );
  state.probesDone = true;
  await save();
}

const after = await balances(treasury.address);
fact(4, "No ETH after the withdrawal", after.eth === 0n, `${after.eth} wei`);
console.log(`Treasury wallet holds ${toUsdc(after.usdc)} USDC`);
await save();

if (returnTo && after.usdc > 0n) {
  const amount = after.usdc < SPIKE_CAP ? after.usdc : SPIKE_CAP;
  const sent = await attempt(
    2,
    `USDC transfer of ${toUsdc(amount)} back (within the cap)`,
    "allowed",
    () =>
      sendUsdcCall(
        treasury.walletId,
        usdcTransferCalldata(returnTo, amount),
        `spike-${run}-return-${state.returnTxHashes.length}`,
      ),
  );
  if (sent) {
    state.returnTxHashes.push(sent.hash);
    await save();
    // A sponsored send can be accepted before Privy has a transaction hash.
    const succeeded = /^0x[0-9a-fA-F]{64}$/.test(sent.hash)
      ? await awaitReceipt(sent.hash)
      : null;
    console.log(
      `Returned ${toUsdc(amount)} USDC: ${sent.hash || "no hash yet"}, Privy transaction ${sent.transaction_id ?? "-"} (${succeeded === null ? "not confirmed yet" : succeeded ? "succeeded" : "reverted"})`,
    );
    if (after.usdc > amount) {
      console.log(
        `${toUsdc(after.usdc - amount)} USDC left; run again with --return-to to send the next part.`,
      );
    }
  }
} else if (after.usdc > 0n) {
  console.log(
    `Run again with --return-to <your Base address> to send it back.`,
  );
}

await save();
const counts = state.checks.reduce<Record<Verdict, number>>(
  (tally, check) => ({ ...tally, [check.verdict]: tally[check.verdict] + 1 }),
  { PASS: 0, FAIL: 0, CHECK: 0, OBSERVE: 0 },
);
console.log(
  `\n${counts.PASS} pass, ${counts.FAIL} fail, ${counts.CHECK} to check by hand, ${counts.OBSERVE} observed. Saved to ${statePath.pathname}`,
);
