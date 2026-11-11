import type { ConfigError } from "effect";
import type { Action } from "near-api-js";
import { Config, Context, Effect, Layer } from "effect";
import { actions, PublicKey } from "near-api-js";
import { z } from "zod";

export const NEAR_NETWORKS = ["mainnet", "testnet"] as const;
export type NearNetwork = (typeof NEAR_NETWORKS)[number];

/**
 * The USDC contract on each NEAR network, as `near-api-js/tokens` lists
 * them. Constants rather than config, so a misconfigured environment can
 * never credit or send a different token: config only picks the network.
 */
export const USDC_NEAR_CONTRACT_IDS: Readonly<Record<NearNetwork, string>> = {
  mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  testnet: "usdc.fakes.testnet",
};

export interface NearChainShape {
  readonly network: NearNetwork;
  readonly usdcContractId: string;
}

/** Which NEAR network the API is on, and the USDC contract that goes with it. */
export class NearChain extends Context.Tag("NearChain")<
  NearChain,
  NearChainShape
>() {}

export const makeNearChain = (network: NearNetwork): NearChainShape => ({
  network,
  usdcContractId: USDC_NEAR_CONTRACT_IDS[network],
});

export const NearChainLive: Layer.Layer<NearChain, ConfigError.ConfigError> =
  Layer.effect(
    NearChain,
    Effect.map(
      Config.withDefault(
        Config.literal(...NEAR_NETWORKS)("NEAR_NETWORK"),
        "mainnet",
      ),
      makeNearChain,
    ),
  );

/** What the USDC contract charges, once, to hold a balance for an account. */
export const USDC_STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n;

/** NEP-141 makes every transfer attach exactly this, so only a full-access key can move tokens. */
const ONE_YOCTO = 1n;

const TGAS = 1_000_000_000_000n;
const FT_TRANSFER_GAS = 30n * TGAS;
/** Covers the receiver's `ft_on_transfer` and the contract's own resolve step. */
const FT_TRANSFER_CALL_GAS = 100n * TGAS;
const STORAGE_DEPOSIT_GAS = 30n * TGAS;

const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;
const NAMED_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const ACCOUNT_ID_MIN_LENGTH = 2;
const ACCOUNT_ID_MAX_LENGTH = 64;

/** A 64-hex implicit account: its ID is its own ed25519 public key. */
export const isImplicitNearAccount = (accountId: string): boolean =>
  IMPLICIT_ACCOUNT.test(accountId);

/** The key type byte NEAR gives ed25519, in public keys and signatures alike. */
export const NEAR_ED25519 = 0;

/** The one key that controls an implicit account, read from its ID. */
export function implicitAccountPublicKey(accountId: string): PublicKey {
  if (!isImplicitNearAccount(accountId)) {
    throw new RangeError(`Not an implicit NEAR account: ${accountId}`);
  }
  return new PublicKey({
    keyType: NEAR_ED25519,
    data: Uint8Array.from(Buffer.from(accountId, "hex")),
  });
}

/**
 * `raw` as a NEAR account ID, or `null` if it isn't one: a 64-hex implicit
 * account, or a named account of 2 to 64 lowercase characters. Account IDs
 * have no uppercase form, so one is refused rather than guessed at.
 */
export function normaliseNearAccountId(raw: string): string | null {
  const accountId = raw.trim();
  if (
    accountId.length < ACCOUNT_ID_MIN_LENGTH ||
    accountId.length > ACCOUNT_ID_MAX_LENGTH
  ) {
    return null;
  }
  return NAMED_ACCOUNT.test(accountId) ? accountId : null;
}

const U128_LIMIT = 2n ** 128n;

function checkedTransfer(
  to: string,
  amount: bigint,
): { readonly receiver_id: string; readonly amount: string } {
  if (normaliseNearAccountId(to) !== to) {
    throw new RangeError(`Not a NEAR account ID: ${to}`);
  }
  if (amount <= 0n || amount >= U128_LIMIT) {
    throw new RangeError("Transfer amount out of range");
  }
  return { receiver_id: to, amount: amount.toString() };
}

