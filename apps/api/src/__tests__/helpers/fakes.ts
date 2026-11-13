import type { PublicKey } from "near-api-js";
import { createHmac, randomBytes } from "node:crypto";
import { APIError } from "@privy-io/node";
import { Effect, Layer, Redacted } from "effect";
import { KeyPair, Signer } from "near-api-js";

import type {
  TransactionReceipt,
  UsdcTransfer,
} from "../../services/chain/base.js";
import type { EmailMessage } from "../../services/email/email-sender.js";
import type {
  RawExtraction,
  ReceiptExtraction,
  ReceiptExtractionErrorCode,
  UnreadableReason,
} from "../../services/extraction/receipt-extractor.js";
import type {
  ReceiptFields,
  ReceiptFlag,
} from "../../services/extraction/receipt-schema.js";
import type {
  LithicAccountHolder,
  LithicBusinessInput,
  LithicCardholderInput,
  LithicCardPatch,
  LithicTransaction,
} from "../../services/lithic/lithic-client.js";
import type {
  PaycrestOrder,
  PaycrestOrderRequest,
} from "../../services/paycrest/paycrest-client.js";
import type {
  OtpProviderErrorCode,
  VerificationCheckResult,
} from "../../services/phone-verification/otp-provider.js";
import type {
  PretiumBank,
  PretiumPayRequest,
  PretiumTransaction,
} from "../../services/pretium/pretium-client.js";
import type { StoredObject } from "../../services/storage/file-storage.js";
import type {
  CreateNearWalletInput,
  CreatePolicyInput,
  CreateTreasuryPolicyInput,
  CreateWalletInput,
  EarnActionRecord,
  EarnActionStatus,
  EarnCallInput,
  NearSigningWallet,
  PrivyWalletRecord,
  SendUsdcInput,
  SentTransaction,
} from "../../services/wallet/privy-wallets.js";
import type {
  ZohoBooksAccount,
  ZohoBooksOrganization,
  ZohoErrorCode,
  ZohoExpenseDraft,
} from "../../services/zoho/zoho-client.js";
import {
  AlchemyWebhook,
  makeAlchemyWebhook,
} from "../../services/alchemy/alchemy-webhook.js";
import { ApprovalSettings } from "../../services/approval/passkeys.js";
import { BaseRpc, BaseRpcError } from "../../services/chain/base-rpc.js";
import {
  EmailSender,
  EmailSendError,
} from "../../services/email/email-sender.js";
import {
  ReceiptExtractionError,
  ReceiptExtractor,
} from "../../services/extraction/receipt-extractor.js";
import { Lithic, LithicError } from "../../services/lithic/lithic-client.js";
import { fromMicro, toMicro } from "../../services/paycrest/amounts.js";
import {
  Paycrest,
  PaycrestError,
  verifyPaycrestSignature,
} from "../../services/paycrest/paycrest-client.js";
import {
  OtpProvider,
  OtpProviderError,
} from "../../services/phone-verification/otp-provider.js";
import {
  Pretium,
  PretiumError,
  verifyPretiumSignature,
} from "../../services/pretium/pretium-client.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../../services/pretium/settlement.js";
import {
  FileStorage,
  StorageError,
} from "../../services/storage/file-storage.js";
import { WalletSettings } from "../../services/wallet/company-wallet.js";
import {
  PrivyWalletError,
  PrivyWallets,
  SendOutcomeUnknown,
  SendRefused,
} from "../../services/wallet/privy-wallets.js";
import { Zoho, ZohoError } from "../../services/zoho/zoho-client.js";
import { transferReceipt } from "./chain.js";

export const TEST_WALLET_SETTINGS = {
  managementQuorumId: "kq-management",
  runtimeSignerId: "kq-runtime",
  defaultPerTransactionMaxUsdc: 5_000_000_000n,
} as const;

export const TEST_RP_ID = "business.expendi.test";
export const TEST_ORIGIN = `https://${TEST_RP_ID}`;

export const TestApprovalSettings = Layer.succeed(ApprovalSettings, {
  rpId: TEST_RP_ID,
  origins: [TEST_ORIGIN],
});

export const TestWalletSettings = Layer.succeed(
  WalletSettings,
  TEST_WALLET_SETTINGS,
);

export const randomAddress = (): string =>
  `0x${randomBytes(20).toString("hex")}`;

type FailingCall =
  | "createPolicy"
  | "createTreasuryPolicy"
  | "createWallet"
  | "findWalletByExternalId"
  | "createNearWallet"
  | "findNearWalletByExternalId"
  | "getWalletAction"
  | "vaultPosition"
  | "vaultDetails";

/**
 * What Privy does with the next Earn call:
 * - `succeeded`, `pending`, `rejected`, `failed`: it answers with an action in
 *   that status;
 * - `refused`: a 400 or 404 before anything is signed, and no action exists;
 * - `unknown`: the action is created but the reply is lost.
 */
export type EarnOutcome =
  "succeeded" | "pending" | "rejected" | "failed" | "refused" | "unknown";

/** `refused` is a definite no from Privy; `unavailable` is a lost reply. */
type NearSigningOutcome = "signed" | "refused" | "unavailable";

/** Signs as Privy would for a NEAR wallet: with the wallet's own ed25519 key. */
class FakePrivyNearSigner extends Signer {
  constructor(
    private readonly keyPair: KeyPair | null,
    private readonly nextOutcome: () => NearSigningOutcome,
  ) {
    super();
  }

  getPublicKey(): Promise<PublicKey> {
    if (!this.keyPair) return Promise.reject(new Error("fake: no such wallet"));
    return Promise.resolve(this.keyPair.getPublicKey());
  }

  protected signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const outcome = this.nextOutcome();
    if (!this.keyPair || outcome === "refused") {
      return Promise.reject(
        new APIError(400, undefined, "fake signing refusal", undefined),
      );
    }
    if (outcome === "unavailable") {
      return Promise.reject(new Error("fake signing timeout"));
    }
    return Promise.resolve(this.keyPair.sign(bytes).signature);
  }
}

interface FakeNearWallet extends PrivyWalletRecord {
  readonly input: CreateNearWalletInput;
  /** Null for a seeded wallet nobody can sign for. */
  readonly keyPair: KeyPair | null;
}

/**
 * In-memory Privy. Like the real API, a repeated idempotency key replays
 * the first result instead of creating a second policy or wallet. NEAR
 * wallets hold real ed25519 keys, so what they sign verifies on the fake
 * chain (helpers/near.ts).
 */
