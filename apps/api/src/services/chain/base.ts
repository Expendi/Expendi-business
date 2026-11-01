export const BASE_CHAIN_ID = 8453;

/**
 * Native USDC on Base, from Circle's list:
 * https://developers.circle.com/stablecoins/usdc-contract-addresses
 * A constant rather than config, so a misconfigured environment can never
 * credit or send a different token.
 */
export const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ReceiptLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly logIndex: string;
  readonly removed?: boolean;
}

export interface TransactionReceipt {
  readonly transactionHash: string;
  /** "0x1" for success, "0x0" for a reverted transaction. */
  readonly status: string;
  readonly blockNumber: string;
  readonly logs: readonly ReceiptLog[];
}

export interface UsdcTransfer {
  /** Lowercased. */
  readonly from: string;
  /** Lowercased. */
  readonly to: string;
  /** USDC base units (6 decimals). */
  readonly amount: bigint;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly txHash: string;
}

const HEX_WORD = /^0x[0-9a-fA-F]{64}$/;

const addressFromTopic = (topic: string): string =>
  `0x${topic.slice(-40)}`.toLowerCase();

/**
 * The USDC transfers a successful Base transaction made, read from its
 * receipt. Logs from any other contract, other events, and reverted
 * transactions yield nothing, so nothing else can be mistaken for USDC.
 */
export function usdcTransfersIn(receipt: TransactionReceipt): UsdcTransfer[] {
  if (receipt.status !== "0x1") return [];
  const usdc = USDC_BASE_ADDRESS.toLowerCase();
  const blockNumber = BigInt(receipt.blockNumber);
  return receipt.logs.flatMap((log) => {
    const [topic, fromTopic, toTopic] = log.topics;
    if (
      log.removed === true ||
      log.address.toLowerCase() !== usdc ||
      log.topics.length !== 3 ||
      topic?.toLowerCase() !== ERC20_TRANSFER_TOPIC ||
      !fromTopic ||
      !toTopic ||
      !HEX_WORD.test(log.data)
    ) {
      return [];
    }
    return [
      {
        from: addressFromTopic(fromTopic),
        to: addressFromTopic(toTopic),
        amount: BigInt(log.data),
        logIndex: Number(BigInt(log.logIndex)),
        blockNumber,
        txHash: receipt.transactionHash.toLowerCase(),
      },
    ];
  });
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRANSFER_SELECTOR = "0xa9059cbb";

/** Calldata for USDC `transfer(to, amount)`. */
export function usdcTransferCalldata(to: string, amount: bigint): string {
  if (!ADDRESS.test(to)) throw new RangeError(`Not an address: ${to}`);
  if (amount <= 0n || amount >= 2n ** 256n) {
    throw new RangeError("Transfer amount out of range");
  }
  return `${TRANSFER_SELECTOR}${to.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}