/** USDC `ft_transfer(receiver_id, amount)`, to be sent to the USDC contract. */
export function usdcTransferAction(to: string, amount: bigint): Action {
  return actions.functionCall(
    "ft_transfer",
    checkedTransfer(to, amount),
    FT_TRANSFER_GAS,
    ONE_YOCTO,
  );
}

/**
 * USDC `ft_transfer_call(receiver_id, amount, msg)`: a transfer that also
 * tells the receiving contract what it is for. The contract returns whatever
 * the receiver doesn't use, so the amount that stays moved is the call's
 * result, not its argument.
 */
export function usdcTransferCallAction(
  to: string,
  amount: bigint,
  msg: string,
): Action {
  return actions.functionCall(
    "ft_transfer_call",
    { ...checkedTransfer(to, amount), msg },
    FT_TRANSFER_CALL_GAS,
    ONE_YOCTO,
  );
}

/** Registers `accountId` with the USDC contract, paid by whoever sends it. */
export function usdcStorageDepositAction(accountId: string): Action {
  if (normaliseNearAccountId(accountId) !== accountId) {
    throw new RangeError(`Not a NEAR account ID: ${accountId}`);
  }
  return actions.functionCall(
    "storage_deposit",
    { account_id: accountId, registration_only: true },
    STORAGE_DEPOSIT_GAS,
    USDC_STORAGE_DEPOSIT_YOCTO,
  );
}

export interface NearReceiptOutcome {
  readonly receiptId: string;
  /** The account the receipt ran on: the contract, for a function call. */
  readonly executorId: string;
  readonly logs: readonly string[];
  readonly succeeded: boolean;
}

/** A NEAR transaction once it and every receipt it caused are final. */
export interface NearTransactionOutcome {
  /** Base58 and case-sensitive: never lowercase it. */
  readonly txHash: string;
  readonly signerId: string;
  readonly receiverId: string;
  /** The block that included the transaction. */
  readonly blockHeight: bigint;
  /** Whether the transaction's own chain of receipts ended in success. */
  readonly succeeded: boolean;
  /** What that chain returned, base64; null when it failed. */
  readonly successValue: string | null;
  /**
   * The receipt the transaction itself became, on its receiver's account.
   * For a relayed delegate action, this is the one that checks and runs it.
   */
  readonly ownReceiptId: string;
  /** Every receipt the transaction caused, in the order the RPC reports them. */
  readonly receipts: readonly NearReceiptOutcome[];
}

export interface NearUsdcTransfer {
  readonly from: string;
  readonly to: string;
  /** USDC base units (6 decimals). */
  readonly amount: bigint;
  /**
   * Where the transfer sits in its transaction: the log's position among all
   * the transaction's logs, times `LOG_INDEX_STRIDE`, plus the transfer's
   * position in that log's event. It depends only on the outcome, never on
   * which logs this parser accepts, so it can't shift between releases.
   */
  readonly logIndex: number;
  readonly blockHeight: bigint;
  readonly txHash: string;
}

/**
 * More transfers than one event can carry: NEAR caps a log at 16 KB, and a
 * transfer entry takes well over 16 bytes of it.
 */
export const LOG_INDEX_STRIDE = 1000;

const EVENT_PREFIX = "EVENT_JSON:";

const ftTransferEventSchema = z.object({
  standard: z.literal("nep141"),
  event: z.literal("ft_transfer"),
  data: z.array(z.unknown()).max(LOG_INDEX_STRIDE),
});