export function makeFakePrivyWallets() {
  const policies = new Map<
    string,
    { id: string; input: CreatePolicyInput | CreateTreasuryPolicyInput }
  >();
  const wallets = new Map<
    string,
    PrivyWalletRecord & { readonly input: CreateWalletInput }
  >();
  const nearWallets = new Map<string, FakeNearWallet>();
  const nearSigningOutcomes: NearSigningOutcome[] = [];
  const nearSigningRequests = new Map<string, number>();
  const calls: Record<FailingCall, number> = {
    createPolicy: 0,
    createTreasuryPolicy: 0,
    createWallet: 0,
    findWalletByExternalId: 0,
    createNearWallet: 0,
    findNearWalletByExternalId: 0,
    getWalletAction: 0,
    vaultPosition: 0,
    vaultDetails: 0,
  };
  const failures = new Map<FailingCall, number>();
  /** Every send that reached "Privy", in order; replays aren't repeated. */
  const sends: SendUsdcInput[] = [];
  const sent = new Map<string, SentTransaction>();
  type SendOutcome =
    "sent" | "sent_without_hash" | "refused" | "policy_violation" | "unknown";
  const sendOutcomes: SendOutcome[] = [];
  /** Every Earn call that reached "Privy", in order; replays aren't repeated. */
  const earnCalls: (EarnCallInput & {
    readonly kind: "deposit" | "withdraw";
  })[] = [];
  const earnActions = new Map<
    string,
    EarnActionRecord & {
      readonly privyWalletId: string;
      readonly kind: "deposit" | "withdraw";
    }
  >();
  const earnByKey = new Map<string, string>();
  const earnOutcomes: EarnOutcome[] = [];
  const vaultAssets = new Map<string, bigint>();
  /** What Privy's `total_deposited` and `total_withdrawn` say, from Earn calls that succeeded. */
  const vaultTotals = new Map<
    string,
    { deposited: bigint; withdrawn: bigint }
  >();
  const totalsOf = (privyWalletId: string) => {
    const totals = vaultTotals.get(privyWalletId) ?? {
      deposited: 0n,
      withdrawn: 0n,
    };
    vaultTotals.set(privyWalletId, totals);
    return totals;
  };
  let vaultApyBps: number | null = 519;
  let onEarnDeposit: ((input: EarnCallInput) => void) | null = null;
  /** What the vault pays out for the next withdrawals that succeed; each without one pays in full. */
  const withdrawalFills: bigint[] = [];
  let onWithdrawn:
    | ((withdrawal: {
        readonly privyWalletId: string;
        readonly rawAmount: bigint;
        readonly delivered: bigint;
        readonly txHash: string;
      }) => void)
    | null = null;
  /** What Privy reports for each send it accepted, by its transaction ID. */
  const privyTransactions = new Map<
    string,
    {
      readonly privyWalletId: string;
      readonly input: SendUsdcInput;
      txHash: string | null;
    }
  >();
  const transactionHashLookups: string[] = [];
  /** Base addresses of wallets the API holds but this fake didn't create. */
  const baseAddresses = new Map<string, string>();
  /** Where a send with a hash is mined, once a test wires a Base chain. */
  let minedInto: Map<string, TransactionReceipt> | null = null;

  /** A send lands on Base as one USDC transfer from its wallet. */
  const mine = (input: SendUsdcInput, txHash: string) => {
    if (!minedInto) return;
    const from =
      baseAddresses.get(input.privyWalletId) ??
      [...wallets.values()].find((wallet) => wallet.id === input.privyWalletId)
        ?.address;
    if (!from) {
      throw new Error(
        `fake Privy can't mine a send from unknown wallet ${input.privyWalletId}`,
      );
    }
    minedInto.set(
      txHash.toLowerCase(),
      transferReceipt([{ from, to: input.to, amount: input.amount }], {
        txHash,
      }),
    );
  };

  const maybeFail = (
    call: FailingCall,
  ): Effect.Effect<void, PrivyWalletError> => {
    calls[call] += 1;
    const remaining = failures.get(call) ?? 0;
    if (remaining === 0) return Effect.void;
    failures.set(call, remaining - 1);
    return Effect.fail(
      new PrivyWalletError({ message: `fake ${call} failure` }),
    );
  };

  const newNearWallet = (input: CreateNearWalletInput): FakeNearWallet => {
    const keyPair = KeyPair.fromRandom("ed25519");
    return {
      id: `near-wallet-${randomBytes(6).toString("hex")}`,
      address: Buffer.from(keyPair.getPublicKey().data).toString("hex"),
      ownerId: input.ownerQuorumId,
      policyIds: [],
      signerIds: [input.signerQuorumId],
      input,
      keyPair,
    };
  };

  const state = {
    policies,
    /** Ethereum wallets: the transit wallets. */
    wallets,
    /** NEAR wallets: the company wallets, and the gas relayer's. */
    nearWallets,
    /** How many times a NEAR wallet was asked to sign, refusals included. */
    nearSigningRequestsFor: (privyWalletId: string): number =>
      nearSigningRequests.get(privyWalletId) ?? 0,
    /** Queue outcomes for the next NEAR signings; each without one signs. */
    nextNearSignings(...outcomes: NearSigningOutcome[]) {
      nearSigningOutcomes.push(...outcomes);
    },
    /** What the service hands out: a signer holding the wallet's key now. */
    nearSigner({ privyWalletId, accountId }: NearSigningWallet): Signer {
      const wallet = [...nearWallets.values()].find(
        (candidate) =>
          candidate.id === privyWalletId && candidate.address === accountId,
      );
      return new FakePrivyNearSigner(wallet?.keyPair ?? null, () => {
        nearSigningRequests.set(
          privyWalletId,
          state.nearSigningRequestsFor(privyWalletId) + 1,
        );
        return nearSigningOutcomes.shift() ?? "signed";
      });
    },
    /** A NEAR wallet that exists in Privy without going through the API. */
    addNearWallet(externalId = `standalone-${randomBytes(4).toString("hex")}`) {
      const wallet = newNearWallet({
        externalId,
        displayName: externalId,
        ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
        signerQuorumId: TEST_WALLET_SETTINGS.runtimeSignerId,
        idempotencyKey: `standalone-${externalId}`,
      });
      nearWallets.set(wallet.input.idempotencyKey, wallet);
      return { privyWalletId: wallet.id, accountId: wallet.address };
    },
    /** A NEAR wallet created outside this fake's idempotency (e.g. >24h ago). */
    seedNearWallet(record: PrivyWalletRecord, input: CreateNearWalletInput) {
      nearWallets.set(`seeded-${record.id}`, {
        ...record,
        input,
        keyPair: null,
      });
    },
    calls,
    /** The next `times` calls of `call` fail. */
    failNext(call: FailingCall, times = 1) {
      failures.set(call, times);
    },
    sends,
    earnCalls,
    /** Queue outcomes for the next Earn calls; each without one succeeds. */
    nextEarnCalls(...outcomes: EarnOutcome[]) {
      earnOutcomes.push(...outcomes);
    },
    /** Moves an action on, as Privy does once its transaction settles. */
    settleEarnAction(
      actionId: string,
      status: EarnActionStatus,
      details: { readonly failureReason?: string } = {},
    ) {
      const action = earnActions.get(actionId);
      if (!action) throw new Error(`no Earn action ${actionId}`);
      const txHash =
        status === "pending" || status === "rejected"
          ? null
          : `0x${randomBytes(32).toString("hex")}`;
      earnActions.set(actionId, {
        ...action,
        status,
        txHash,
        failureReason: details.failureReason ?? null,
      });
      if (status === "succeeded" && action.kind === "deposit") {
        vaultAssets.set(
          action.privyWalletId,
          (vaultAssets.get(action.privyWalletId) ?? 0n) + action.rawAmount,
        );
        totalsOf(action.privyWalletId).deposited += action.rawAmount;
      }
      if (status === "succeeded" && action.kind === "withdraw" && txHash) {
        const held = vaultAssets.get(action.privyWalletId) ?? 0n;
        const delivered = withdrawalFills.shift() ?? action.rawAmount;
        vaultAssets.set(action.privyWalletId, held - delivered);
        totalsOf(action.privyWalletId).withdrawn += delivered;
        onWithdrawn?.({
          privyWalletId: action.privyWalletId,
          rawAmount: action.rawAmount,
          delivered,
          txHash,
        });
      }
    },
    /** Queue what the vault pays out for the next withdrawals that succeed (a partial fill). */
    nextWithdrawalFills(...amounts: bigint[]) {
      withdrawalFills.push(...amounts);
    },
    /** Runs when a withdrawal succeeds, to put its USDC in the test's chain. */
    onWithdrawn(run: NonNullable<typeof onWithdrawn>) {
      onWithdrawn = run;
    },
    /** Sets what a wallet's vault position is worth, as yield or a deposit made elsewhere would. */
    setVaultAssets(privyWalletId: string, amount: bigint) {
      vaultAssets.set(privyWalletId, amount);
    },
    /** The yearly rate the vault reports after Expendi's share, in basis points. */
    setVaultApy(bps: number | null) {
      vaultApyBps = bps;
    },
    /** Sets what Privy reports as ever deposited and withdrawn, as a call made outside Expendi would. */
    setVaultTotals(
      privyWalletId: string,
      totals: { readonly deposited: bigint; readonly withdrawn: bigint },
    ) {
      vaultTotals.set(privyWalletId, { ...totals });
    },
    /** Forgets queued Earn outcomes and the calls made so far. */
    resetEarn() {
      earnOutcomes.length = 0;
      earnCalls.length = 0;
      withdrawalFills.length = 0;
    },
    /** The ID of the action created under a reference, as Privy would answer it. */
    actionIdFor: (referenceId: string): string | null =>
      earnByKey.get(referenceId) ?? null,
    /** Runs when a deposit is first accepted, to move the USDC in the test's chain. */
    onEarnDeposit(run: (input: EarnCallInput) => void) {
      onEarnDeposit = run;
    },
    /** What a wallet's vault position is worth, from the deposits that succeeded. */
    vaultAssetsOf: (privyWalletId: string): bigint =>
      vaultAssets.get(privyWalletId) ?? 0n,
    /** Queue outcomes for the next sends; each send without one succeeds. */
    nextSends(...outcomes: SendOutcome[]) {
      sendOutcomes.push(...outcomes);
    },
    /** Every `transactionHash` call, by Privy transaction ID. */
    transactionHashLookups,
    /** Privy learns the hash of a send it accepted without one. */
    confirmTransaction(privyTransactionId: string, txHash: string) {
      const transaction = privyTransactions.get(privyTransactionId);
      if (!transaction) {
        throw new Error(`fake Privy has no transaction ${privyTransactionId}`);
      }
      transaction.txHash = txHash.toLowerCase();
      mine(transaction.input, transaction.txHash);
    },
    /**
     * Mines every send that has a hash into `receipts` (a fake Base RPC's),
     * as Base would within seconds; null stops mining.
     */
    mineOn(receipts: Map<string, TransactionReceipt> | null) {
      minedInto = receipts;
    },
    /** The Base address of a wallet the API holds, for mining its sends. */
    walletAt(privyWalletId: string, address: string) {
      baseAddresses.set(privyWalletId, address.toLowerCase());
    },
    /** A wallet created outside this fake's idempotency (e.g. >24h ago). */
    seedWallet(record: PrivyWalletRecord, input: CreateWalletInput) {
      wallets.set(`seeded-${record.id}`, { ...record, input });
    },
    reset() {
      policies.clear();
      wallets.clear();
      nearWallets.clear();
      nearSigningOutcomes.length = 0;
      nearSigningRequests.clear();
      failures.clear();
      sends.length = 0;
      sent.clear();
      sendOutcomes.length = 0;
      earnCalls.length = 0;
      earnActions.clear();
      earnByKey.clear();
      earnOutcomes.length = 0;
      vaultAssets.clear();
      vaultTotals.clear();
      vaultApyBps = 519;
      withdrawalFills.length = 0;
      onEarnDeposit = null;
      onWithdrawn = null;
      privyTransactions.clear();
      transactionHashLookups.length = 0;
      for (const call of Object.keys(calls) as FailingCall[]) calls[call] = 0;
    },
  };

  const earnCall =
    (kind: "deposit" | "withdraw") =>
    (
      input: EarnCallInput,
    ): Effect.Effect<EarnActionRecord, SendRefused | SendOutcomeUnknown> => {
      const replay = earnByKey.get(input.referenceId);
      const existing = replay ? earnActions.get(replay) : undefined;
      if (existing) return Effect.succeed(existing);
      // Privy refuses a withdrawal of more than the position holds before
      // anything is signed.
      if (
        kind === "withdraw" &&
        input.rawAmount > (vaultAssets.get(input.privyWalletId) ?? 0n)
      ) {
        return Effect.fail(
          new SendRefused({
            message: "fake: amount over the position",
            status: 400,
            policyViolation: false,
          }),
        );
      }
      const outcome = earnOutcomes.shift() ?? "succeeded";
      if (outcome === "refused") {
        return Effect.fail(
          new SendRefused({
            message: "fake Earn refusal",
            status: 400,
            policyViolation: false,
          }),
        );
      }
      earnCalls.push({ ...input, kind });
      const status: EarnActionStatus =
        outcome === "unknown" ? "pending" : outcome;
      const action = {
        actionId: `action-${randomBytes(6).toString("hex")}`,
        status: "pending" as EarnActionStatus,
        rawAmount: input.rawAmount,
        shareAmount: null,
        txHash: null,
        failureReason: null,
        privyWalletId: input.privyWalletId,
        kind,
      };
      earnActions.set(action.actionId, action);
      earnByKey.set(input.referenceId, action.actionId);
      // Nothing is signed for a rejected or reverted deposit, so no USDC leaves.
      if (
        kind === "deposit" &&
        outcome !== "rejected" &&
        outcome !== "failed"
      ) {
        onEarnDeposit?.(input);
      }
      if (status !== "pending") {
        state.settleEarnAction(
          action.actionId,
          status,
          status === "succeeded" ? {} : { failureReason: `fake ${status}` },
        );
      }
      if (outcome === "unknown") {
        return Effect.fail(
          new SendOutcomeUnknown({ message: "fake timeout", cause: null }),
        );
      }
      return Effect.succeed(earnActions.get(action.actionId) ?? action);
    };

  const layer = Layer.succeed(PrivyWallets, {
    createPolicy: (input) =>
      maybeFail("createPolicy").pipe(
        Effect.map(() => {
          const existing = policies.get(input.idempotencyKey);
          if (existing) return { policyId: existing.id };
          const id = `policy-${policies.size + 1}-${randomBytes(4).toString("hex")}`;
          policies.set(input.idempotencyKey, { id, input });
          return { policyId: id };
        }),
      ),
    createTreasuryPolicy: (input) =>
      maybeFail("createTreasuryPolicy").pipe(
        Effect.map(() => {
          const existing = policies.get(input.idempotencyKey);
          if (existing) return { policyId: existing.id };
          const id = `policy-${policies.size + 1}-${randomBytes(4).toString("hex")}`;
          policies.set(input.idempotencyKey, { id, input });
          return { policyId: id };
        }),
      ),
    createWallet: (input) =>
      maybeFail("createWallet").pipe(
        Effect.map(() => {
          const existing = wallets.get(input.idempotencyKey);
          if (existing) return existing;
          const record = {
            id: `wallet-${randomBytes(6).toString("hex")}`,
            address: randomAddress(),
            ownerId: input.ownerQuorumId,
            policyIds: [input.policyId],
            signerIds: [input.signerQuorumId],
            input,
          };
          wallets.set(input.idempotencyKey, record);
          return record;
        }),
      ),
    findWalletByExternalId: (externalId) =>
      maybeFail("findWalletByExternalId").pipe(
        Effect.map(
          () =>
            [...wallets.values()].find(
              (wallet) => wallet.input.externalId === externalId,
            ) ?? null,
        ),
      ),
    createNearWallet: (input) =>
      maybeFail("createNearWallet").pipe(
        Effect.map(() => {
          const existing = nearWallets.get(input.idempotencyKey);
          if (existing) return existing;
          const wallet = newNearWallet(input);
          nearWallets.set(input.idempotencyKey, wallet);
          return wallet;
        }),
      ),
    findNearWalletByExternalId: (externalId) =>
      maybeFail("findNearWalletByExternalId").pipe(
        Effect.map(
          () =>
            [...nearWallets.values()].find(
              (wallet) => wallet.input.externalId === externalId,
            ) ?? null,
        ),
      ),
    nearSigner: (wallet) => state.nearSigner(wallet),
    sendUsdc: (input) => {
      const replay = sent.get(input.idempotencyKey);
      if (replay) return Effect.succeed(replay);
      const outcome = sendOutcomes.shift() ?? "sent";
      if (outcome === "refused" || outcome === "policy_violation") {
        return Effect.fail(
          new SendRefused({
            message: `fake ${outcome}`,
            status: 400,
            policyViolation: outcome === "policy_violation",
          }),
        );
      }
      sends.push(input);
      if (outcome === "unknown") {
        return Effect.fail(
          new SendOutcomeUnknown({ message: "fake timeout", cause: null }),
        );
      }
      const result = {
        txHash:
          outcome === "sent" ? `0x${randomBytes(32).toString("hex")}` : null,
        privyTransactionId: `ptx-${randomBytes(6).toString("hex")}`,
      };
      sent.set(input.idempotencyKey, result);
      privyTransactions.set(result.privyTransactionId, {
        privyWalletId: input.privyWalletId,
        input,
        txHash: result.txHash,
      });
      if (result.txHash !== null) mine(input, result.txHash);
      return Effect.succeed(result);
    },
    earnDeposit: earnCall("deposit"),
    earnWithdraw: earnCall("withdraw"),
    getWalletAction: (input) =>
      maybeFail("getWalletAction").pipe(
        Effect.flatMap(() => {
          const action = earnActions.get(input.actionId);
          return action
            ? Effect.succeed(action)
            : Effect.fail(
                new PrivyWalletError({ message: "fake: no such action" }),
              );
        }),
      ),
    vaultPosition: (input) =>
      maybeFail("vaultPosition").pipe(
        Effect.map(() => {
          const assets = vaultAssets.get(input.privyWalletId) ?? 0n;
          return {
            assetsInVault: assets,
            sharesInVault: assets,
            totalDeposited: totalsOf(input.privyWalletId).deposited,
            totalWithdrawn: totalsOf(input.privyWalletId).withdrawn,
          };
        }),
      ),
    vaultDetails: () =>
      maybeFail("vaultDetails").pipe(
        Effect.map(() => ({
          name: "Fake Aave USDC",
          userApyBps: vaultApyBps,
          availableLiquidityUsd: 15_500_000,
        })),
      ),
    transactionHash: ({ privyWalletId, privyTransactionId }) =>
      Effect.sync(() => {
        transactionHashLookups.push(privyTransactionId);
        const transaction = privyTransactions.get(privyTransactionId);
        return transaction?.privyWalletId === privyWalletId
          ? transaction.txHash
          : null;
      }),
  });

  return { layer, state };
}

export const TEST_ALCHEMY_SIGNING_KEY = "whsec_test_alchemy_key";

export function signAlchemyBody(rawBody: string): string {
  return createHmac("sha256", TEST_ALCHEMY_SIGNING_KEY)
    .update(rawBody, "utf8")
    .digest("hex");
}

/**
 * The real Alchemy adapter with a test signing key, talking to a fake
 * Notify API that records the addresses it was asked to watch.
 */
export function makeFakeAlchemyWebhook() {
  const watched: string[] = [];
  let failures = 0;
  const notifyApi: typeof fetch = (_input, init) => {
    if (failures > 0) {
      failures -= 1;
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    }
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(rawBody) as {
      addresses_to_add: string[];
    };
    watched.push(...body.addresses_to_add);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const state = {
    watched,
    failNext(times = 1) {
      failures = times;
    },
  };
  const layer = Layer.succeed(
    AlchemyWebhook,
    makeAlchemyWebhook(
      {
        webhookId: "wh_test",
        signingKeys: Redacted.make(TEST_ALCHEMY_SIGNING_KEY),
        notifyToken: Redacted.make("test-notify-token"),
      },
      notifyApi,
    ),
  );
  return { layer, state };
}

/**
 * Receipts keyed by lowercased transaction hash; `eth_call` results keyed
 * by `callKey(to, data)`. A call nobody set returns "0x", as a call to an
 * address with no code does.
 */
export function makeFakeBaseRpc() {
  const receipts = new Map<string, TransactionReceipt>();
  const callResults = new Map<string, string>();
  /** What `eth_getLogs` finds: USDC transfers on chain, in any order. */
  const transfers: UsdcTransfer[] = [];
  let failures = 0;
  let callFailures = 0;
  let searchFailures = 0;
  let unminedReads = 0;
  const state = {
    receipts,
    callResults,
    transfers,
    latestBlock: 40_000_000n,
    failNext(times = 1) {
      failures = times;
    },
    /** The next `times` receipt reads find nothing, as before a block is mined. */
    unminedForNext(times = 1) {
      unminedReads = times;
    },
    /** The next `times` eth_calls fail; receipts are unaffected. */
    failNextCalls(times = 1) {
      callFailures = times;
    },
    /** The next `times` block number reads and log searches fail. */
    failNextSearches(times = 1) {
      searchFailures = times;
    },
  };
  const searchFailure = () => {
    if (searchFailures === 0) return null;
    searchFailures -= 1;
    return Effect.fail(
      new BaseRpcError({ message: "fake log search failure" }),
    );
  };
  const layer = Layer.succeed(BaseRpc, {
    getTransactionReceipt: (txHash) => {
      if (failures > 0) {
        failures -= 1;
        return Effect.fail(new BaseRpcError({ message: "fake RPC failure" }));
      }
      if (unminedReads > 0) {
        unminedReads -= 1;
        return Effect.succeed(null);
      }
      return Effect.succeed(receipts.get(txHash.toLowerCase()) ?? null);
    },
    ethCall: (to, data) => {
      if (callFailures > 0) {
        callFailures -= 1;
        return Effect.fail(
          new BaseRpcError({ message: "fake eth_call failure" }),
        );
      }
      return Effect.succeed(callResults.get(callKey(to, data)) ?? "0x");
    },
    blockNumber: () => searchFailure() ?? Effect.succeed(state.latestBlock),
    usdcTransfersBetween: ({ from, to, fromBlock }) =>
      searchFailure() ??
      Effect.succeed(
        transfers.filter(
          (transfer) =>
            transfer.from === from.toLowerCase() &&
            transfer.to === to.toLowerCase() &&
            transfer.blockNumber >= fromBlock,
        ),
      ),
  });
  return { layer, state };
}

export const callKey = (to: string, data: string): string =>
  `${to.toLowerCase()}:${data.toLowerCase()}`;

export const TEST_PAYCREST_SECRET = "pc_test_webhook_secret";

export function signPaycrestBody(rawBody: string): string {
  return createHmac("sha256", TEST_PAYCREST_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");
}

export const TEST_PRETIUM_SIGNING_KEY = "pretium_test_signing_key";
export const TEST_PRETIUM_CALLBACK_URL =
  "https://api.business.expendi.test/webhooks/pretium";

export function signPretiumBody(rawBody: string): string {
  return createHmac("sha512", TEST_PRETIUM_SIGNING_KEY)
    .update(rawBody, "utf8")
    .digest("hex");
}

interface FakeLithicCard {
  readonly token: string;
  readonly lastFour: string;
  readonly accountToken: string;
  readonly memo: string;
  state: string;
  monthlyLimitUsdCents: bigint;
}

/** A Lithic transaction with sensible defaults, as `getTransaction` returns. */
export function fakeLithicTransaction(fields: {
  readonly token: string;
  readonly cardToken: string;
  readonly status?: string;
  readonly result?: string;
  /** Signed as Lithic reports them: a hold or spend is negative. */
  readonly hold?: number;
  readonly settlement?: number;
  readonly merchant?: string;
  readonly mcc?: string;
  readonly events?: readonly string[];
  readonly detailedResults?: readonly string[];
  readonly created?: string;
}): LithicTransaction {
  return {
    token: fields.token,
    card_token: fields.cardToken,
    status: fields.status ?? "PENDING",
    result: fields.result ?? "APPROVED",
    created: fields.created ?? "2026-11-08T10:00:00Z",
    amounts: {
      hold: { amount: fields.hold ?? 0 },
      settlement: { amount: fields.settlement ?? 0 },
    },
    merchant: {
      descriptor: fields.merchant ?? "ACME SOFTWARE",
      mcc: fields.mcc ?? "5734",
      city: "NAIROBI",
      country: "KEN",
    },
    events: (fields.events ?? ["AUTHORIZATION"]).map((type) => ({
      type,
      result: fields.result ?? "APPROVED",
      detailed_results: [...(fields.detailedResults ?? ["APPROVED"])],
    })),
  };
}

/**
 * In-memory Lithic. `nextCreateFailure: "ambiguous"` records the account
 * holder and then errors, as the real sandbox does on a 500.
 */
export function makeFakeLithic() {
  const businesses: LithicBusinessInput[] = [];
  const cardholders: LithicCardholderInput[] = [];
  const holders = new Map<string, LithicAccountHolder>();
  const cards = new Map<string, FakeLithicCard>();
  const updates: { token: string; patch: LithicCardPatch }[] = [];
  const embedSessions: string[] = [];
  const transactions = new Map<string, LithicTransaction>();
  let sequence = 0;
  const state = {
    businesses,
    cardholders,
    holders,
    cards,
    updates,
    embedSessions,
    transactions,
    nextCreateFailure: null as "ambiguous" | "refused" | null,
    failCreateCard: false,
    failUpdateCard: false,
    failGetTransaction: false,
    signaturesValid: true,
    reset() {
      businesses.length = 0;
      cardholders.length = 0;
      holders.clear();
      cards.clear();
      updates.length = 0;
      embedSessions.length = 0;
      transactions.clear();
      state.nextCreateFailure = null;
      state.failCreateCard = false;
      state.failUpdateCard = false;
      state.failGetTransaction = false;
      state.signaturesValid = true;
    },
  };
  const failure = (code: string, ambiguous: boolean, status = 503) =>
    new LithicError({
      message: `fake Lithic: ${code}`,
      status,
      code,
      ambiguous,
    });

  const createHolder = (externalId: string) =>
    Effect.suspend(() => {
      const planned = state.nextCreateFailure;
      state.nextCreateFailure = null;
      if (planned === "refused") {
        return Effect.fail(failure("HTTP_400", false, 400));
      }
      sequence += 1;
      const holder = {
        token: `holder-${sequence}`,
        accountToken: `account-${sequence}`,
      };
      holders.set(externalId, holder);
      return planned === "ambiguous"
        ? Effect.fail(failure("HTTP_500", true, 500))
        : Effect.succeed(holder);
    });

  const layer = Layer.succeed(Lithic, {
    configured: true,
    revealOrigin: "https://business.test",
    createBusiness: (input) =>
      Effect.suspend(() => {
        businesses.push(input);
        return createHolder(input.externalId);
      }),
    createCardholder: (input) =>
      Effect.suspend(() => {
        cardholders.push(input);
        return createHolder(input.externalId);
      }),
    findAccountHolder: (externalId) =>
      Effect.sync(() => holders.get(externalId) ?? null),
    createCard: ({ accountToken, memo, monthlyLimitUsdCents }) =>
      Effect.suspend(() => {
        if (state.failCreateCard) {
          return Effect.fail(failure("HTTP_500", true, 500));
        }
        sequence += 1;
        const card: FakeLithicCard = {
          token: `card-${sequence}`,
          lastFour: String(1000 + sequence).slice(-4),
          accountToken,
          memo,
          state: "OPEN",
          monthlyLimitUsdCents,
        };
        cards.set(card.token, card);
        return Effect.succeed({
          token: card.token,
          lastFour: card.lastFour,
          state: card.state,
        });
      }),
    updateCard: (token, patch) =>
      Effect.suspend(() => {
        if (state.failUpdateCard) {
          return Effect.fail(failure("HTTP_500", true, 500));
        }
        const card = cards.get(token);
        if (!card) return Effect.fail(failure("HTTP_404", false, 404));
        updates.push({ token, patch });
        if (patch.state) card.state = patch.state;
        if (patch.monthlyLimitUsdCents !== undefined) {
          card.monthlyLimitUsdCents = patch.monthlyLimitUsdCents;
        }
        return Effect.succeed({
          token: card.token,
          lastFour: card.lastFour,
          state: card.state,
        });
      }),
    createEmbedSession: (cardToken) =>
      Effect.sync(() => {
        embedSessions.push(cardToken);
        return {
          session: `session-for-${cardToken}`,
          expiresAt: new Date(Date.now() + 300_000),
        };
      }),
    getTransaction: (token) =>
      Effect.suspend(() => {
        if (state.failGetTransaction) {
          return Effect.fail(failure("TRANSPORT_ERROR", false));
        }
        const transaction = transactions.get(token);
        return transaction
          ? Effect.succeed(transaction)
          : Effect.fail(failure("HTTP_404", false, 404));
      }),
    verifyEventSignature: (_rawBody, headers) =>
      state.signaturesValid && headers.signature !== undefined,
    verifyAuthorizationSignature: (_rawBody, headers) =>
      state.signaturesValid && headers.signature !== undefined,
  });

  return { layer, state };
}

const KES_INSTITUTIONS = [
  { code: "SAFAKEPC", name: "M-PESA", type: "mobile_money" },
  { code: "KCBLKENX", name: "Kenya Commercial Bank", type: "bank" },
  { code: "EQBLKENA", name: "Equity Bank", type: "bank" },
] as const;

/**
 * In-memory Paycrest. `rateFor` decides the sell rate for an order size,
 * so tests can model rate bands; created orders echo the request back
 * with deposit instructions, unless `nextOrder` rewrites them.
 */
export function makeFakePaycrest() {
  const created: PaycrestOrderRequest[] = [];
  const orders = new Map<string, PaycrestOrder>();
  const rateCalls: string[] = [];
  const state = {
    created,
    orders,
    rateCalls,
    rateFor: (_usdcAmount: string): string => "128.68",
    /** Holds a rate answer back, so a test can line callers up. */
    rateGate: null as (() => Promise<void>) | null,
    transactionFee: "0.02",
    /** Rewrites the next created order, e.g. to make it unsafe. */
    nextOrder: null as ((order: PaycrestOrder) => PaycrestOrder) | null,
    /** Fails the next createOrder: a lost reply, or a definite refusal. */
    nextCreateFailure: null as "ambiguous" | "refused" | null,
    failGetOrder: false,
    failRate: false,
    reset() {
      created.length = 0;
      orders.clear();
      rateCalls.length = 0;
      state.rateFor = () => "128.68";
      state.rateGate = null;
      state.transactionFee = "0.02";
      state.nextOrder = null;
      state.nextCreateFailure = null;
      state.failGetOrder = false;
      state.failRate = false;
    },
  };
  const unavailable = (code: string) =>
    new PaycrestError({
      message: `fake Paycrest ${code}`,
      status: 503,
      code,
      ambiguous: false,
    });

  const layer = Layer.succeed(Paycrest, {
    rate: (usdcAmount) => {
      rateCalls.push(usdcAmount);
      return Effect.promise(() => state.rateGate?.() ?? Promise.resolve()).pipe(
        Effect.flatMap(() =>
          state.failRate
            ? Effect.fail(unavailable("TRANSPORT_ERROR"))
            : Effect.succeed({
                rate: state.rateFor(usdcAmount),
                providerIds: ["fakeProvider"],
              }),
        ),
      );
    },
    institutions: () => Effect.succeed(KES_INSTITUTIONS),
    verifyAccount: () => Effect.succeed("OK"),
    createOrder: (request) => {
      const failure = state.nextCreateFailure;
      state.nextCreateFailure = null;
      if (failure) {
        if (failure === "ambiguous") created.push(request);
        return Effect.fail(
          new PaycrestError({
            message: `fake Paycrest ${failure}`,
            status: failure === "ambiguous" ? 503 : 400,
            code: failure === "ambiguous" ? "TRANSPORT_ERROR" : "HTTP_400",
            ambiguous: failure === "ambiguous",
          }),
        );
      }
      created.push(request);
      const amount = toMicro(request.amount);
      const fee = toMicro(state.transactionFee);
      let order: PaycrestOrder = {
        id: `order-${randomBytes(6).toString("hex")}`,
        status: "initiated",
        direction: "offramp",
        amount: request.amount,
        rate: request.rate,
        reference: request.reference,
        transactionFee: state.transactionFee,
        senderFee: "0",
        source: { ...request.source },
        destination: {
          type: "fiat",
          currency: "KES",
          country: "KE",
          recipient: { ...request.destination.recipient },
        },
        providerAccount: {
          network: "base",
          receiveAddress: randomAddress(),
          validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
          amountToTransfer: fromMicro(amount + fee),
          currency: "USDC",
        },
      };
      if (state.nextOrder) {
        order = state.nextOrder(order);
        state.nextOrder = null;
      }
      orders.set(order.id, order);
      return Effect.succeed(order);
    },
    verifyWebhookSignature: (rawBody, signature) =>
      verifyPaycrestSignature(rawBody, signature, TEST_PAYCREST_SECRET),
    getOrder: (id) => {
      if (state.failGetOrder) {
        return Effect.fail(unavailable("TRANSPORT_ERROR"));
      }
      const order = orders.get(id);
      return order
        ? Effect.succeed(order)
        : Effect.fail(
            new PaycrestError({
              message: "fake Paycrest order not found",
              status: 404,
              code: "HTTP_404",
              ambiguous: false,
            }),
          );
    },
  });
  return { layer, state };
}

/**
 * `ambiguous` loses the reply after Pretium accepted the payment, as a
 * timeout can; `ambiguous_lost` loses it before Pretium saw the request.
 */
export type FakePretiumPayOutcome =
  "accepted" | "refused" | "ambiguous" | "ambiguous_lost" | "already_processed";

export type FakePretiumRefundOutcome =
  | { readonly kind: "success"; readonly hash: string | null }
  | { readonly kind: "refused" | "ambiguous" | "already_processed" };

const FAKE_PRETIUM_BANKS: readonly PretiumBank[] = [
  { code: "522522", name: "Kenya Commercial Bank" },
  { code: "247247", name: "Equity Bank" },
];

/**
 * In-memory Pretium. Accepted payments become transactions a test can move
 * to any status with `settle`; a hash Pretium already took is refused as
 * already processed, as the real one does.
 */
export function makeFakePretium() {
  const payRequests: PretiumPayRequest[] = [];
  const refundCalls: string[] = [];
  const statusCalls: string[] = [];
  const findCalls: { txHash: string; since: Date }[] = [];
  const transactions = new Map<string, PretiumTransaction>();
  const codeByHash = new Map<string, string>();
  const state = {
    payRequests,
    refundCalls,
    statusCalls,
    findCalls,
    /** By transaction code. */
    transactions,
    /** Lowercased transaction hash to transaction code. */
    codeByHash,
    rateCalls: 0,
    configured: true,
    signingKeyConfigured: true,
    callbackUrl: TEST_PRETIUM_CALLBACK_URL as string | null,
    rate: "129.5",
    failRate: false,
    /** Null makes `baseSettlementAddress` fail. */
    settlementAddress: PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase() as
      string | null,
    banks: FAKE_PRETIUM_BANKS,
    nextPayOutcome: "accepted" as FakePretiumPayOutcome,
    nextRefundOutcome: {
      kind: "success",
      hash: null,
    } as FakePretiumRefundOutcome,
    failStatus: false,
    byHash(txHash: string): PretiumTransaction | null {
      const code = codeByHash.get(txHash.toLowerCase());
      return code === undefined ? null : (transactions.get(code) ?? null);
    },
    /** Moves a transaction on, as Pretium's callback would report. */
    settle(
      transactionCode: string,
      status: string,
      receiptNumber: string | null = null,
    ) {
      const transaction = transactions.get(transactionCode);
      if (!transaction) {
        throw new Error(`fake Pretium has no ${transactionCode}`);
      }
      transactions.set(transactionCode, {
        ...transaction,
        status,
        receiptNumber,
      });
    },
    reset() {
      payRequests.length = 0;
      refundCalls.length = 0;
      statusCalls.length = 0;
      findCalls.length = 0;
      transactions.clear();
      codeByHash.clear();
      state.rateCalls = 0;
      state.configured = true;
      state.signingKeyConfigured = true;
      state.callbackUrl = TEST_PRETIUM_CALLBACK_URL;
      state.rate = "129.5";
      state.failRate = false;
      state.settlementAddress = PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase();
      state.banks = FAKE_PRETIUM_BANKS;
      state.nextPayOutcome = "accepted";
      state.nextRefundOutcome = { kind: "success", hash: null };
      state.failStatus = false;
    },
  };

  const error = (status: number, code: string, ambiguous: boolean) =>
    new PretiumError({
      message: `fake Pretium ${code}`,
      status,
      code,
      ambiguous,
    });
  const whenConfigured = <A>(
    effect: () => Effect.Effect<A, PretiumError>,
  ): Effect.Effect<A, PretiumError> =>
    Effect.suspend(() =>
      state.configured
        ? effect()
        : Effect.fail(error(503, "NOT_CONFIGURED", false)),
    );

  const record = (request: PretiumPayRequest): PretiumTransaction => {
    const transaction: PretiumTransaction = {
      transactionCode: `TX${randomBytes(4).toString("hex").toUpperCase()}`,
      status: "PENDING",
      amount: request.amountShillings.toString(),
      receiptNumber: null,
      publicName: null,
      transactionHash: request.transactionHash.toLowerCase(),
      message: null,
    };
    transactions.set(transaction.transactionCode, transaction);
    codeByHash.set(
      request.transactionHash.toLowerCase(),
      transaction.transactionCode,
    );
    return transaction;
  };

  const layer = Layer.succeed(Pretium, {
    get configured() {
      return state.configured;
    },
    get signingKeyConfigured() {
      return state.signingKeyConfigured;
    },
    get callbackUrl() {
      return state.callbackUrl;
    },
    rate: () =>
      whenConfigured(() => {
        state.rateCalls += 1;
        return state.failRate
          ? Effect.fail(error(503, "TRANSPORT_ERROR", false))
          : Effect.succeed(state.rate);
      }),
    baseSettlementAddress: () =>
      whenConfigured(() =>
        state.settlementAddress === null
          ? Effect.fail(error(502, "NO_BASE_SETTLEMENT_ADDRESS", false))
          : Effect.succeed(state.settlementAddress),
      ),
    banks: () => whenConfigured(() => Effect.succeed(state.banks)),
    pay: (request) =>
      whenConfigured(() => {
        payRequests.push(request);
        const outcome = state.byHash(request.transactionHash)
          ? "already_processed"
          : state.nextPayOutcome;
        state.nextPayOutcome = "accepted";
        switch (outcome) {
          case "accepted": {
            const { transactionCode, status } = record(request);
            return Effect.succeed({ transactionCode, status });
          }
          case "ambiguous":
            record(request);
            return Effect.fail(error(503, "TRANSPORT_ERROR", true));
          case "ambiguous_lost":
            return Effect.fail(error(503, "TRANSPORT_ERROR", true));
          case "refused":
            return Effect.fail(error(400, "HTTP_400", false));
          case "already_processed":
            return Effect.fail(error(400, "HASH_ALREADY_PROCESSED", false));
        }
      }),
    status: (transactionCode) =>
      whenConfigured(() => {
        statusCalls.push(transactionCode);
        if (state.failStatus) {
          return Effect.fail(error(503, "TRANSPORT_ERROR", false));
        }
        const transaction = transactions.get(transactionCode);
        return transaction
          ? Effect.succeed(transaction)
          : Effect.fail(error(404, "HTTP_404", false));
      }),
    findByHash: (query) =>
      whenConfigured(() => {
        findCalls.push(query);
        return Effect.succeed(state.byHash(query.txHash));
      }),
    refund: (txHash) =>
      whenConfigured(() => {
        refundCalls.push(txHash);
        const outcome = state.nextRefundOutcome;
        state.nextRefundOutcome = { kind: "success", hash: null };
        switch (outcome.kind) {
          case "success":
            return Effect.succeed({
              refundTxHash: outcome.hash?.toLowerCase() ?? null,
              amount: null,
              token: "USDC",
              address: null,
            });
          case "refused":
            return Effect.fail(error(400, "HTTP_400", false));
          case "ambiguous":
            return Effect.fail(error(503, "TRANSPORT_ERROR", true));
          case "already_processed":
            return Effect.fail(error(400, "HASH_ALREADY_PROCESSED", false));
        }
      }),
    verifyWebhookSignature: (rawBody, signature) =>
      state.signingKeyConfigured &&
      verifyPretiumSignature(rawBody, signature, TEST_PRETIUM_SIGNING_KEY),
  });
  return { layer, state };
}

/** Records every email "sent"; `failNext` makes the next sends fail. */
export function makeFakeEmailSender() {
  const sent: EmailMessage[] = [];
  let failures = 0;
  const state = {
    sent,
    failNext(times = 1) {
      failures = times;
    },
    reset() {
      sent.length = 0;
      failures = 0;
    },
  };
  const layer = Layer.succeed(EmailSender, {
    send: (message) => {
      if (failures > 0) {
        failures -= 1;
        return Effect.fail(
          new EmailSendError({ message: "fake Resend failure" }),
        );
      }
      sent.push(message);
      return Effect.void;
    },
  });
  return { layer, state };
}

/** The code the fake SMS provider sends to every number. */
export const TEST_OTP_CODE = "246810";

/**
 * In-memory Telnyx Verify. A send makes `TEST_OTP_CODE` live for that
 * number until a check accepts it; like Telnyx, an accepted code can't be
 * checked again. `failNextSend` and `nextCheck` steer the next calls.
 */
export function makeFakeOtpProvider() {
  const sends: string[] = [];
  const checks: { readonly to: string; readonly code: string }[] = [];
  const live = new Set<string>();
  let sendFailure: OtpProviderErrorCode | null = null;
  let checkOverride: VerificationCheckResult | null = null;
  const state = {
    sends,
    checks,
    failNextSend(code: OtpProviderErrorCode) {
      sendFailure = code;
    },
    nextCheck(result: VerificationCheckResult) {
      checkOverride = result;
    },
    reset() {
      sends.length = 0;
      checks.length = 0;
      live.clear();
      sendFailure = null;
      checkOverride = null;
    },
  };
  const layer = Layer.succeed(OtpProvider, {
    startVerification: ({ to }) => {
      const failure = sendFailure;
      sendFailure = null;
      if (failure) {
        return Effect.fail(
          new OtpProviderError({ code: failure, message: `fake ${failure}` }),
        );
      }
      sends.push(to);
      live.add(to);
      return Effect.succeed({
        providerRef: `verification-${randomBytes(6).toString("hex")}`,
      });
    },
    checkVerification: ({ to, code }) => {
      checks.push({ to, code });
      const override = checkOverride;
      checkOverride = null;
      return Effect.sync((): VerificationCheckResult => {
        if (override) return override;
        if (!live.has(to)) return { approved: false, reason: "expired" };
        if (code !== TEST_OTP_CODE)
          return { approved: false, reason: "invalid" };
        live.delete(to);
        return { approved: true };
      });
    },
  });
  return { layer, state };
}

/** What the fake reads when nothing is queued: a plain KES till receipt. */
export const FAKE_RECEIPT_FIELDS: ReceiptFields = {
  kind: "paper_receipt",
  merchant: "Naivas Supermarket",
  amountCents: "123450",
  currency: "KES",
  date: "2026-10-30",
  mpesaCode: null,
  etimsInvoiceNumber: null,
  supplierKraPin: null,
  confidence: {
    merchant: "high",
    amount: "high",
    currency: "high",
    date: "high",
  },
};

type FakeReceiptOutcome =
  | {
      readonly kind: "read";
      readonly fields: ReceiptFields;
      readonly flags: readonly ReceiptFlag[];
    }
  | { readonly kind: "unreadable"; readonly reason: UnreadableReason }
  | { readonly kind: "error"; readonly code: ReceiptExtractionErrorCode };

/**
 * In-memory receipt reading. Each call reads `FAKE_RECEIPT_FIELDS` unless
 * `nextRead`, `nextUnreadable` or `failNext` queued another outcome. It
 * records each image's type and size, never its bytes.
 */
export function makeFakeReceiptExtractor() {
  const calls: { readonly mediaType: string; readonly byteLength: number }[] =
    [];
  const queued: FakeReceiptOutcome[] = [];
  const state = {
    calls,
    nextRead(fields: ReceiptFields, flags: readonly ReceiptFlag[] = []) {
      queued.push({ kind: "read", fields, flags });
    },
    nextUnreadable(reason: UnreadableReason) {
      queued.push({ kind: "unreadable", reason });
    },
    failNext(code: ReceiptExtractionErrorCode) {
      queued.push({ kind: "error", code });
    },
    reset() {
      calls.length = 0;
      queued.length = 0;
    },
  };
  const raw = (reply: unknown): RawExtraction => ({
    model: "fake-receipt-model",
    messageId: `msg_fake_${randomBytes(6).toString("hex")}`,
    stopReason: "end_turn",
    reply,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  });
  const layer = Layer.succeed(ReceiptExtractor, {
    extract: ({ bytes, mediaType }) => {
      calls.push({ mediaType, byteLength: bytes.byteLength });
      const outcome = queued.shift() ?? {
        kind: "read",
        fields: FAKE_RECEIPT_FIELDS,
        flags: [],
      };
      if (outcome.kind === "error") {
        return Effect.fail(
          new ReceiptExtractionError({
            code: outcome.code,
            message: `fake ${outcome.code}`,
          }),
        );
      }
      const result: ReceiptExtraction =
        outcome.kind === "read"
          ? {
              status: "read",
              fields: outcome.fields,
              flags: outcome.flags,
              raw: raw(outcome.fields),
            }
          : { status: "unreadable", reason: outcome.reason, raw: raw(null) };
      return Effect.succeed(result);
    },
  });
  return { layer, state };
}

export const FAKE_STORAGE_ORIGIN = "https://storage.expendi.test";

/**
 * In-memory receipt storage. Presigned URLs name their key, and `put`
 * stands in for the phone's upload: `head` only finds what was put.
 */
export function makeFakeFileStorage() {
  const objects = new Map<string, StoredObject>();
  const contents = new Map<string, Uint8Array>();
  const signedUploads: {
    readonly key: string;
    readonly contentType: string;
    readonly byteSize: number;
  }[] = [];
  const state = {
    objects,
    signedUploads,
    /** `get` fails while set, as when R2 is down. */
    failGets: false,
    put(
      key: string,
      byteSize: number,
      contentType = "image/jpeg",
      bytes: Uint8Array = new Uint8Array(byteSize),
    ) {
      objects.set(key, { byteSize, contentType });
      contents.set(key, bytes);
    },
    reset() {
      objects.clear();
      contents.clear();
      signedUploads.length = 0;
      state.failGets = false;
    },
  };
  const presigned = (key: string, signature: string, ttlMs: number) => ({
    url: `${FAKE_STORAGE_ORIGIN}/${key}?signature=${signature}`,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  const layer = Layer.succeed(FileStorage, {
    put: ({ key, bytes, contentType }) =>
      Effect.sync(() => {
        state.put(key, bytes.byteLength, contentType, bytes);
      }),
    presignUpload: (file) =>
      Effect.sync(() => {
        signedUploads.push(file);
        return presigned(file.key, "upload", 5 * 60_000);
      }),
    presignDownload: (key) =>
      Effect.succeed(presigned(key, "download", 15 * 60_000)),
    head: (key) => Effect.succeed(objects.get(key) ?? null),
    get: (key) => {
      if (state.failGets) {
        return Effect.fail(
          new StorageError({ code: "UNAVAILABLE", message: "fake R2 down" }),
        );
      }
      const bytes = contents.get(key);
      return Effect.succeed(
        bytes
          ? { bytes, contentType: objects.get(key)?.contentType ?? null }
          : null,
      );
    },
  });
  return { layer, state };
}

export const FAKE_ZOHO_API_DOMAIN = "https://www.zohoapis.eu";
export const FAKE_ZOHO_ACCOUNTS_SERVER = "https://accounts.zoho.eu";
export const FAKE_ZOHO_CONNECT_ORIGIN = "https://api.expendi.test";

export const FAKE_ZOHO_ORGANIZATIONS: readonly ZohoBooksOrganization[] = [
  { id: "60001", name: "Acme Kenya Ltd", currencyCode: "KES" },
  { id: "60002", name: "Acme Holdings Inc", currencyCode: "USD" },
];

export const FAKE_ZOHO_ACCOUNTS: readonly ZohoBooksAccount[] = [
  { id: "acc-travel", name: "Travel Expense", code: "6100", type: "expense" },
  {
    id: "acc-meals",
    name: "Meals and Entertainment",
    code: null,
    type: "expense",
  },
  { id: "acc-fees", name: "Bank Fees", code: null, type: "other_expense" },
  {
    id: "acc-cogs",
    name: "Cost of Goods Sold",
    code: null,
    type: "cost_of_goods_sold",
  },
  { id: "acc-wallet", name: "Expendi Wallet", code: null, type: "bank" },
  { id: "acc-petty", name: "Petty Cash", code: null, type: "cash" },
  { id: "acc-sales", name: "Sales", code: null, type: "income" },
  {
    id: "acc-payable",
    name: "Accounts Payable",
    code: null,
    type: "accounts_payable",
  },
];

type FakeZohoOperation =
  | "exchangeCode"
  | "refreshAccessToken"
  | "revokeToken"
  | "listOrganizations"
  | "listAccounts"
  | "findExpenses"
  | "createExpense"
  | "attachReceipt";

/**
 * In-memory Zoho: sign-in, tokens, Books reads and expenses. A code is good unless
 * it's in `refusedCodes`; a revoked refresh token is refused the way Zoho
 * refuses one (`INVALID_GRANT`), and an access token in `refusedAccessTokens`
 * gets Books' 401.
 */
export function makeFakeZoho() {
  let issued = 0;
  const failures = new Map<FakeZohoOperation, ZohoErrorCode>();
  const state = {
    organizations: [...FAKE_ZOHO_ORGANIZATIONS],
    accounts: [...FAKE_ZOHO_ACCOUNTS],
    /** Books expenses by Zoho organization, as Zoho would hold them. */
    expenses: [] as {
      id: string;
      organizationId: string;
      draft: ZohoExpenseDraft;
      receipt: {
        bytes: Uint8Array;
        contentType: string;
        fileName: string;
      } | null;
    }[],
    /** Every reference searched for, in order. */
    searches: [] as string[],
    /** The next create goes through at Zoho, but the reply never arrives. */
    loseNextCreateReply: false,
    /** The same, for the next receipt upload. */
    loseNextReceiptReply: false,
    /** The expense of every receipt upload that reached Zoho, in order. */
    receiptUploads: [] as string[],
    apiDomain: FAKE_ZOHO_API_DOMAIN,
    refusedCodes: new Set<string>(),
    revokedTokens: new Set<string>(),
    refusedAccessTokens: new Set<string>(),
    issuedRefreshTokens: [] as string[],
    issuedAccessTokens: [] as string[],
    exchanges: [] as { accountsServer: string; code: string }[],
    refreshes: [] as { accountsServer: string; refreshToken: string }[],
    failNext(operation: FakeZohoOperation, code: ZohoErrorCode) {
      failures.set(operation, code);
    },
    reset() {
      failures.clear();
      state.expenses.length = 0;
      state.searches.length = 0;
      state.loseNextCreateReply = false;
      state.loseNextReceiptReply = false;
      state.receiptUploads.length = 0;
      state.organizations = [...FAKE_ZOHO_ORGANIZATIONS];
      state.accounts = [...FAKE_ZOHO_ACCOUNTS];
      state.apiDomain = FAKE_ZOHO_API_DOMAIN;
      state.refusedCodes.clear();
      state.revokedTokens.clear();
      state.refusedAccessTokens.clear();
      state.issuedRefreshTokens.length = 0;
      state.issuedAccessTokens.length = 0;
      state.exchanges.length = 0;
      state.refreshes.length = 0;
    },
  };
  const injected = (operation: FakeZohoOperation) => {
    const code = failures.get(operation);
    if (code === undefined) return null;
    failures.delete(operation);
    return Effect.fail(
      new ZohoError({ code, message: `fake Zoho ${operation}: ${code}` }),
    );
  };
  const newAccessToken = () => {
    issued += 1;
    const accessToken = `1000.access.${issued}.${randomBytes(4).toString("hex")}`;
    state.issuedAccessTokens.push(accessToken);
    return {
      accessToken: Redacted.make(accessToken),
      apiDomain: state.apiDomain,
      expiresInSeconds: 3600,
    };
  };
  const booksAccess = (
    accessToken: Redacted.Redacted,
  ): Effect.Effect<void, ZohoError> =>
    state.refusedAccessTokens.has(Redacted.value(accessToken))
      ? Effect.fail(
          new ZohoError({
            code: "UNAUTHORIZED",
            message: "fake Zoho Books: HTTP 401",
          }),
        )
      : Effect.void;

  const layer = Layer.succeed(Zoho, {
    configured: true,
    findExpenses: ({ accessToken }, organizationId, referenceNumber) =>
      booksAccess(accessToken).pipe(
        Effect.flatMap(() => {
          state.searches.push(referenceNumber);
          return (
            injected("findExpenses") ??
            Effect.succeed(
              state.expenses
                .filter(
                  (expense) =>
                    expense.organizationId === organizationId &&
                    expense.draft.referenceNumber === referenceNumber,
                )
                .map((expense) => ({
                  id: expense.id,
                  referenceNumber: expense.draft.referenceNumber,
                  hasReceipt: expense.receipt !== null,
                })),
            )
          );
        }),
      ),
    createExpense: ({ accessToken }, organizationId, draft) =>
      booksAccess(accessToken).pipe(
        Effect.flatMap(() => {
          const failure = injected("createExpense");
          if (failure) return failure;
          issued += 1;
          const id = `46000000${issued}`;
          state.expenses.push({ id, organizationId, draft, receipt: null });
          if (state.loseNextCreateReply) {
            state.loseNextCreateReply = false;
            return Effect.fail(
              new ZohoError({
                code: "NETWORK_ERROR",
                message: "Zoho create expense unreachable",
              }),
            );
          }
          return Effect.succeed({
            id,
            referenceNumber: draft.referenceNumber,
            hasReceipt: false,
          });
        }),
      ),
    attachReceipt: ({ accessToken }, organizationId, expenseId, file) =>
      booksAccess(accessToken).pipe(
        Effect.flatMap(() => {
          const failure = injected("attachReceipt");
          if (failure) return failure;
          const expense = state.expenses.find(
            (row) =>
              row.id === expenseId && row.organizationId === organizationId,
          );
          if (!expense) {
            return Effect.fail(
              new ZohoError({
                code: "API_ERROR",
                message: "Zoho attach receipt: HTTP 404",
              }),
            );
          }
          expense.receipt = { ...file };
          state.receiptUploads.push(expenseId);
          if (state.loseNextReceiptReply) {
            state.loseNextReceiptReply = false;
            return Effect.fail(
              new ZohoError({
                code: "NETWORK_ERROR",
                message: "Zoho attach receipt unreachable",
              }),
            );
          }
          return Effect.void;
        }),
      ),
    authorizeUrl: (oauthState) =>
      Effect.succeed(
        `https://accounts.zoho.com/oauth/v2/auth?state=${encodeURIComponent(oauthState)}`,
      ),
    connectLinkUrl: (token) =>
      Effect.succeed(
        `${FAKE_ZOHO_CONNECT_ORIGIN}/integrations/zoho/connect?token=${token}`,
      ),
    exchangeCode: ({ accountsServer, code }) =>
      injected("exchangeCode") ??
      Effect.suspend(() => {
        state.exchanges.push({ accountsServer, code });
        if (state.refusedCodes.has(code)) {
          return Effect.fail(
            new ZohoError({
              code: "INVALID_GRANT",
              message: "fake Zoho token exchange: invalid_code",
            }),
          );
        }
        const refreshToken = `1000.refresh.${randomBytes(8).toString("hex")}`;
        state.issuedRefreshTokens.push(refreshToken);
        return Effect.succeed({
          ...newAccessToken(),
          refreshToken: Redacted.make(refreshToken),
        });
      }),
    refreshAccessToken: ({ accountsServer, refreshToken }) =>
      injected("refreshAccessToken") ??
      Effect.suspend(() => {
        const raw = Redacted.value(refreshToken);
        state.refreshes.push({ accountsServer, refreshToken: raw });
        return state.revokedTokens.has(raw)
          ? Effect.fail(
              new ZohoError({
                code: "INVALID_GRANT",
                message: "fake Zoho token refresh: invalid_code",
              }),
            )
          : Effect.succeed(newAccessToken());
      }),
    revokeToken: ({ token }) =>
      injected("revokeToken") ??
      Effect.sync(() => {
        state.revokedTokens.add(Redacted.value(token));
      }),
    listOrganizations: ({ accessToken }) =>
      injected("listOrganizations") ??
      booksAccess(accessToken).pipe(Effect.map(() => [...state.organizations])),
    listAccounts: ({ accessToken }) =>
      injected("listAccounts") ??
      booksAccess(accessToken).pipe(Effect.map(() => [...state.accounts])),
  });
  return { layer, state };
}