const ftTransferEntrySchema = z.object({
  old_owner_id: z.string(),
  new_owner_id: z.string(),
  amount: z.string().regex(/^\d{1,39}$/),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The entries of a NEP-297 `ft_transfer` event log, or none if it isn't one. */
function ftTransferEntries(log: string): readonly unknown[] {
  if (!log.startsWith(EVENT_PREFIX)) return [];
  const event = ftTransferEventSchema.safeParse(
    parseJson(log.slice(EVENT_PREFIX.length)),
  );
  return event.success ? event.data.data : [];
}

/**
 * The USDC transfers a finished NEAR transaction made, read from its
 * NEP-297 event logs. Only logs the USDC contract itself emitted in a receipt
 * that succeeded count: any contract can log the same JSON, and a failed
 * receipt's logs describe changes that were rolled back. Nothing else can be
 * mistaken for USDC.
 */
export function nearUsdcTransfersIn(
  outcome: NearTransactionOutcome,
  usdcContractId: string,
): NearUsdcTransfer[] {
  const transfers: NearUsdcTransfer[] = [];
  let logPosition = 0;
  for (const receipt of outcome.receipts) {
    for (const log of receipt.logs) {
      const position = logPosition;
      logPosition += 1;
      if (!receipt.succeeded || receipt.executorId !== usdcContractId) continue;
      ftTransferEntries(log).forEach((rawEntry, entryIndex) => {
        const entry = ftTransferEntrySchema.safeParse(rawEntry);
        if (!entry.success) return;
        const from = entry.data.old_owner_id;
        const to = entry.data.new_owner_id;
        const amount = BigInt(entry.data.amount);
        if (
          normaliseNearAccountId(from) !== from ||
          normaliseNearAccountId(to) !== to ||
          amount <= 0n ||
          amount >= U128_LIMIT
        ) {
          return;
        }
        transfers.push({
          from,
          to,
          amount,
          logIndex: position * LOG_INDEX_STRIDE + entryIndex,
          blockHeight: outcome.blockHeight,
          txHash: outcome.txHash,
        });
      });
    }
  }
  return transfers;
}

/** A USDC transfer named the way the ledger names it (`wallet_transactions`). */
export interface NearUsdcReceiptTransfer {
  readonly from: string;
  readonly to: string;
  /** USDC base units (6 decimals). */
  readonly amount: bigint;
  /** The receipt whose logs carry the transfer. Base58. */
  readonly receiptId: string;
  /** The log's position among that receipt's own logs. */
  readonly receiptLogIndex: number;
  /** The transfer's position in the log's event. */
  readonly transferIndex: number;
  /** The block that included the transaction, not the one the receipt ran in. */
  readonly blockHeight: bigint;
  readonly txHash: string;
}

/**
 * The same transfers as `nearUsdcTransfersIn`, each placed by its receipt,
 * the log's position in that receipt and its position in the event. Unlike a
 * position in the whole transaction, that is the same whoever reports the
 * transfer: an indexer that never saw the other receipts names it alike.
 */
export function nearUsdcReceiptTransfersIn(
  outcome: NearTransactionOutcome,
  usdcContractId: string,
): NearUsdcReceiptTransfer[] {
  return outcome.receipts.flatMap((receipt) => {
    if (!receipt.succeeded || receipt.executorId !== usdcContractId) return [];
    return receipt.logs.flatMap((log, receiptLogIndex) =>
      ftTransferEntries(log).flatMap((rawEntry, transferIndex) => {
        const entry = ftTransferEntrySchema.safeParse(rawEntry);
        if (!entry.success) return [];
        const from = entry.data.old_owner_id;
        const to = entry.data.new_owner_id;
        const amount = BigInt(entry.data.amount);
        if (
          normaliseNearAccountId(from) !== from ||
          normaliseNearAccountId(to) !== to ||
          amount <= 0n ||
          amount >= U128_LIMIT
        ) {
          return [];
        }
        return [
          {
            from,
            to,
            amount,
            receiptId: receipt.receiptId,
            receiptLogIndex,
            transferIndex,
            blockHeight: outcome.blockHeight,
            txHash: outcome.txHash,
          },
        ];
      }),
    );
  });
}
